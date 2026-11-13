'use strict';
// Blind relay for the two-person E2EE room. It never sees keys or plaintext:
// it pairs at most two sockets per room id and forwards opaque frames between
// them. Nothing about connections is logged, except for a room the admin has
// put under a time-limited, case-bound watch (see "legal flags" below).

const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
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

// Our own coturn (TURN_URLS, on the panah server) is handed out next to
// Cloudflare's, not instead of it: some Iranian networks block one and not
// the other, and the browser keeps whichever relay path actually works.
function ownTurn() {
  if (!TURN_URLS.length || !TURN_SECRET) return null;
  // coturn "use-auth-secret" REST credentials, valid for TURN_TTL seconds.
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${crypto.randomBytes(6).toString('hex')}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { urls: TURN_URLS, username, credential };
}

async function iceServers() {
  const own = ownTurn();
  const cf = await cloudflareIce();
  if (cf.length) return own ? [...cf, own] : cf;
  const list = [];
  if (STUN_URLS.length) list.push({ urls: STUN_URLS });
  if (own) list.push(own);
  return list;
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
// YouTube: same rule as Instagram. The relay reads the public page/oEmbed and
// sends the title, channel and thumbnail to the sender, who shrinks the picture
// and sends it end-to-end encrypted; the recipient never contacts YouTube.
const YT_PAGE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);
const YT_IMG_HOST_RE = /^(i|img)\.ytimg\.com$/i;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
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

function youtubeId(start) {
  if (!YT_PAGE_HOSTS.has(start.hostname)) return null;
  let id = '';
  if (start.hostname === 'youtu.be' || start.hostname === 'www.youtu.be') id = start.pathname.split('/')[1] || '';
  else if (start.pathname === '/watch') id = start.searchParams.get('v') || '';
  else {
    const m = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(start.pathname);
    if (m) id = m[1];
  }
  return YT_ID_RE.test(id) ? id : null;
}

async function buildYouTubePreview(start, id) {
  const kind = start.pathname.startsWith('/shorts/') ? 'shorts' : start.pathname.startsWith('/live/') ? 'live' : 'video';
  const url = kind === 'shorts' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
  const result = { site: 'yt', url, kind, title: '', author: '', duration: 0, views: 0, live: kind === 'live', image: null };

  // oEmbed is the official, small metadata endpoint (no consent page).
  try {
    const r = await fetchLimited(
      new URL(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`),
      (h) => h === 'youtube.com' || h === 'www.youtube.com', 200000, 'application/json', false,
    );
    const j = JSON.parse(r.body.toString('utf8'));
    result.title = String(j.title || '').slice(0, 300);
    result.author = String(j.author_name || '').slice(0, 100);
  } catch {}

  // The watch page adds the duration/views shown on the card; a failure here
  // still leaves a usable preview from oEmbed and the thumbnail.
  try {
    const page = await fetchLimited(new URL(url), (h) => YT_PAGE_HOSTS.has(h), 2000000, 'text/html', true, BROWSER_UA);
    const html = page.body.toString('utf8');
    if (!result.title) {
      const t = /<title>([^<]+)<\/title>/i.exec(html);
      if (t) result.title = decodeEntities(t[1]).replace(/\s*-\s*YouTube\s*$/i, '').slice(0, 300);
    }
    if (!result.author) {
      const a = /"channelName":"([^"]+)"/.exec(html);
      if (a) {
        try { result.author = decodeEntities(JSON.parse(`"${a[1]}"`)).slice(0, 100); }
        catch { result.author = decodeEntities(a[1]).slice(0, 100); }
      }
    }
    const d = /"lengthSeconds":"(\d+)"/.exec(html);
    if (d) result.duration = Math.min(Number(d[1]) || 0, 86400);
    const v = /"viewCount":"(\d+)"/.exec(html);
    if (v) result.views = Math.min(Number(v[1]) || 0, 1e12);
    if (/"isLive":true/.test(html)) result.live = true;
  } catch {}

  // hqdefault always exists and is 4:3 with the 16:9 frame letterboxed; the
  // card's object-fit: cover crops exactly those bars.
  try {
    const pic = await fetchLimited(new URL(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`), (h) => YT_IMG_HOST_RE.test(h), 2000000, 'image/*', false);
    const type = pic.type.split(';')[0].trim();
    if (/^image\/(jpeg|png|webp)$/.test(type)) result.image = `data:${type};base64,${pic.body.toString('base64')}`;
  } catch {}

  return result;
}

async function buildPreview(raw) {
  const start = new URL(raw);
  const ytId = youtubeId(start);
  if (ytId) return buildYouTubePreview(start, ytId);
  if (!PAGE_HOSTS.has(start.hostname) || !(IG_PATH_RE.test(start.pathname) || SHARE_PATH_RE.test(start.pathname))) throw new Error('not instagram');
  const page = await fetchLimited(new URL(start.origin + start.pathname), (h) => PAGE_HOSTS.has(h), 1500000, 'text/html', true);
  const path = IG_PATH_RE.exec(page.url.pathname);
  if (!path) throw new Error('no post');
  const kind = path[1] === 'reels' ? 'reel' : path[1];
  const tags = metaTags(page.body.toString('utf8'));
  const result = {
    site: 'ig',
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
const gifRuns = new Map(); // query -> { at, related, sent, first, pages }: one search and its "more" pages, in memory only
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

// Ids on a search page, plus the page's own "related searches", which is how
// "load more" goes deeper: neither site pages its HTML results without a key.
async function scrapeIds(url, re, idRe, relRe) {
  try {
    const host = new URL(url).hostname;
    const page = await fetchLimited(new URL(url), (h) => h === host, 2500000, 'text/html', true, BROWSER_UA);
    const html = page.body.toString('utf8');
    const ids = [];
    for (const m of html.matchAll(re)) if (idRe.test(m[1]) && !ids.includes(m[1])) ids.push(m[1]);
    const related = [];
    for (const m of html.matchAll(relRe)) {
      let term = '';
      try { term = decodeURIComponent(m[1]).replace(/-/g, ' ').trim().toLowerCase(); } catch {}
      if (term && term.length <= 50 && !related.includes(term)) related.push(term);
    }
    return { ids, related };
  } catch {
    return { ids: [], related: [] };
  }
}

async function findGifs(q) {
  const slug = encodeURIComponent(q.toLowerCase().replace(/\s+/g, '-'));
  const [g, t] = await Promise.all([
    scrapeIds(`https://giphy.com/search/${slug}`, /media\/(?:v1\.[^/"\\]+\/)?([A-Za-z0-9]{12,40})\/(?:giphy|200w|100w|200|100)\b/g, GIF_ID.g, /href="\/search\/([^"?#/]+)"/g),
    scrapeIds(`https://tenor.com/search/${slug}-gifs`, /media[0-9]?\.tenor\.com\/(?:m\/)?([A-Za-z0-9_-]{11})AAAA[A-Za-z0-9]\//g, GIF_ID.t, /href="\/search\/([^"?#/]+)-gifs"/g),
  ]);
  const items = [];
  for (let i = 0; i < g.ids.length || i < t.ids.length; i++) { // alternate, so neither source dominates
    if (i < t.ids.length) items.push({ p: 't', id: t.ids[i] });
    if (i < g.ids.length) items.push({ p: 'g', id: g.ids[i] });
  }
  const related = [];
  for (let i = 0; i < Math.max(t.related.length, g.related.length); i++) {
    for (const term of [t.related[i], g.related[i]]) if (term && term !== q && !related.includes(term)) related.push(term);
  }
  return { items, related: related.slice(0, 12) };
}

// page 0: the query itself; page n: its n-th related search. Ids already
// sent for this query are dropped, so "more" never repeats a GIF.
// Each answered page is kept in its run, so asking again costs nothing and
// the "already sent" set always matches what clients were given.
async function gifPage(q, page) {
  let run = gifRuns.get(q);
  if (!run || Date.now() - run.at > 600000) {
    if (--gifBudget < 0) return null;
    const first = await findGifs(q);
    run = { at: Date.now(), related: first.related, sent: new Set(), first: first.items, pages: [] };
    gifRuns.set(q, run);
    if (gifRuns.size > 200) gifRuns.delete(gifRuns.keys().next().value);
  }
  if (run.pages[page]) return run.pages[page];
  let raw = [];
  if (page === 0) raw = run.first;
  else if (page <= run.related.length) {
    if (--gifBudget < 0) return null;
    raw = (await findGifs(run.related[page - 1])).items;
  }
  const items = [];
  for (const it of raw) {
    const k = `${it.p}:${it.id}`;
    if (run.sent.has(k)) continue;
    run.sent.add(k);
    items.push({ thumb: `/gif/m?p=${it.p}&r=t&id=${it.id}`, send: `/gif/m?p=${it.p}&r=s&id=${it.id}` });
  }
  run.pages[page] = { items, more: page < run.related.length };
  return run.pages[page];
}

async function handleGifSearch(req, res) {
  if (!okOrigin(req.headers.origin)) return json(res, 403, {});
  if (!feature('gif')) return json(res, 503, { error: 'disabled' });
  try {
    const { q, page: pageIn } = JSON.parse(await readBody(req, 1024));
    if (typeof q !== 'string' || !q.trim() || q.length > 50) return json(res, 400, {});
    const page = Number.isInteger(pageIn) && pageIn >= 0 && pageIn <= 12 ? pageIn : 0;
    const out = await gifPage(q.trim().toLowerCase(), page);
    if (!out) return json(res, 429, {});
    json(res, 200, out);
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

// Room-creation password. When ROOM_CREATE_KEY_SHA256 (hex sha256 of the
// password) is set, a new room can only be opened by a client that sends that
// password with its first connection (?ck=); the relay then makes the room's
// directory, and nothing else may make one: the store refuses to register an
// unknown room, and a plain join to a room that does not exist is refused.
// Wrong guesses share one small budget, so the password cannot be brute-forced.
const CREATE_KEY_HASH = /^[0-9a-f]{64}$/i.test(process.env.ROOM_CREATE_KEY_SHA256 || '')
  ? Buffer.from(process.env.ROOM_CREATE_KEY_SHA256, 'hex') : null;
let createFailBudget = 10;
setInterval(() => { createFailBudget = 10; }, 10 * 60000);
function createKeyOk(given) {
  if (!CREATE_KEY_HASH) return true;
  if (createFailBudget <= 0) return false;
  const h = crypto.createHash('sha256').update(String(given || '').slice(0, 200)).digest();
  if (crypto.timingSafeEqual(h, CREATE_KEY_HASH)) return true;
  createFailBudget--;
  return false;
}
const roomKnown = (room) => fs.existsSync(path.join(ROOMS_DIR, room));

// ---------- legal flags (set from the admin panel only) ----------
// Each is a small JSON file in the room's directory, so it survives restarts.
//  hold    - legal preservation. Nothing in the room is destroyed: deletes by
//            the devices, self-destruct timers, the age limit and the storage
//            cap move entries into held/ instead (out of every listing, kept
//            as they were). The admin cannot delete the room while it is held.
//  suspend - the room is closed: devices are refused (4012) and its store
//            answers 451.
//  watch   - a targeted connection log for this one room (time, address,
//            device id, user agent, country), only on a case reference and
//            only until a set time. No other room is ever logged.
// The content stays end-to-end encrypted in every case: no flag can open it.
const FLAG_KEYS = ['hold', 'suspend', 'watch'];
const flagCache = new Map(); // roomId -> {hold?, suspend?, watch?}
function roomFlags(room) {
  let f = flagCache.get(room);
  if (!f) {
    f = {};
    if (ROOM_RE.test(room) && roomKnown(room)) {
      for (const k of FLAG_KEYS) {
        try { f[k] = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, room, `${k}.flag`), 'utf8')); } catch {}
      }
      flagCache.set(room, f);
    }
  }
  if (f.watch && f.watch.until && f.watch.until < Date.now()) return { ...f, watch: undefined };
  return f;
}

// The visitor's address as Cloudflare reports it (nginx passes the header on).
function clientIp(req) {
  for (const h of ['cf-connecting-ip', 'x-real-ip']) {
    const v = String(req.headers[h] || '').trim();
    if (net.isIP(v)) return v;
  }
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
function clientMeta(req) {
  return {
    ip: clientIp(req),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    cc: String(req.headers['cf-ipcountry'] || '').slice(0, 2),
  };
}

// Connection log of a watched room: one JSON line per event, capped in size.
const CONN_LOG_MAX = 20 * 1024 * 1024;
async function connLog(room, ev, meta, extra = {}) {
  const f = roomFlags(room);
  if (!f.watch) return;
  const file = path.join(ROOMS_DIR, room, 'conn.log');
  const st = await fsp.stat(file).catch(() => null);
  if (st && st.size > CONN_LOG_MAX) return;
  const line = JSON.stringify({ ts: Date.now(), ev, ...meta, ...extra, case: f.watch.case || '' });
  await fsp.appendFile(file, `${line}\n`).catch(() => {});
}

// Address block list (admin panel): exact addresses or CIDR ranges.
const BLOCKS_FILE = path.join(STORE, 'blocks.json');
let blocks = [];
let blockList = new net.BlockList();
function applyBlocks(list) {
  const now = Date.now();
  const next = new net.BlockList();
  const kept = [];
  for (const b of Array.isArray(list) ? list.slice(0, 5000) : []) {
    const [addr, bits] = String(b.cidr || '').split('/');
    const fam = net.isIP(addr);
    if (!fam || (b.until && b.until < now)) continue;
    const type = fam === 6 ? 'ipv6' : 'ipv4';
    const max = fam === 6 ? 128 : 32;
    const prefix = bits === undefined ? max : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) continue;
    try {
      if (prefix === max) next.addAddress(addr, type); else next.addSubnet(addr, prefix, type);
    } catch { continue; }
    kept.push({ cidr: `${addr}${prefix === max ? '' : `/${prefix}`}`, until: Number(b.until) || 0, note: String(b.note || '').slice(0, 200) });
  }
  blocks = kept;
  blockList = next;
}
try { applyBlocks(JSON.parse(fs.readFileSync(BLOCKS_FILE, 'utf8'))); } catch {}
setInterval(() => { if (blocks.some((b) => b.until && b.until < Date.now())) applyBlocks(blocks); }, 60000);
function ipIsBlocked(ip) {
  if (!blocks.length || !net.isIP(ip)) return false;
  try { return blockList.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4'); } catch { return false; }
}

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
    // With a creation password, only the relay itself opens room directories.
    if (!known && CREATE_KEY_HASH) return { claimed: true };
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

// ---------- song links (POST /h/music) ----------
// A member sends a link to an audio file; the relay downloads it and hands the
// bytes straight back, and the device encrypts and sends it like any track.
// The device never touches the unknown site, and the relay is not an open
// proxy for internal addresses (SSRF):
//  - only members of a room (valid room auth), a global hourly budget and at
//    most two downloads at once;
//  - http/https on ports 80/443 only; every name is resolved by us and EVERY
//    address checked against private / loopback / link-local / reserved
//    ranges inside the socket's own lookup, so DNS rebinding cannot swap in
//    an internal address after the check; redirects are followed by hand and
//    re-checked;
//  - audio only, by content type AND by the file's first bytes; 50 MB, timed
//    out; nothing is written to disk, cached or logged.
const MUSIC_MAX = 50 * 1024 * 1024;
let musicBudget = 120;
let musicActive = 0;
setInterval(() => { musicBudget = 120; }, 3600000);

function ipBlocked(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return ipBlocked(mapped[1]);
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) ||
      x.startsWith('64:ff9b:') || x.startsWith('2001:db8:') || x.startsWith('::ffff:') || x.startsWith('100::');
  }
  return true;
}

// dns.lookup wrapper used by the socket itself: refuses the connection if any
// resolved address is not public.
function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => ipBlocked(a.address))) return cb(new Error('blocked address'));
    const pick = addrs[0];
    if (opts && opts.all) return cb(null, addrs);
    cb(null, pick.address, pick.family);
  });
}

const AUDIO_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav' };
function audioMagic(b) {
  if (b.length < 12) return null;
  const s4 = b.subarray(0, 4).toString('latin1');
  if (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return (b[1] & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  if (s4 === 'OggS') return 'audio/ogg';
  if (s4 === 'fLaC') return 'audio/flac';
  if (s4 === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  return null;
}

function musicGet(url, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > 3) return reject(new Error('redirects'));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return reject(new Error('scheme'));
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) return reject(new Error('port'));
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && ipBlocked(url.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('blocked address'));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET', lookup: safeLookup, timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Najva music fetch)', Accept: 'audio/*,application/octet-stream;q=0.5' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url); } catch { return reject(new Error('redirect')); }
        return musicGet(next, hop + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('status')); }
      resolve({ res, url });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function handleMusicFetch(req, res) {
  if (!okOrigin(req.headers.origin)) return json(res, 403, {});
  const auth = await storeAuth(req, false);
  if (!auth?.dir) return json(res, 403, {}); // a registered room with the right key; a made-up room id is not enough
  if (musicActive >= 2) return json(res, 429, { error: 'busy' });
  if (--musicBudget < 0) return json(res, 429, {});
  musicActive++;
  let done = false;
  const finish = () => { if (!done) { done = true; musicActive--; } };
  res.on('close', finish);
  try {
    const { u } = JSON.parse(await readBody(req, 2048));
    if (typeof u !== 'string' || u.length > 1000) return json(res, 400, {});
    const { res: up, url } = await musicGet(new URL(u));
    const len = Number(up.headers['content-length'] || 0);
    if (len > MUSIC_MAX) { up.destroy(); return json(res, 413, {}); }
    const ctype = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(url.pathname) || [])[1]?.toLowerCase();
    if (!(ctype.startsWith('audio/') || ((ctype === 'application/octet-stream' || ctype === 'binary/octet-stream' || !ctype) && AUDIO_EXT[ext]))) { up.destroy(); return json(res, 415, {}); }
    // Read the first bytes to check they really are audio before sending any.
    const chunks = [];
    let n = 0;
    let type = null;
    const idle = setTimeout(() => up.destroy(new Error('timeout')), 120000);
    for await (const c of up) {
      n += c.length;
      if (n > MUSIC_MAX) { up.destroy(); clearTimeout(idle); return res.headersSent ? res.destroy() : json(res, 413, {}); }
      if (!type) {
        chunks.push(c);
        const head = Buffer.concat(chunks);
        if (head.length < 12) continue;
        type = audioMagic(head);
        if (!type) { up.destroy(); clearTimeout(idle); return json(res, 415, {}); }
        let name = decodeURIComponent(path.basename(url.pathname)).replace(/[\x00-\x1f"\\/]/g, '').slice(0, 120) || 'track';
        const cd = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(up.headers['content-disposition'] || ''));
        if (cd) { try { name = decodeURIComponent(cd[1]).replace(/[\x00-\x1f"\\/]/g, '').slice(0, 120) || name; } catch {} }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Track-Name': encodeURIComponent(name), ...(len ? { 'Content-Length': len } : {}) });
        res.write(head);
        continue;
      }
      if (!res.write(c)) await new Promise((r) => res.once('drain', r));
    }
    clearTimeout(idle);
    if (!type) return json(res, 415, {});
    res.end();
  } catch {
    if (!res.headersSent) json(res, 422, {});
    else res.destroy();
  } finally {
    finish();
  }
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

// Legal hold: an entry that would be deleted is moved into held/ instead,
// under the time it was retired, and no listing ever shows it again.
async function retireEntry(dir, e) {
  await fsp.mkdir(path.join(dir, 'held', 'log'), { recursive: true });
  await fsp.rename(path.join(dir, 'log', e.name), path.join(dir, 'held', 'log', `${pad13(Date.now())}-${e.name}`)).catch(() => {});
  if (e.blob) await retireBlob(dir, e.id);
}
async function retireBlob(dir, id) {
  const from = path.join(dir, 'blob', id);
  if (!(await fsp.stat(from).catch(() => null))) return;
  await fsp.mkdir(path.join(dir, 'held', 'blob'), { recursive: true });
  const to = path.join(dir, 'held', 'blob', id);
  await fsp.rename(from, (await fsp.stat(to).catch(() => null)) ? `${to}.${Date.now()}` : to).catch(() => {});
}
const isHeld = (dir) => !!roomFlags(path.basename(dir)).hold;
async function removeEntry(dir, e) {
  return isHeld(dir) ? retireEntry(dir, e) : dropEntry(dir, e);
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
      if (entry.at !== undefined && entry.at !== 0 && !(Number.isInteger(entry.at) && entry.at > Date.now() && entry.at <= Date.now() + MAX_SCHEDULE_MS)) return json(res, 400, {});
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
    const roomId = path.basename(dir);
    const flags = roomFlags(roomId);
    if (flags.suspend) return json(res, 451, { error: 'suspended' });
    if (flags.watch && req.method !== 'GET') {
      const ev = isLog ? 'store' : isBlob ? (parts[3] === '0' ? 'upload' : '') : parts[1];
      if (ev) connLog(roomId, ev, clientMeta(req), isLog ? { item: entry.id } : isBlob ? { item: parts[2] } : {});
    }
    // POST /h/log  {id, iv, ct, blob, exp}
    if (entry) {
      const existing = (await listEntries(dir)).find((e) => e.id === entry.id);
      if (existing) return json(res, 200, { ts: existing.ts });
      // A scheduled entry is filed under its delivery time and stays out of
      // every listing until then (see GET below and the due timer).
      const at = entry.at > 0 ? entry.at : 0;
      const e = { ts: at || Date.now(), id: entry.id, exp: Number.isInteger(entry.exp) && entry.exp > 0 ? entry.exp : 0, blob: !!entry.blob };
      const data = JSON.stringify({ iv: entry.iv, ct: entry.ct });
      await writeAtomic(path.join(dir, 'log', entryName(e)), data);
      storeTotal += data.length;
      if (storeTotal > CAP_BYTES) setImmediate(janitor);
      if (at) dueQueue.push({ room: path.basename(dir), at });
      return json(res, 200, { ts: e.ts });
    }
    // GET /h/log?before=&limit=
    if (req.method === 'GET' && parts[1] === 'log') {
      const before = Number(url.searchParams.get('before')) || Infinity;
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const after = Number(url.searchParams.get('after')) || 0;
      const now = Date.now();
      const list = (await listEntries(dir)).filter((e) => e.ts < before && e.ts > after && e.ts <= now && !(e.exp && e.exp <= now)).sort((a, b) => b.ts - a.ts);
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
      for (const e of await listEntries(dir)) if (want.has(e.id)) await removeEntry(dir, e);
      for (const id of want) {
        if (isHeld(dir)) await retireBlob(dir, id);
        else await fsp.rm(path.join(dir, 'blob', id), { recursive: true, force: true });
      }
      return json(res, 200, {});
    }
    // POST /h/clear: delete everything in this room (keeps its registration)
    if (req.method === 'POST' && parts[1] === 'clear') {
      if (isHeld(dir)) {
        for (const e of await listEntries(dir)) await retireEntry(dir, e);
        for (const b of await fsp.readdir(path.join(dir, 'blob')).catch(() => [])) await retireBlob(dir, b);
        return json(res, 200, {});
      }
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

// ---------- scheduled messages ----------
// A device may store a message now with a later delivery time. Until then the
// relay leaves it out of /h/log; when the time comes it tells every open app in
// the room ({t:'due'}) to read the log again. Pending times are rebuilt from
// the file names after a restart, so nothing is lost if the relay restarts.
const MAX_SCHEDULE_MS = 400 * 86400000;
const dueQueue = []; // {room, at}
async function loadDueQueue() {
  const now = Date.now();
  for (const room of await fsp.readdir(ROOMS_DIR).catch(() => [])) {
    if (!ROOM_RE.test(room)) continue;
    for (const e of await listEntries(path.join(ROOMS_DIR, room))) if (e.ts > now) dueQueue.push({ room, at: e.ts });
  }
}
loadDueQueue().catch(() => {});
setInterval(() => {
  const now = Date.now();
  const ring = new Set();
  for (let i = dueQueue.length - 1; i >= 0; i--) {
    if (dueQueue[i].at > now) continue;
    ring.add(dueQueue[i].room);
    dueQueue.splice(i, 1);
  }
  for (const room of ring) for (const ws of rooms.get(room) || []) send(ws, { t: 'due' });
}, 3000);

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
      // A room under legal hold loses nothing: what would expire is retired
      // into held/, and none of it is ever evicted for the cap.
      const held = !!roomFlags(room).hold;
      const liveBlobs = new Set();
      if (held) total += await dirSize(path.join(dir, 'held'));
      for (const e of await listEntries(dir)) {
        if ((e.exp && e.exp <= now) || e.ts < now - MAX_AGE_MS) { await (held ? retireEntry(dir, e) : dropEntry(dir, e)); continue; }
        const st = await fsp.stat(path.join(dir, 'log', e.name)).catch(() => null);
        let size = st ? st.size : 0;
        if (e.blob) { liveBlobs.add(e.id); size += await dirSize(path.join(dir, 'blob', e.id)); }
        if (!held) all.push({ dir, e, size });
        total += size;
      }
      for (const b of await fsp.readdir(path.join(dir, 'blob')).catch(() => [])) {
        if (liveBlobs.has(b)) continue;
        const p = path.join(dir, 'blob', b);
        const st = await fsp.stat(p).catch(() => null);
        if (!st) continue;
        if (held) { total += await dirSize(p); continue; }
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
      // A room opened with the creation password but never written to has no
      // auth file yet; it goes after the same delay, counted from its creation.
      const made = st || (empty && !rooms.get(room)?.size ? await fsp.stat(path.join(dir, 'created')).catch(() => null) : null);
      const flagged = FLAG_KEYS.some((k) => roomFlags(room)[k]);
      if (empty && made && !flagged && now - made.mtimeMs > EMPTY_ROOM_MS) {
        await fsp.rm(dir, { recursive: true, force: true });
        continue;
      }
      // The auth file and the directories themselves take real space: count
      // them, so thousands of rooms show up against the cap as well.
      const overhead = (st ? st.size : 0) + 8192;
      total += overhead;
      if (empty && !flagged) all.push({ dir, e: { ts: st ? st.mtimeMs : 0, empty: true }, size: overhead });
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

// ---------- proof-of-work CAPTCHA (Cap protocol, self-hosted) ----------
// POST /h/cap/challenge → { challenge: {c, s, d}, token, expires }
// POST /h/cap/redeem    { token, solutions } → { success, token, expires }
// The browser (the self-hosted Cap widget on report.html) must find, for each
// of c salts derived from the token, a number n with sha256(salt + n) starting
// with a d-hex-digit target: ~65k hashes each, about a second with WASM, but
// costly to do in bulk. Challenges and tokens are single use and kept in
// memory only; nothing about the visitor is stored.
const CAP = { c: 50, s: 32, d: 4, challengeMs: 10 * 60000, tokenMs: 20 * 60000, maxPending: 20000 };
const capChallenges = new Map();   // token → expires
const capTokens = new Map();       // `${id}:${sha256(secret)}` → expires
const capByIp = new Map();         // ip → challenges issued this window
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of capChallenges) if (exp < now) capChallenges.delete(k);
  for (const [k, exp] of capTokens) if (exp < now) capTokens.delete(k);
  capByIp.clear();
}, 10 * 60000).unref();
// The same deterministic generator the widget uses to expand a token.
function capPrng(seed, length) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  let state = h >>> 0;
  let out = '';
  while (out.length < length) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    out += (state >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function handleCapChallenge(req, res) {
  if (!okOrigin(req.headers.origin)) return json(res, 403, { error: 'origin' });
  const ip = clientIp(req);
  const n = capByIp.get(ip) || 0;
  if (n >= 40 || capChallenges.size >= CAP.maxPending) return json(res, 429, { error: 'Too many requests' });
  capByIp.set(ip, n + 1);
  const token = crypto.randomBytes(25).toString('hex');
  const expires = Date.now() + CAP.challengeMs;
  capChallenges.set(token, expires);
  return json(res, 200, { challenge: { c: CAP.c, s: CAP.s, d: CAP.d }, token, expires });
}
async function handleCapRedeem(req, res) {
  if (!okOrigin(req.headers.origin)) return json(res, 403, { success: false });
  let b;
  try { b = JSON.parse((await readBodyBuf(req, 4 * 1024)).toString('utf8')); } catch { return json(res, 400, { success: false }); }
  const token = typeof b?.token === 'string' ? b.token : '';
  const sol = b?.solutions;
  const exp = capChallenges.get(token);
  capChallenges.delete(token);   // one attempt per challenge
  if (!exp || exp < Date.now()) return json(res, 400, { success: false, error: 'Challenge invalid or expired' });
  if (!Array.isArray(sol) || sol.length !== CAP.c || !sol.every((x) => Number.isSafeInteger(x) && x >= 0)) {
    return json(res, 400, { success: false, error: 'Invalid body' });
  }
  for (let i = 1; i <= CAP.c; i++) {
    const salt = capPrng(`${token}${i}`, CAP.s);
    const target = capPrng(`${token}${i}d`, CAP.d);
    if (!sha256hex(salt + sol[i - 1]).startsWith(target)) return json(res, 400, { success: false, error: 'Invalid solution' });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(15).toString('hex');
  const expires = Date.now() + CAP.tokenMs;
  if (capTokens.size < CAP.maxPending) capTokens.set(`${id}:${sha256hex(secret)}`, expires);
  return json(res, 200, { success: true, token: `${id}:${secret}`, expires });
}
// Single use: a valid token is spent by the request that presents it.
function capSpend(token) {
  if (typeof token !== 'string' || token.length > 100) return false;
  const [id, secret] = token.split(':');
  if (!id || !secret) return false;
  const key = `${id}:${sha256hex(secret)}`;
  const exp = capTokens.get(key);
  capTokens.delete(key);
  return !!exp && exp > Date.now();
}

// ---------- abuse reports (POST /h/report) ----------
// Anyone may report a room by its 7-digit code. The relay turns the code into
// the room id (the same HKDF as the app), keeps the report for the admin panel
// to collect, and stores nothing about the reporter but what they typed.
const REPORTS_FILE = path.join(STORE, 'reports.jsonl');
const REPORT_REASONS = new Set(['abuse', 'csam', 'terror', 'fraud', 'threat', 'spam', 'other']);
let reportBudget = 60;
setInterval(() => { reportBudget = 60; }, 3600000);
const reportByIp = new Map();
setInterval(() => reportByIp.clear(), 3600000);
function roomIdForCode(code) {
  return Buffer.from(crypto.hkdfSync('sha256', `najva/room/${code}`, Buffer.alloc(32), 'wn1/room-id', 16)).toString('base64url');
}
async function handleReport(req, res) {
  if (!okOrigin(req.headers.origin)) return json(res, 403, {});
  const ip = clientIp(req);
  const n = reportByIp.get(ip) || 0;
  if (--reportBudget < 0 || n >= 5) return json(res, 429, {});
  reportByIp.set(ip, n + 1);
  try {
    const b = JSON.parse((await readBodyBuf(req, 8 * 1024)).toString('utf8'));
    const code = String(b.code || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
    if (!/^\d{7}$/.test(code) || !REPORT_REASONS.has(b.reason)) return json(res, 400, {});
    if (!capSpend(b.cap)) return json(res, 403, { error: 'captcha' });   // proof-of-work CAPTCHA
    const st = await fsp.stat(REPORTS_FILE).catch(() => null);
    if (st && st.size > 5 * 1024 * 1024) return json(res, 507, {});
    const rec = {
      id: crypto.randomBytes(9).toString('base64url'), ts: Date.now(), code, room: roomIdForCode(code),
      reason: b.reason, text: String(b.text || '').slice(0, 2000), contact: String(b.contact || '').slice(0, 200),
    };
    await fsp.appendFile(REPORTS_FILE, `${JSON.stringify(rec)}\n`);
    return json(res, 200, { ok: true, ref: rec.id });
  } catch {
    return json(res, 400, {});
  }
}

const server = http.createServer((req, res) => {
  if (ipIsBlocked(clientIp(req))) return json(res, 403, { error: 'blocked' });
  if (req.method === 'POST' && req.url === '/h/cap/challenge') return handleCapChallenge(req, res);
  if (req.method === 'POST' && req.url === '/h/cap/redeem') return handleCapRedeem(req, res);
  if (req.method === 'POST' && req.url === '/h/report') return handleReport(req, res);
  if (req.method === 'POST' && req.url === '/h/music') return handleMusicFetch(req, res);
  // GET /h/room?id=<roomId>: does this room exist? Lets the join form say so
  // before asking for the password. Without a creation password every code
  // may be joined (joining opens it), so the answer is always yes.
  if (req.method === 'GET' && req.url.startsWith('/h/room?')) {
    if (--storeBudget < 0) return json(res, 429, {});
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    if (!ROOM_RE.test(id)) return json(res, 400, {});
    return json(res, 200, { exists: !CREATE_KEY_HASH || !!rooms.get(id)?.size || roomKnown(id) });
  }
  if (req.url.startsWith('/h/')) return handleStore(req, res);
  if (req.method === 'POST' && req.url === '/preview') return handlePreview(req, res);
  if (req.method === 'POST' && req.url === '/gif/search') return handleGifSearch(req, res);
  if (req.method === 'GET' && req.url.startsWith('/gif/m?')) return handleGifMedia(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });

// The published app version (public/version.json next to this server). Sent in
// every welcome, and pushed to every open app the moment a release changes the
// file, so updates reach people at once without restarting the relay.
const VERSION_FILE = path.join(__dirname, '..', 'public', 'version.json');
function readAppVersion() {
  try { const v = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).v; return typeof v === 'string' && v.length <= 40 ? v : ''; } catch { return ''; }
}
let appVersion = readAppVersion();
fs.watchFile(VERSION_FILE, { interval: 5000 }, () => {
  const v = readAppVersion();
  if (!v || v === appVersion) return;
  appVersion = v;
  for (const ws of wss.clients) send(ws, { t: 'ver', v });
});

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
  const createKey = url.searchParams.get('ck') || '';
  const meta = clientMeta(req);
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (ipIsBlocked(meta.ip)) { send(ws, { t: 'blocked' }); return ws.close(4013, 'blocked'); }
    onConnection(ws, room, cid, fresh, createKey, meta).catch(() => ws.terminate());
  });
});

// Up to MAX_PEERS devices share a room (e.g. two phones and a laptop). Every
// frame names its destination device; the relay stamps the sender and passes
// the opaque payload on. It never sees keys or plaintext.
const MAX_PEERS = 3;
const RELAY_BUFFER = 4 * 1024 * 1024;

function peerById(set, id) {
  for (const s of set) if (s.cid === id) return s;
  return null;
}

async function onConnection(ws, roomId, cid, fresh, createKey = '', meta = {}) {
  // Fetch ICE first: everything below must run without yielding so the
  // welcome and peer notices stay in order.
  const ice = await iceServers();
  if (ws.readyState !== ws.OPEN) return;
  // Suspended by the admin (legal order or abuse): nobody gets in.
  if (roomFlags(roomId).suspend) {
    connLog(roomId, 'refused', meta, { cid, why: 'suspended' });
    send(ws, { t: 'suspended' });
    return ws.close(4012, 'suspended');
  }
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
  if (CREATE_KEY_HASH && !rooms.get(roomId)?.size && !roomKnown(roomId)) {
    // A room that does not exist yet: only the creation password opens it.
    if (!fresh) {
      send(ws, { t: 'noroom' });
      return ws.close(4011, 'noroom');
    }
    if (!createKeyOk(createKey)) {
      send(ws, { t: 'badkey' });
      return ws.close(4004, 'badkey');
    }
    let roomsNow = 0;
    try { roomsNow = fs.readdirSync(ROOMS_DIR).length; } catch {}
    if (roomsNow >= MAX_STORE_ROOMS) return ws.close(1013, 'busy');
    fs.mkdirSync(path.join(ROOMS_DIR, roomId, 'log'), { recursive: true });
    fs.mkdirSync(path.join(ROOMS_DIR, roomId, 'blob'), { recursive: true });
    fs.writeFileSync(path.join(ROOMS_DIR, roomId, 'created'), '');
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
  send(ws, { t: 'welcome', ice: features.calls ? ice : [], features, peers: [...set].filter((s) => s !== ws).map((s) => s.cid), ver: appVersion, notice: activeNotice() });
  const joinedAt = Date.now();
  connLog(roomId, fresh ? 'create' : 'join', meta, { cid });

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (data, isBinary) => {
    // Anything from the client proves it is there. While it uploads a large
    // file its pong can sit behind megabytes of chunks for longer than one
    // heartbeat, and the socket must not be cut for that.
    ws.alive = true;
    if (--ws.budget < 0) return ws.close(4008, 'rate');
    if (isBinary) {
      // Encrypted file chunk: [1][to 12 bytes][...] -> [1][from 12 bytes][...]
      if (data.length < 14 || data[0] !== 1) return;
      const peer = peerById(set, data.subarray(1, 13).toString('base64url'));
      if (!peer || peer === ws || peer.readyState !== peer.OPEN) return;
      // A receiver on a slower link than the sender would otherwise queue the
      // whole file here and fall behind its heartbeat. Past this it gets the
      // rest from the stored copy instead.
      if (peer.bufferedAmount > RELAY_BUFFER) return;
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

  ws.on('close', (code) => {
    connLog(roomId, 'leave', meta, { cid, secs: Math.round((Date.now() - joinedAt) / 1000), code });
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

// A service notice from the admin, shown in every open app (and to each one
// that connects) until it is cleared or its time runs out.
const NOTICE_FILE = path.join(STORE, 'notice.json');
let notice = null; // {text, level, until}
try { notice = JSON.parse(fs.readFileSync(NOTICE_FILE, 'utf8')); } catch {}
function activeNotice() {
  if (!notice || !notice.text || (notice.until && notice.until < Date.now())) return null;
  return { text: notice.text, level: notice.level, until: notice.until || 0 };
}

const HELD_RE = /^(\d{13})-(\d{13}-[A-Za-z0-9_-]{8,32}-\d{1,13}-[01]\.json)$/;
async function blobInfo(p) {
  const chunks = (await fsp.readdir(p).catch(() => [])).filter((n) => /^\d{1,4}$/.test(n));
  return { chunks: chunks.length, size: await dirSize(p) };
}
// Everything the store knows about one room, without content: entry times,
// ids, sizes, timers, retired (held) entries, flags and the connection log.
async function roomMeta(id) {
  const dir = path.join(ROOMS_DIR, id);
  if (!(await fsp.stat(dir).catch(() => null))) return null;
  const auth = await fsp.stat(path.join(dir, 'auth')).catch(() => null);
  const made = await fsp.stat(path.join(dir, 'created')).catch(() => null);
  const entries = [];
  for (const e of (await listEntries(dir)).sort((a, b) => a.ts - b.ts)) {
    const st = await fsp.stat(path.join(dir, 'log', e.name)).catch(() => null);
    const b = e.blob ? await blobInfo(path.join(dir, 'blob', e.id)) : { chunks: 0, size: 0 };
    entries.push({ name: e.name, ts: e.ts, id: e.id, exp: e.exp, blob: e.blob, size: (st ? st.size : 0) + b.size, chunks: b.chunks });
  }
  const held = [];
  for (const n of (await fsp.readdir(path.join(dir, 'held', 'log')).catch(() => [])).sort()) {
    const m = HELD_RE.exec(n);
    const e = m && parseEntry(m[2]);
    if (!e) continue;
    const st = await fsp.stat(path.join(dir, 'held', 'log', n)).catch(() => null);
    const b = e.blob ? await blobInfo(path.join(dir, 'held', 'blob', e.id)) : { chunks: 0, size: 0 };
    held.push({ name: n, retired: Number(m[1]), ts: e.ts, id: e.id, exp: e.exp, blob: e.blob, size: (st ? st.size : 0) + b.size, chunks: b.chunks });
  }
  const conn = [];
  const raw = await fsp.readFile(path.join(dir, 'conn.log'), 'utf8').catch(() => '');
  for (const line of raw.split('\n')) { if (!line) continue; try { conn.push(JSON.parse(line)); } catch {} }
  const live = [...(rooms.get(id) || [])].map((s) => s.cid);
  return {
    id, registered: auth ? Math.round(auth.mtimeMs) : null, created: made ? Math.round(made.mtimeMs) : (auth ? Math.round(auth.mtimeMs) : null),
    flags: roomFlags(id), entries, held, conn, live, bytes: await dirSize(dir),
  };
}
// Raw stored file (ciphertext) for a disclosure export; only these shapes.
const FILE_RE = /^(log\/\d{13}-[A-Za-z0-9_-]{8,32}-\d{1,13}-[01]\.json|held\/log\/\d{13}-\d{13}-[A-Za-z0-9_-]{8,32}-\d{1,13}-[01]\.json|(held\/)?blob\/[A-Za-z0-9_-]{8,32}\/\d{1,4})$/;

async function setFlags(id, body) {
  const dir = path.join(ROOMS_DIR, id);
  // A flag may be put on a room that has nothing stored yet (for instance one
  // that is only live): its directory is opened so the flag can live there.
  if (!(await fsp.stat(dir).catch(() => null))) {
    await fsp.mkdir(path.join(dir, 'log'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'blob'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'created'), '');
  }
  for (const k of FLAG_KEYS) {
    if (!(k in body)) continue;
    const file = path.join(dir, `${k}.flag`);
    const v = body[k];
    if (v && typeof v === 'object') {
      const rec = { case: String(v.case || '').slice(0, 60), by: String(v.by || '').slice(0, 120), since: Date.now(), reason: String(v.reason || '').slice(0, 300) };
      if (k === 'watch') rec.until = Math.min(Number(v.until) || 0, Date.now() + 90 * 86400000) || Date.now() + 30 * 86400000;
      await writeAtomic(file, JSON.stringify(rec));
    } else {
      await fsp.rm(file, { force: true });
    }
  }
  flagCache.delete(id);
  if (body.suspend) dropLive(id, 4012, 'suspended');
  return roomFlags(id);
}

async function roomReport() {
  const out = new Map();
  for (const id of await fsp.readdir(ROOMS_DIR).catch(() => [])) {
    if (!ROOM_RE.test(id)) continue;
    const dir = path.join(ROOMS_DIR, id);
    const entries = await listEntries(dir);
    const st = await fsp.stat(path.join(dir, 'auth')).catch(() => null);
    const made = st || await fsp.stat(path.join(dir, 'created')).catch(() => null);
    out.set(id, {
      id, bytes: await dirSize(dir), items: entries.length, files: entries.filter((e) => e.blob).length,
      created: made ? Math.round(made.mtimeMs) : null,
      lastActivity: entries.reduce((m, e) => Math.max(m, e.ts), st ? Math.round(st.mtimeMs) : 0) || null,
      online: 0, stored: true, flags: roomFlags(id),
      held: (await fsp.readdir(path.join(dir, 'held', 'log')).catch(() => [])).length,
    });
  }
  for (const [id, set] of rooms) {
    const r = out.get(id) || { id, bytes: 0, items: 0, files: 0, created: null, lastActivity: null, online: 0, stored: false, flags: {}, held: 0 };
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
    if (req.method === 'GET' && url.pathname === '/rooms/meta') {
      const id = url.searchParams.get('id') || '';
      if (!ROOM_RE.test(id)) return json(res, 400, {});
      const meta = await roomMeta(id);
      return meta ? json(res, 200, meta) : json(res, 404, {});
    }
    if (req.method === 'GET' && url.pathname === '/rooms/file') {
      const id = url.searchParams.get('id') || '';
      const p = url.searchParams.get('p') || '';
      if (!ROOM_RE.test(id) || !FILE_RE.test(p)) return json(res, 400, {});
      const data = await fsp.readFile(path.join(ROOMS_DIR, id, ...p.split('/'))).catch(() => null);
      if (!data) return json(res, 404, {});
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      return res.end(data);
    }
    if (req.method === 'GET' && url.pathname === '/blocks') return json(res, 200, { blocks });
    if (req.method === 'GET' && url.pathname === '/notice') return json(res, 200, { notice: activeNotice() });
    if (req.method === 'GET' && url.pathname === '/reports') {
      const raw = await fsp.readFile(REPORTS_FILE, 'utf8').catch(() => '');
      const reports = [];
      for (const line of raw.split('\n')) { if (!line) continue; try { reports.push(JSON.parse(line)); } catch {} }
      return json(res, 200, { reports });
    }
    const body = req.method === 'POST' ? JSON.parse((await readBodyBuf(req, 512 * 1024)).toString('utf8') || '{}') : {};
    if (req.method === 'POST' && url.pathname === '/settings') {
      applySettings(body);
      await writeAtomic(SETTINGS_FILE, JSON.stringify(settings));
      setImmediate(janitor);
      return json(res, 200, settings);
    }
    if (req.method === 'POST' && url.pathname === '/rooms/flags' && ROOM_RE.test(body.id || '')) {
      return json(res, 200, { flags: await setFlags(body.id, body) });
    }
    if (req.method === 'POST' && url.pathname === '/blocks') {
      applyBlocks(body.blocks);
      await writeAtomic(BLOCKS_FILE, JSON.stringify(blocks));
      return json(res, 200, { blocks });
    }
    if (req.method === 'POST' && url.pathname === '/notice') {
      const text = String(body.text || '').trim().slice(0, 500);
      notice = text ? { text, level: ['info', 'warn', 'alert'].includes(body.level) ? body.level : 'info', until: Number(body.until) || 0 } : null;
      await writeAtomic(NOTICE_FILE, JSON.stringify(notice));
      const n = activeNotice();
      for (const ws of wss.clients) send(ws, { t: 'notice', notice: n });
      return json(res, 200, { notice: n, sent: wss.clients.size });
    }
    if (req.method === 'POST' && url.pathname === '/reports/ack') {
      // The panel has copied these reports into its own database: drop them here.
      const done = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
      const raw = await fsp.readFile(REPORTS_FILE, 'utf8').catch(() => '');
      const keep = raw.split('\n').filter((line) => { if (!line) return false; try { return !done.has(JSON.parse(line).id); } catch { return false; } });
      await writeAtomic(REPORTS_FILE, keep.length ? `${keep.join('\n')}\n` : '');
      return json(res, 200, { left: keep.length });
    }
    if (req.method === 'POST' && url.pathname === '/rooms/delete' && ROOM_RE.test(body.id || '')) {
      // Never while a legal hold is on: release it first (a deliberate step).
      if (roomFlags(body.id).hold) return json(res, 409, { error: 'held' });
      const kicked = dropLive(body.id, 4009, 'deleted');
      flagCache.delete(body.id);
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

