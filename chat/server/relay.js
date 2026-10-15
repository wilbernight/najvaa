'use strict';
// Blind relay for the two-person E2EE room. It never sees keys or plaintext:
// it pairs at most two sockets per room id and forwards opaque frames between
// them. Nothing is stored or logged.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ORIGIN = process.env.ORIGIN || 'https://localhost';
// Every site name the app is served under (comma separated).
const ORIGINS = new Set((process.env.ORIGINS || ORIGIN).split(',').map((o) => o.trim()).filter(Boolean));
const okOrigin = (o) => ORIGINS.has(o);
const STUN_URLS = (process.env.STUN_URLS || '').split(',').filter(Boolean);
const TURN_URLS = (process.env.TURN_URLS || '').split(',').filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL = 6 * 3600;
const MAX_ROOMS = 2000;
const MAX_MSG_PER_10S = 3000; // file transfers send 128 KB encrypted chunks

const rooms = new Map(); // roomId -> Set<ws>

// Cloudflare Realtime TURN keeps the origin's address out of every ICE config
// (the site stays behind the Cloudflare proxy) and works on networks that
// only allow 443. Media is end-to-end encrypted, so the relay sees ciphertext.
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || '';
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN || '';
let cfIce = { servers: null, expires: 0 };

async function cloudflareIce() {
  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) return [];
  if (cfIce.servers && Date.now() < cfIce.expires) return cfIce.servers;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`cloudflare turn ${r.status}`);
    const j = await r.json();
    const servers = (Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers])
      .filter(Boolean)
      .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) })) // browsers block port 53
      .filter((s) => s.urls.length);
    cfIce = { servers, expires: Date.now() + (TURN_TTL - 3600) * 1000 };
    return servers;
  } catch (err) {
    console.error(err.message);
    return cfIce.servers || [];
  }
}

async function iceServers() {
  const list = [];
  if (STUN_URLS.length) list.push({ urls: STUN_URLS });
  if (TURN_URLS.length && TURN_SECRET) {
    // coturn "use-auth-secret" REST credentials, valid for TURN_TTL seconds.
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${crypto.randomBytes(6).toString('hex')}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    list.push({ urls: TURN_URLS, username, credential });
  }
  const cf = await cloudflareIce();
  return cf.length ? cf : list;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- Instagram link previews ----------
// The sender's browser asks for a preview; the image is then sent to the peer
// inside the encrypted channel, so the recipient never contacts Instagram.
// Only Instagram post URLs are fetched (no open proxy / SSRF), nothing is
// cached or logged.
const PAGE_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'instagr.am', 'www.instagr.am']);
const IMG_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const IG_PATH_RE = /^\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})/;
const SHARE_PATH_RE = /^\/share\/(?:p|reel|reels|v)?\/?[A-Za-z0-9_-]{5,64}/;
const UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
let previewBudget = 240;
setInterval(() => { previewBudget = 240; }, 60000);
// The same post is often asked for twice (the other device, or a retry): keep
// the built preview for a few minutes, so a repeat costs neither a budget unit
// nor another fetch. In memory only, never on disk.
const previewCache = new Map(); // url -> { at, result }
const PREVIEW_TTL = 10 * 60 * 1000;

async function fetchLimited(start, allowHost, maxBytes, accept, truncate, ua = UA) {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' || !allowHost(url.hostname)) throw new Error('host');
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': ua, Accept: accept, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(8000),
    });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url); continue; }
    if (!r.ok) throw new Error('status');
    const reader = r.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) {
        reader.cancel().catch(() => {});
        if (!truncate) throw new Error('too big');
        break;
      }
      parts.push(value);
    }
    return { url, type: r.headers.get('content-type') || '', body: Buffer.concat(parts) };
  }
  throw new Error('redirects');
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function metaTags(html) {
  const out = {};
  const re = /<meta\s+[^>]*?>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = /(?:property|name)="([^"]+)"/i.exec(tag);
    const val = /content="([^"]*)"/i.exec(tag);
    if (key && val && !(key[1] in out)) out[key[1]] = decodeEntities(val[1]);
  }
  return out;
}

async function buildPreview(raw) {
  const start = new URL(raw);
  if (!PAGE_HOSTS.has(start.hostname) || !(IG_PATH_RE.test(start.pathname) || SHARE_PATH_RE.test(start.pathname))) throw new Error('not instagram');
  const page = await fetchLimited(new URL(start.origin + start.pathname), (h) => PAGE_HOSTS.has(h), 1500000, 'text/html', true);
  const path = IG_PATH_RE.exec(page.url.pathname);
  if (!path) throw new Error('no post');
  const kind = path[1] === 'reels' ? 'reel' : path[1];
  const tags = metaTags(page.body.toString('utf8'));
  const result = {
    url: `https://www.instagram.com/${kind}/${path[2]}/`,
    kind,
    title: (tags['og:title'] || tags['twitter:title'] || '').slice(0, 300),
    image: null,
  };
  const img = tags['og:image'] || tags['twitter:image'];
  if (img) {
    try {
      const pic = await fetchLimited(new URL(img), (h) => IMG_HOST_RE.test(h), 3000000, 'image/*', false);
      const type = pic.type.split(';')[0].trim();
      if (/^image\/(jpeg|png|webp)$/.test(type)) result.image = `data:${type};base64,${pic.body.toString('base64')}`;
    } catch {}
  }
  return result;
}

function handlePreview(req, res) {
  const reply = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  if (!okOrigin(req.headers.origin)) return reply(403, {});
  if (!feature('preview')) return reply(503, { error: 'disabled' });
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', async () => {
    try {
      const { u } = JSON.parse(body);
      if (typeof u !== 'string' || u.length > 500) throw new Error('bad');
      const hit = previewCache.get(u);
      if (hit && Date.now() - hit.at < PREVIEW_TTL) return reply(200, hit.result);
      if (--previewBudget < 0) return reply(429, {});
      const result = await buildPreview(u);
      previewCache.set(u, { at: Date.now(), result });
      if (previewCache.size > 300) previewCache.delete(previewCache.keys().next().value);
      reply(200, result);
    } catch {
      reply(422, {});
    }
  });
}

// ---------- GIFs (Giphy + Tenor, no API keys) ----------
// The server reads the public search pages and serves the GIF files itself,
// so neither service ever sees the users' devices. Clients can only name a
// provider and a GIF id; the media URL is built here (no open proxy). Only
// tiny renditions exist on this path: unreadable from beside you or through
// another phone's zoom. The chosen GIF then goes to the peer end-to-end
// encrypted like any file.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const GIF_ID = { g: /^[A-Za-z0-9]{6,40}$/, t: /^[A-Za-z0-9_-]{11}$/ };
const GIF_MEDIA = {
  g: { t: (id) => `https://media.giphy.com/media/${id}/100w_s.gif`, s: (id) => `https://media.giphy.com/media/${id}/100w.webp` },
  t: { t: (id) => `https://media.tenor.com/${id}AAAAN/x.png`, s: (id) => `https://media.tenor.com/${id}AAAAS/x.gif` },
};
const GIF_HOSTS = { g: /^media[0-9]?\.giphy\.com$/, t: /^media[0-9]?\.tenor\.com$/ };
const gifCache = new Map(); // query -> { at, items }, in memory only
let gifBudget = 900;
setInterval(() => { gifBudget = 900; }, 3600000);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > limit) { req.destroy(); reject(new Error('big')); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function scrapeIds(url, re, idRe) {
  try {
    const host = new URL(url).hostname;
    const page = await fetchLimited(new URL(url), (h) => h === host, 2500000, 'text/html', true, BROWSER_UA);
    const html = page.body.toString('utf8');
    const ids = [];
    for (const m of html.matchAll(re)) if (idRe.test(m[1]) && !ids.includes(m[1])) ids.push(m[1]);
    return ids;
  } catch {
    return [];
  }
}

async function findGifs(q) {
  const slug = encodeURIComponent(q.toLowerCase().replace(/\s+/g, '-'));
  const [g, t] = await Promise.all([
    scrapeIds(`https://giphy.com/search/${slug}`, /media\/(?:v1\.[^/"\\]+\/)?([A-Za-z0-9]{12,40})\/(?:giphy|200w|100w|200|100)\b/g, GIF_ID.g),
    scrapeIds(`https://tenor.com/search/${slug}-gifs`, /media[0-9]?\.tenor\.com\/(?:m\/)?([A-Za-z0-9_-]{11})AAAA[A-Za-z0-9]\//g, GIF_ID.t),
  ]);
  const items = [];
  for (let i = 0; items.length < 36 && (i < g.length || i < t.length); i++) {
    if (i < t.length && i < 18) items.push({ p: 't', id: t[i] });
    if (i < g.length && i < 18) items.push({ p: 'g', id: g[i] });
  }
  return items.map((it) => ({ thumb: `/gif/m?p=${it.p}&r=t&id=${it.id}`, send: `/gif/m?p=${it.p}&r=s&id=${it.id}` }));
}

async function handleGifSearch(req, res) {
  if (!okOrigin(req.headers.origin)) return json(res, 403, {});
  if (!feature('gif')) return json(res, 503, { error: 'disabled' });
  try {
    const { q } = JSON.parse(await readBody(req, 1024));
    if (typeof q !== 'string' || !q.trim() || q.length > 50) return json(res, 400, {});
    const key = q.trim().toLowerCase();
    const hit = gifCache.get(key);
    if (hit && Date.now() - hit.at < 600000) return json(res, 200, { items: hit.items });
    if (--gifBudget < 0) return json(res, 429, {});
    const items = await findGifs(key);
    gifCache.set(key, { at: Date.now(), items });
    if (gifCache.size > 200) gifCache.delete(gifCache.keys().next().value);
    json(res, 200, { items });
  } catch {
    json(res, 422, {});
  }
}

async function handleGifMedia(req, res) {
  if (!feature('gif')) { res.writeHead(503); return res.end(); }
  // Only same-origin <img>/fetch may use this.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') { res.writeHead(403); return res.end(); }
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    const prov = q.get('p');
    const kind = q.get('r');
    const id = q.get('id') || '';
    if (!GIF_MEDIA[prov] || !GIF_MEDIA[prov][kind] || !GIF_ID[prov].test(id)) throw new Error('bad');
    const pic = await fetchLimited(new URL(GIF_MEDIA[prov][kind](id)), (h) => GIF_HOSTS[prov].test(h), 1500000, 'image/*', false, BROWSER_UA);
    const type = pic.type.split(';')[0].trim();
    if (!/^image\/(webp|gif|png)$/.test(type)) throw new Error('type');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': pic.body.length });
    res.end(pic.body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

// ---------- encrypted history storage ----------
// Rooms keep their content on this server, but only as ciphertext: devices
// encrypt every entry with a key derived from the room code + password before
// uploading. Access needs a token derived from the same password (its hash is
// registered on first use). The server sees sizes and times, never content.
// Entries older than STORE_MAX_DAYS are deleted, and when the store grows
// past STORE_CAP_GB the oldest entries go first.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const STORE = process.env.STORE_DIR || '/var/lib/najva';
const ROOMS_DIR = path.join(STORE, 'rooms');
let CAP_BYTES = Number(process.env.STORE_CAP_GB || 50) * 1024 ** 3; // overridden by admin settings
let MAX_AGE_MS = Number(process.env.STORE_MAX_DAYS || 90) * 86400000;
const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const EID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const ENTRY_RE = /^(\d{13})-([A-Za-z0-9_-]{8,32})-(\d{1,13})-([01])\.json$/;
const MAX_ENTRY = 900 * 1024;
const MAX_CHUNK = 300 * 1024;
const MAX_CHUNKS = 2000;
// A room with nothing stored in it is only a reservation: forget it after this
// long, so empty rooms cannot pile up (or squat a code) for months.
const EMPTY_ROOM_MS = Number(process.env.STORE_EMPTY_ROOM_HOURS || 24) * 3600000;
// Hard ceiling on how many room directories may exist; beyond it new rooms are
// refused, so the store cannot be filled up with reservations.
const MAX_STORE_ROOMS = Number(process.env.STORE_MAX_ROOMS || 20000);
let storeTotal = 0;
let storeBudget = 6000;
setInterval(() => { storeBudget = 6000; }, 60000);
fs.mkdirSync(ROOMS_DIR, { recursive: true });

const pad13 = (n) => String(n).padStart(13, '0');
const entryName = (e) => `${pad13(e.ts)}-${e.id}-${e.exp || 0}-${e.blob ? 1 : 0}.json`;
function parseEntry(name) {
  const m = ENTRY_RE.exec(name);
  return m ? { name, ts: Number(m[1]), id: m[2], exp: Number(m[3]), blob: m[4] === '1' } : null;
}

async function readBodyBuf(req, limit) {
  const parts = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('too big');
    parts.push(c);
  }
  return Buffer.concat(parts);
}

// Resolves to the room directory when the token matches. Only a complete,
// valid entry may register a new room (first writer's token wins); reads of an
// unknown room resolve to { empty: true } without creating anything, and a
// token that is not the registered one comes back as { claimed: true }.
async function storeAuth(req, mayCreate) {
  const room = req.headers['x-room'] || '';
  const token = req.headers['x-room-auth'] || '';
  if (!ROOM_RE.test(room) || !TOKEN_RE.test(token)) return null;
  const hash = crypto.createHash('sha256').update(token).digest();
  const dir = path.join(ROOMS_DIR, room);
  const authFile = path.join(dir, 'auth');
  let saved = await fsp.readFile(authFile).catch(() => null);
  if (!saved && !mayCreate) return { empty: true };
  if (!saved) {
    // Only a genuinely new room counts against the cap: a room whose
    // registration was reset must always be able to register again.
    const known = await fsp.stat(dir).then(() => true).catch(() => false);
    if (!known) {
      const roomsNow = await fsp.readdir(ROOMS_DIR).catch(() => []);
      if (roomsNow.length >= MAX_STORE_ROOMS) return { full: true };
    }
    await fsp.mkdir(path.join(dir, 'log'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'blob'), { recursive: true });
    await fsp.writeFile(authFile, hash, { flag: 'wx' }).catch(() => {});
    saved = await fsp.readFile(authFile).catch(() => null);
  }
  if (!saved || saved.length !== hash.length || !crypto.timingSafeEqual(saved, hash)) return { claimed: true };
  return { dir };
}

async function listEntries(dir) {
  const names = await fsp.readdir(path.join(dir, 'log')).catch(() => []);
  return names.map(parseEntry).filter(Boolean);
}

async function dirSize(p) {
  let total = 0;
  for (const n of await fsp.readdir(p).catch(() => [])) {
    const st = await fsp.stat(path.join(p, n)).catch(() => null);
    if (st) total += st.isDirectory() ? await dirSize(path.join(p, n)) : st.size;
  }
  return total;
}

async function dropEntry(dir, e) {
  await fsp.rm(path.join(dir, 'log', e.name), { force: true });
  if (e.blob) await fsp.rm(path.join(dir, 'blob', e.id), { recursive: true, force: true });
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

async function handleStore(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'GET' && !okOrigin(req.headers.origin)) return json(res, 403, {});
  if (--storeBudget < 0) return json(res, 429, {});
  const parts = url.pathname.split('/').filter(Boolean); // ['h', ...]
  try {
    // Only a real, well-formed write may open a room directory: a malformed
    // body, or an empty reservation, must not leave a directory behind
    // (otherwise anyone could fill the disk with empty rooms).
    let entry = null;
    let chunk = null;
    const isLog = req.method === 'POST' && parts[1] === 'log';
    const isBlob = req.method === 'PUT' && parts[1] === 'blob' && EID_RE.test(parts[2] || '') && /^\d{1,4}$/.test(parts[3] || '') && Number(parts[3]) < MAX_CHUNKS;
    if (isLog) {
      entry = JSON.parse((await readBodyBuf(req, MAX_ENTRY)).toString('utf8'));
      if (!EID_RE.test(entry.id) || typeof entry.iv !== 'string' || typeof entry.ct !== 'string' || entry.iv.length > 32) return json(res, 400, {});
    } else if (isBlob) {
      chunk = await readBodyBuf(req, MAX_CHUNK);
      if (!chunk.length) return json(res, 400, {});
    }
    const auth = await storeAuth(req, isLog || isBlob);
    if (!auth) return json(res, 403, { error: 'auth' });
    if (auth.full) return json(res, 507, { error: 'full' });
    if (auth.claimed) return json(res, 403, { error: 'auth', claimed: 1 });
    if (auth.empty) {
      if (parts[1] === 'log') return json(res, 200, { items: [], more: false });
      if (parts[1] === 'usage') return json(res, 200, { roomBytes: 0, roomItems: 0, totalBytes: storeTotal, capBytes: CAP_BYTES, maxDays: MAX_AGE_MS / 86400000 });
      if (req.method === 'POST') return json(res, 200, {});
      return json(res, 404, {});
    }
    const { dir } = auth;
    // POST /h/log  {id, iv, ct, blob, exp}
    if (entry) {
      const existing = (await listEntries(dir)).find((e) => e.id === entry.id);
      if (existing) return json(res, 200, { ts: existing.ts });
      const e = { ts: Date.now(), id: entry.id, exp: Number.isInteger(entry.exp) && entry.exp > 0 ? entry.exp : 0, blob: !!entry.blob };
      const data = JSON.stringify({ iv: entry.iv, ct: entry.ct });
      await writeAtomic(path.join(dir, 'log', entryName(e)), data);
      storeTotal += data.length;
      if (storeTotal > CAP_BYTES) setImmediate(janitor);
      return json(res, 200, { ts: e.ts });
    }
    // GET /h/log?before=&limit=
    if (req.method === 'GET' && parts[1] === 'log') {
      const before = Number(url.searchParams.get('before')) || Infinity;
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const after = Number(url.searchParams.get('after')) || 0;
      const now = Date.now();
      const list = (await listEntries(dir)).filter((e) => e.ts < before && e.ts > after && !(e.exp && e.exp <= now)).sort((a, b) => b.ts - a.ts);
      // Read the page's files a few dozen at a time rather than one by one:
      // on a deep page that was most of the response time.
      const page = list.slice(0, limit);
      const raws = new Array(page.length);
      let next = 0;
      const worker = async () => { while (next < page.length) { const i = next++; raws[i] = await fsp.readFile(path.join(dir, 'log', page[i].name), 'utf8').catch(() => null); } };
      await Promise.all(Array.from({ length: Math.min(32, page.length) }, worker));
      const items = [];
      page.forEach((e, i) => {
        if (!raws[i]) return;
        try {
          const { iv, ct } = JSON.parse(raws[i]);
          items.push({ id: e.id, ts: e.ts, exp: e.exp, blob: e.blob, iv, ct });
        } catch {}
      });
      return json(res, 200, { items, more: list.length > limit });
    }
    // POST /h/exp {ids, exp}: schedule deletion (only ever moves earlier)
    if (req.method === 'POST' && parts[1] === 'exp') {
      const b = JSON.parse((await readBodyBuf(req, 64 * 1024)).toString('utf8'));
      const exp = Number(b.exp);
      if (!Array.isArray(b.ids) || !Number.isInteger(exp) || exp <= 0 || exp > Date.now() + 400 * 86400000) return json(res, 400, {});
      const want = new Set(b.ids.filter((x) => EID_RE.test(x)).slice(0, 500));
      for (const e of await listEntries(dir)) {
        if (!want.has(e.id) || (e.exp && e.exp <= exp)) continue;
        await fsp.rename(path.join(dir, 'log', e.name), path.join(dir, 'log', entryName({ ...e, exp }))).catch(() => {});
      }
      return json(res, 200, {});
    }
    // POST /h/del {ids}
    if (req.method === 'POST' && parts[1] === 'del') {
      const b = JSON.parse((await readBodyBuf(req, 64 * 1024)).toString('utf8'));
      if (!Array.isArray(b.ids)) return json(res, 400, {});
      const want = new Set(b.ids.filter((x) => EID_RE.test(x)).slice(0, 2000));
      for (const e of await listEntries(dir)) if (want.has(e.id)) await dropEntry(dir, e);
      for (const id of want) await fsp.rm(path.join(dir, 'blob', id), { recursive: true, force: true });
      return json(res, 200, {});
    }
    // POST /h/clear: delete everything in this room (keeps its registration)
    if (req.method === 'POST' && parts[1] === 'clear') {
      await fsp.rm(path.join(dir, 'log'), { recursive: true, force: true });
      await fsp.rm(path.join(dir, 'blob'), { recursive: true, force: true });
      await fsp.mkdir(path.join(dir, 'log'), { recursive: true });
      await fsp.mkdir(path.join(dir, 'blob'), { recursive: true });
      return json(res, 200, {});
    }
    // PUT|GET /h/blob/<id>/<chunk>
    if (parts[1] === 'blob' && EID_RE.test(parts[2] || '') && /^\d{1,4}$/.test(parts[3] || '') && Number(parts[3]) < MAX_CHUNKS) {
      const file = path.join(dir, 'blob', parts[2], parts[3]);
      if (req.method === 'PUT') {
        if (!chunk) return json(res, 400, {}); // already read and size-checked above
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await writeAtomic(file, chunk);
        storeTotal += chunk.length;
        if (storeTotal > CAP_BYTES) setImmediate(janitor);
        return json(res, 200, {});
      }
      if (req.method === 'GET') {
        const data = await fsp.readFile(file).catch(() => null);
        if (!data) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': data.length });
        return res.end(data);
      }
    }
    // GET /h/usage
    if (req.method === 'GET' && parts[1] === 'usage') {
      const entries = await listEntries(dir);
      return json(res, 200, { roomBytes: await dirSize(dir), roomItems: entries.length, totalBytes: storeTotal, capBytes: CAP_BYTES, maxDays: MAX_AGE_MS / 86400000 });
    }
    return json(res, 404, {});
  } catch {
    return json(res, 400, {});
  }
}

// Deletes expired and too-old entries, orphaned uploads, and the oldest
// entries overall while the store is above its cap.
let janitorRunning = false;
async function janitor() {
  if (janitorRunning) return;
  janitorRunning = true;
  lastJanitorAt = Date.now();
  try {
    const now = Date.now();
    const all = [];
    let total = 0;
    for (const room of await fsp.readdir(ROOMS_DIR).catch(() => [])) {
      if (!ROOM_RE.test(room)) continue;
      const dir = path.join(ROOMS_DIR, room);
      const liveBlobs = new Set();
      for (const e of await listEntries(dir)) {
        if ((e.exp && e.exp <= now) || e.ts < now - MAX_AGE_MS) { await dropEntry(dir, e); continue; }
        const st = await fsp.stat(path.join(dir, 'log', e.name)).catch(() => null);
        let size = st ? st.size : 0;
        if (e.blob) { liveBlobs.add(e.id); size += await dirSize(path.join(dir, 'blob', e.id)); }
        all.push({ dir, e, size });
        total += size;
      }
      for (const b of await fsp.readdir(path.join(dir, 'blob')).catch(() => [])) {
        if (liveBlobs.has(b)) continue;
        const p = path.join(dir, 'blob', b);
        const st = await fsp.stat(p).catch(() => null);
        if (!st) continue;
        // A blob no stored entry points at is an upload still in flight (or
        // junk). It is dropped after a day, and it is the first thing to go
        // when the store is above its cap - otherwise it would be a hole in it.
        if (now - st.mtimeMs > 86400000) { await fsp.rm(p, { recursive: true, force: true }); continue; }
        const size = await dirSize(p);
        total += size;
        all.push({ dir, e: { ts: st.mtimeMs, orphan: b }, size });
      }
      // A room with nothing stored in it is only a reservation: forget it
      // quickly, so empty rooms cannot pile up or squat a code for long.
      const st = await fsp.stat(path.join(dir, 'auth')).catch(() => null);
      const empty = !liveBlobs.size && !(await listEntries(dir)).length;
      if (empty && st && now - st.mtimeMs > EMPTY_ROOM_MS) {
        await fsp.rm(dir, { recursive: true, force: true });
        continue;
      }
      // The auth file and the directories themselves take real space: count
      // them, so thousands of rooms show up against the cap as well.
      const overhead = (st ? st.size : 0) + 8192;
      total += overhead;
      if (empty) all.push({ dir, e: { ts: st ? st.mtimeMs : 0, empty: true }, size: overhead });
    }
    if (total > CAP_BYTES) {
      all.sort((a, b) => a.e.ts - b.e.ts);
      for (const x of all) {
        if (total <= CAP_BYTES * 0.95) break;
        if (x.e.orphan) await fsp.rm(path.join(x.dir, 'blob', x.e.orphan), { recursive: true, force: true });
        else if (x.e.empty) await fsp.rm(x.dir, { recursive: true, force: true });
        else await dropEntry(x.dir, x.e);
        total -= x.size;
      }
    }
    storeTotal = total;
  } catch (err) {
    console.error('janitor', err.message);
  } finally {
    janitorRunning = false;
  }
}
setTimeout(janitor, 5000);
setInterval(janitor, 5 * 60000);

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/h/')) return handleStore(req, res);
  if (req.method === 'POST' && req.url === '/preview') return handlePreview(req, res);
  if (req.method === 'POST' && req.url === '/gif/search') return handleGifSearch(req, res);
  if (req.method === 'GET' && req.url.startsWith('/gif/m?')) return handleGifMedia(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { return socket.destroy(); }
  const room = url.searchParams.get('room') || '';
  const cid = url.searchParams.get('cid') || '';
  if (url.pathname !== '/ws' || !okOrigin(req.headers.origin) ||
      !/^[A-Za-z0-9_-]{22}$/.test(room) || !/^[A-Za-z0-9_-]{16}$/.test(cid)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  const fresh = url.searchParams.get('new') === '1';
  wss.handleUpgrade(req, socket, head, (ws) => { onConnection(ws, room, cid, fresh).catch(() => ws.terminate()); });
});

// Up to MAX_PEERS devices share a room (e.g. two phones and a laptop). Every
// frame names its destination device; the relay stamps the sender and passes
// the opaque payload on. It never sees keys or plaintext.
const MAX_PEERS = 3;

function peerById(set, id) {
  for (const s of set) if (s.cid === id) return s;
  return null;
}

async function onConnection(ws, roomId, cid, fresh) {
  // Fetch ICE first: everything below must run without yielding so the
  // welcome and peer notices stay in order.
  const ice = await iceServers();
  if (ws.readyState !== ws.OPEN) return;
  // New rooms can be switched off from the admin panel.
  if (fresh && !feature('newRooms')) {
    send(ws, { t: 'closed' });
    return ws.close(4003, 'closed');
  }
  // Creating a room whose code is already in use: let the client pick another.
  if (fresh && [...(rooms.get(roomId) || [])].some((s) => s.cid !== cid)) {
    send(ws, { t: 'taken' });
    return ws.close(4002, 'taken');
  }
  // ...or whose code already has stored history.
  if (fresh && !rooms.get(roomId)?.size && fs.existsSync(path.join(ROOMS_DIR, roomId, 'auth'))) {
    send(ws, { t: 'taken' });
    return ws.close(4002, 'taken');
  }
  let set = rooms.get(roomId);
  if (!set) {
    if (rooms.size >= MAX_ROOMS) return ws.close(1013, 'busy');
    set = new Set();
    rooms.set(roomId, set);
  }

  // A reconnecting tab replaces its own stale socket instead of being locked out.
  for (const s of set) {
    if (s.cid === cid) {
      s.replaced = true;
      set.delete(s);
      s.terminate();
      for (const o of set) send(o, { t: 'peer-left', id: cid });
    }
  }
  if (set.size >= MAX_PEERS) {
    send(ws, { t: 'full' });
    return ws.close(4001, 'full');
  }

  ws.cid = cid;
  ws.cidBytes = Buffer.from(cid, 'base64url');
  ws.alive = true;
  ws.budget = MAX_MSG_PER_10S;
  for (const o of set) send(o, { t: 'peer-joined', id: cid });
  set.add(ws);
  const features = { gif: feature('gif'), preview: feature('preview'), calls: feature('calls') };
  send(ws, { t: 'welcome', ice: features.calls ? ice : [], features, peers: [...set].filter((s) => s !== ws).map((s) => s.cid) });

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (data, isBinary) => {
    if (--ws.budget < 0) return ws.close(4008, 'rate');
    if (isBinary) {
      // Encrypted file chunk: [1][to 12 bytes][...] -> [1][from 12 bytes][...]
      if (data.length < 14 || data[0] !== 1) return;
      const peer = peerById(set, data.subarray(1, 13).toString('base64url'));
      if (!peer || peer === ws || peer.readyState !== peer.OPEN) return;
      const out = Buffer.from(data);
      ws.cidBytes.copy(out, 1);
      peer.send(out, { binary: true });
      return;
    }
    const text = data.toString();
    if (text === '{"t":"ping"}') return send(ws, { t: 'pong' });
    if (text === '{"t":"ice?"}') { iceServers().then((list) => send(ws, { t: 'ice', ice: list })); return; }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.to !== 'string') return;
    const peer = peerById(set, msg.to);
    if (!peer || peer === ws || peer.readyState !== peer.OPEN) return;
    delete msg.to;
    msg.from = ws.cid;
    peer.send(JSON.stringify(msg));
  });

  ws.on('close', () => {
    if (ws.replaced) return;
    set.delete(ws);
    for (const o of set) send(o, { t: 'peer-left', id: cid });
    if (set.size === 0) rooms.delete(roomId);
  });

  ws.on('error', () => {});
}

// Heartbeat keeps Cloudflare from idling the socket and reaps dead peers.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

// Refill each socket's message budget.
setInterval(() => {
  for (const ws of wss.clients) ws.budget = MAX_MSG_PER_10S;
}, 10000);

server.listen(PORT, HOST);

// ---------- admin API (127.0.0.1 only, its own port, shared secret) ----------
// Used by the admin panel on this same server. It reports sizes, counts and
// times, and can delete or disconnect a room; it has no way to read content,
// because the server never holds any key. Room ids are already HKDF hashes.
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8788);
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const SETTINGS_FILE = path.join(STORE, 'settings.json');
const FEATURE_KEYS = ['gif', 'preview', 'calls', 'newRooms'];
// Defaults come from the unit's environment; an admin settings file, once
// written, overrides them (applySettings below).
const settings = {
  capGB: Number(process.env.STORE_CAP_GB) || 50,
  maxDays: Number(process.env.STORE_MAX_DAYS) || 90,
  features: { gif: true, preview: true, calls: true, newRooms: true },
};
let lastJanitorAt = 0;

function applySettings(next) {
  if (Number.isFinite(next.capGB)) settings.capGB = Math.min(500, Math.max(1, Math.round(next.capGB)));
  if (Number.isFinite(next.maxDays)) settings.maxDays = Math.min(3650, Math.max(1, Math.round(next.maxDays)));
  for (const k of FEATURE_KEYS) if (typeof next.features?.[k] === 'boolean') settings.features[k] = next.features[k];
  CAP_BYTES = settings.capGB * 1024 ** 3;
  MAX_AGE_MS = settings.maxDays * 86400000;
}
try { applySettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch { applySettings({}); }
const feature = (k) => settings.features[k] !== false;

async function roomReport() {
  const out = new Map();
  for (const id of await fsp.readdir(ROOMS_DIR).catch(() => [])) {
    if (!ROOM_RE.test(id)) continue;
    const dir = path.join(ROOMS_DIR, id);
    const entries = await listEntries(dir);
    const st = await fsp.stat(path.join(dir, 'auth')).catch(() => null);
    out.set(id, {
      id, bytes: await dirSize(dir), items: entries.length, files: entries.filter((e) => e.blob).length,
      created: st ? Math.round(st.mtimeMs) : null,
      lastActivity: entries.reduce((m, e) => Math.max(m, e.ts), st ? Math.round(st.mtimeMs) : 0) || null,
      online: 0, stored: true,
    });
  }
  for (const [id, set] of rooms) {
    const r = out.get(id) || { id, bytes: 0, items: 0, files: 0, created: null, lastActivity: null, online: 0, stored: false };
    r.online = set.size;
    out.set(id, r);
  }
  return [...out.values()];
}

function dropLive(roomId, code, reason) {
  const set = rooms.get(roomId);
  if (!set) return 0;
  const n = set.size;
  for (const s of [...set]) { try { s.close(code, reason); } catch {} }
  return n;
}

function handleAdmin(req, res) {
  const given = Buffer.from(String(req.headers['x-admin-secret'] || ''));
  const want = Buffer.from(ADMIN_SECRET);
  if (!ADMIN_SECRET || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return json(res, 403, {});
  const url = new URL(req.url, 'http://admin');
  (async () => {
    if (req.method === 'GET' && url.pathname === '/stats') {
      let devices = 0;
      for (const set of rooms.values()) devices += set.size;
      return json(res, 200, {
        now: Date.now(), uptime: Math.round(process.uptime()), rss: process.memoryUsage().rss,
        live: { rooms: rooms.size, devices },
        store: { totalBytes: storeTotal, capBytes: CAP_BYTES, maxDays: settings.maxDays, lastJanitorAt },
        settings, rooms: await roomReport(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/settings') return json(res, 200, settings);
    const body = req.method === 'POST' ? JSON.parse((await readBodyBuf(req, 16 * 1024)).toString('utf8') || '{}') : {};
    if (req.method === 'POST' && url.pathname === '/settings') {
      applySettings(body);
      await writeAtomic(SETTINGS_FILE, JSON.stringify(settings));
      setImmediate(janitor);
      return json(res, 200, settings);
    }
    if (req.method === 'POST' && url.pathname === '/rooms/delete' && ROOM_RE.test(body.id || '')) {
      const kicked = dropLive(body.id, 4009, 'deleted');
      await fsp.rm(path.join(ROOMS_DIR, body.id), { recursive: true, force: true });
      setImmediate(janitor);
      return json(res, 200, { kicked });
    }
    if (req.method === 'POST' && url.pathname === '/rooms/kick' && ROOM_RE.test(body.id || '')) {
      return json(res, 200, { kicked: dropLive(body.id, 4010, 'kicked') });
    }
    if (req.method === 'POST' && url.pathname === '/rooms/reset' && ROOM_RE.test(body.id || '')) {
      // Forget which token registered this room's store. The devices register
      // it again with their password-derived token on the next write, and the
      // ciphertext already stored stays readable to them.
      await fsp.rm(path.join(ROOMS_DIR, body.id, 'auth'), { force: true });
      return json(res, 200, { reset: true });
    }
    if (req.method === 'POST' && url.pathname === '/janitor') {
      await janitor();
      return json(res, 200, { totalBytes: storeTotal });
    }
    return json(res, 404, {});
  })().catch(() => json(res, 400, {}));
}

if (ADMIN_SECRET) http.createServer(handleAdmin).listen(ADMIN_PORT, '127.0.0.1');

