// Najva: two-person end-to-end encrypted room.
//
// Keys:
//   A room is a 7-digit code (easy to text) plus a password. The code only
//   names the room: roomId = HKDF(code) is all the relay sees. The password is
//   the secret: psk = HKDF(PBKDF2(password, code), 800k iterations), and it
//   never leaves the device. psk authenticates every handshake.
// Handshake (per connection): fresh X25519 (or P-256) ephemeral keys,
//   root = HKDF(ECDH, salt = psk, info = transcript). A relay without the
//   password cannot complete it, and the symmetric psk keeps the session safe
//   even against a future quantum break of ECDH.
// Messages: per-direction HMAC chains give a new AES-256-GCM key per message;
//   a DH ratchet re-keys every 20 messages or 60 s, old keys are wiped.
// Files: a fresh AES-256 key per file, delivered inside the ratchet; the file
//   travels as encrypted binary chunks, the last one padded.
// Calls: WebRTC signaling travels inside this channel, so DTLS fingerprints
//   are authenticated; audio frames get a second AES-GCM layer on top of SRTP.
// Nothing is written to disk or browser storage; messages self-destruct after
// they are read.

const subtle = crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();
const $ = (id) => document.getElementById(id);
const ZERO = new Uint8Array(32);
const ONE = new Uint8Array([1]);
const TWO = new Uint8Array([2]);
const PBKDF2_ITERATIONS = 800000;
const MIN_PASS = 6;
const MAX_UNLOCK_TRIES = 5;
const REKEY_MESSAGES = 20;
const REKEY_MS = 60000;
const MAX_SKIP = 500;
const CHUNK = 128 * 1024;
const MAX_FILE = 100 * 1024 * 1024;
const TTLS = [0, 10, 30, 60, 300, 1800, 3600];
const REACTIONS = ['❤️', '😂', '😍', '😮', '😢', '🔥', '👍'];
const IG_LINK_RE = /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/[^\s]+/i;
const IG_PATH_RE = /\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})/;
const IG_CANON_RE = /^https:\/\/www\.instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]{5,64}\/$/;

// ---------- bytes ----------
function b64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad b64');
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}
function lp(bytes) { // length-prefixed, for unambiguous transcripts
  const n = new Uint8Array(2);
  new DataView(n.buffer).setUint16(0, bytes.length);
  return concat(n, bytes);
}
// getRandomValues fills at most 65536 bytes per call (larger paddings need several).
const rand = (n) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
};
function cmpBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function wipe(...arrs) { for (const a of arrs) if (a instanceof Uint8Array) a.fill(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fa = (n) => Number(n).toLocaleString('fa-IR');

// ---------- primitives ----------
async function hkdf(ikm, salt, info, len = 32) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, len * 8));
}
async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
async function sha256(data) { return new Uint8Array(await subtle.digest('SHA-256', data)); }
async function pbkdf2(pass, salt) {
  const k = await subtle.importKey('raw', te.encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, k, 256));
}

const CURVES = {
  x25519: { name: 'X25519' },
  p256: { name: 'ECDH', namedCurve: 'P-256' },
};
let x25519Supported = null;
async function hasX25519() {
  if (x25519Supported === null) {
    try { await subtle.generateKey(CURVES.x25519, false, ['deriveBits']); x25519Supported = true; }
    catch { x25519Supported = false; }
  }
  return x25519Supported;
}
async function genKeyPair(curve) {
  const kp = await subtle.generateKey(CURVES[curve], false, ['deriveBits']);
  return { priv: kp.privateKey, pub: new Uint8Array(await subtle.exportKey('raw', kp.publicKey)) };
}
async function ecdh(curve, priv, peerPub) {
  const pk = await subtle.importKey('raw', peerPub, CURVES[curve], false, []);
  const out = new Uint8Array(await subtle.deriveBits({ name: CURVES[curve].name, public: pk }, priv, 256));
  if (out.every((b) => b === 0)) throw new Error('weak key');
  return out;
}

// Pad to 256-byte buckets so ciphertext length leaks little about content.
function pad(bytes) {
  const out = new Uint8Array(Math.ceil((bytes.length + 4) / 256) * 256);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  out.set(rand(out.length - 4 - bytes.length), 4 + bytes.length);
  return out;
}
function unpad(bytes) {
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  if (len > bytes.length - 4) throw new Error('bad padding');
  return bytes.subarray(4, 4 + len);
}

// ---------- state ----------
const room = { code: '', id: '', psk: null, verifier: null, creating: false, pendingPass: null };
let locked = false;
let unlockFails = 0;
let ws = null;
const cid = b64u(rand(12)); // this tab's id on the relay
// This device's lasting identity: marks which stored messages are "mine".
const myDev = (() => {
  try {
    let d = localStorage.getItem('najva:dev');
    if (!/^[A-Za-z0-9_-]{16}$/.test(d || '')) { d = b64u(rand(12)); localStorage.setItem('najva:dev', d); }
    return d;
  } catch {
    return b64u(rand(12));
  }
})();
let iceServers = [];
let reconnectDelay = 1000;
let reconnectTimer = null;
let pingTimer = null;
let leaving = false;
// A room holds up to 3 devices (e.g. two phones and a laptop). Every pair of
// devices runs its own end-to-end session; a message is sealed separately for
// each other device, so each pair has its own keys and ratchet.
const sessions = new Map();   // peer id -> session
const knownNames = new Map(); // peer id -> display name (kept for labels after they leave)
let myName = '';
let queue = Promise.resolve();
const outbox = [];           // messages typed before any channel is secure
const unacked = new Map();   // id -> { msg, targets: Set, acked: Set }, resent after reconnects
const seen = new Map();      // id -> expiry, de-duplicates resends
const messages = new Map();  // id -> entry (see createEntry)
const incoming = new Map();  // file id -> in-progress download
let ttl = 0;
let unread = 0;
let lastTypingSent = 0;
let typingTimer = null;
let previewsOn = true;

const PID_RE = /^[A-Za-z0-9_-]{16}$/;
const secureSessions = () => [...sessions.values()].filter((x) => x.secure);
const anySecure = () => secureSessions().length > 0;
const peerName = (id) => knownNames.get(id) || sessions.get(id)?.name || [...sessions.values()].find((x) => x.dev === id)?.name || 'مخاطب';
const defaultName = () => (matchMedia('(pointer: coarse)').matches ? 'موبایل' : 'کامپیوتر');

// Every socket event and every outgoing seal runs through one queue, so chain
// counters and ratchet steps never interleave.
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch((err) => console.error(err));
  return p;
}

// ---------- room setup ----------
function newCode() {
  const limit = Math.floor(0x100000000 / 1e7) * 1e7;
  let n;
  do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= limit);
  return String(n % 1e7).padStart(7, '0');
}
const fmtCode = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;
function normDigits(s) {
  return s.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
}

async function passKeyFor(code, pass) {
  return pbkdf2(pass, te.encode('najva/v1/' + code));
}

async function openRoom(code, pass, creating) {
  room.code = code;
  room.id = b64u(await hkdf(te.encode('najva/room/' + code), ZERO, 'wn1/room-id', 16));
  const passKey = await passKeyFor(code, pass);
  wipe(room.psk, room.verifier);
  room.psk = await hkdf(passKey, te.encode(code), 'wn1/psk');
  room.verifier = await hkdf(passKey, te.encode(code), 'wn1/unlock');
  const libRaw = await hkdf(passKey, te.encode(code), 'wn1/library');
  room.libKey = await subtle.importKey('raw', libRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  room.libNs = b64u(await hkdf(passKey, te.encode(code), 'wn1/library-ns', 16));
  const histRaw = await hkdf(passKey, te.encode(code), 'wn1/history');
  room.histKey = await subtle.importKey('raw', histRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  room.storeAuth = b64u(await hkdf(passKey, te.encode(code), 'wn1/store-auth'));
  wipe(passKey, libRaw, histRaw);
  room.creating = creating;
  room.pendingPass = creating ? pass : null; // only until the code is confirmed free
  if (!myName) myName = defaultName();
  for (const id of ['room-tag', 'share-code', 'lock-code', 'menu-code']) $(id).textContent = fmtCode(code);
  $('sms-btn').href = `sms:?&body=${encodeURIComponent(`کد اتاق نجوا: ${code}\nhttps://${location.host}/#${code}`)}`;
  show('chat');
  connect();
  histBefore = null;
  histMore = false;
  if (!creating) loadHistory(true); // a brand-new room has no history yet
}

function connect() {
  clearTimeout(reconnectTimer);
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws?room=${room.id}&cid=${cid}${room.creating ? '&new=1' : ''}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    reconnectDelay = 1000;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sock.readyState === 1 && sock.send('{"t":"ping"}'), 20000);
  };
  sock.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { serial(() => onChunk(new Uint8Array(ev.data))); return; }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    serial(() => onWire(msg));
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    clearInterval(pingTimer);
    serial(() => endAllSessions());
    if (leaving) return;
    if (ev.code === 4001) { setStatus('full'); return; }
    if (ev.code === 4003) { setStatus('closed'); return; }   // new rooms switched off by the admin
    if (ev.code === 4009) { setStatus('deleted'); return; }  // room deleted by the admin
    if (ev.code === 4010) { setStatus('kicked'); return; }   // devices disconnected by the admin
    if (ev.code === 4002 && room.creating && room.pendingPass) {
      // Someone is already in a room with this code: pick a fresh one.
      toast('این کد در حال استفاده بود؛ کد تازه ساخته شد');
      openRoom(newCode(), room.pendingPass, true);
      return;
    }
    setStatus('connecting');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

function wireSend(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

async function onWire(msg) {
  switch (msg.t) {
    case 'welcome':
      iceServers = Array.isArray(msg.ice) ? msg.ice : [];
      applyFeatures(msg.features);
      room.creating = false;
      room.pendingPass = null;
      updatePresence();
      for (const pid of Array.isArray(msg.peers) ? msg.peers : []) if (PID_RE.test(pid)) await startHandshake(pid);
      break;
    case 'ice':
      iceServers = Array.isArray(msg.ice) ? msg.ice : iceServers;
      iceWaiters.splice(0).forEach((r) => r());
      break;
    case 'full':
      setStatus('full');
      break;
    case 'peer-joined':
      if (PID_RE.test(msg.id)) await startHandshake(msg.id);
      break;
    case 'peer-left':
      if (sessions.get(msg.id)?.secure) notice(`${peerName(msg.id)} از اتاق خارج شد`);
      await endSession(msg.id);
      break;
    case 'hello':
      await onHello(msg);
      break;
    case 'm':
      await onCipher(msg);
      break;
  }
}

// ---------- handshake (one per pair of devices) ----------
async function startHandshake(pid) {
  await endSession(pid);
  const s = {
    peer: pid, name: '', secure: false, failed: false,
    p: await genKeyPair('p256'),
    x: (await hasX25519()) ? await genKeyPair('x25519') : null,
    nonce: rand(16),
  };
  sessions.set(pid, s);
  updatePresence();
  wireSend({ t: 'hello', to: pid, v: 1, p: b64u(s.p.pub), x: s.x ? b64u(s.x.pub) : null, n: b64u(s.nonce) });
}

async function onHello(h) {
  if (!PID_RE.test(h.from) || h.v !== 1) return;
  let s = sessions.get(h.from);
  if (!s || s.root) { await startHandshake(h.from); s = sessions.get(h.from); }
  try {
    const peer = { p: unb64u(h.p), x: h.x ? unb64u(h.x) : null, nonce: unb64u(h.n) };
    if (peer.p.length !== 65 || peer.nonce.length !== 16 || (peer.x && peer.x.length !== 32)) throw new Error('hello');
    s.curve = s.x && peer.x ? 'x25519' : 'p256';
    s.role = cmpBytes(s.p.pub, peer.p) < 0 ? 'A' : 'B';
    const shared = s.curve === 'x25519' ? await ecdh('x25519', s.x.priv, peer.x) : await ecdh('p256', s.p.priv, peer.p);

    const mine = concat(lp(s.x ? s.x.pub : new Uint8Array()), lp(s.p.pub), lp(s.nonce));
    const theirs = concat(lp(peer.x || new Uint8Array()), lp(peer.p), lp(peer.nonce));
    const [first, second] = s.role === 'A' ? [mine, theirs] : [theirs, mine];
    const transcript = await sha256(concat(te.encode('wn1/handshake'), first, second));

    s.root = await hkdf(shared, room.psk, 'wn1/root/' + b64u(transcript));
    wipe(shared);
    s.sas = await sha256(concat(s.root, te.encode('wn1/sas')));
    s.p = s.x = null; // drop ephemeral private keys
    s.recv = new Map();
    s.skipped = new Map();
    s.rekeys = 0;
    await installChains(s, 0);
    await sendInner(s, { k: 'confirm' });
  } catch (err) {
    console.error(err);
    failAuth(s);
  }
}

async function installChains(s, epoch) {
  const ab = { ck: await hkdf(s.root, ZERO, `wn1/ck/AB/${epoch}`), n: 0 };
  const ba = { ck: await hkdf(s.root, ZERO, `wn1/ck/BA/${epoch}`), n: 0 };
  if (s.send) wipe(s.send.ck);
  s.send = s.role === 'A' ? ab : ba;
  s.sendEpoch = epoch;
  s.recv.set(epoch, s.role === 'A' ? ba : ab);
  for (const [e, ch] of s.recv) if (e < epoch - 1) { wipe(ch.ck); s.recv.delete(e); }
  for (const [k, mk] of s.skipped) if (Number(k.split(':')[0]) < epoch - 1) { wipe(mk); s.skipped.delete(k); }
  s.epochStart = Date.now();
  s.epochMsgs = 0;
}

function failAuth(s) {
  if (!s || sessions.get(s.peer) !== s) return;
  s.failed = true;
  updatePresence();
  banner('رمز اتاق یکی از دستگاه‌ها با شما یکی نیست (یا کسی در مسیر ارتباط دست برده است). با آن دستگاه هیچ پیامی رد و بدل نشد.', {
    label: 'وارد کردن دوباره‌ی رمز',
    fn: () => { leaving = true; location.replace(`/#${room.code}`); },
  });
}

async function endSession(pid) {
  const s = sessions.get(pid);
  if (!s) return;
  sessions.delete(pid);
  if (call && (call.peer === pid || (!call.peer && !anySecure()))) hangupLocal('ارتباط قطع شد');
  for (const [id, inc] of incoming) if (inc.from === pid) { failTransfer(inc.entry); incoming.delete(id); }
  wipe(s.root, s.sas, s.send?.ck);
  if (s.recv) for (const ch of s.recv.values()) wipe(ch.ck);
  if (s.skipped) for (const mk of s.skipped.values()) wipe(mk);
  s.rekeyPending = null;
  updatePresence();
}

async function endAllSessions() {
  for (const pid of [...sessions.keys()]) await endSession(pid);
  hangupLocal('');
}

// Switches the admin can flip; the relay sends them on connect.
let features = { gif: true, preview: true, calls: true };
function applyFeatures(f) {
  features = { gif: f?.gif !== false, preview: f?.preview !== false, calls: f?.calls !== false };
  $('gif-btn').hidden = !features.gif;
  $('call-btn').hidden = !features.calls;
  if (!features.preview) previewsOn = false;
  const pv = document.querySelector('#menu [data-act=preview]');
  if (pv) pv.hidden = !features.preview;
  $('preview-switch').classList.toggle('on', previewsOn);
}

function updatePresence() {
  const sec = secureSessions();
  if (sec.length) setStatus('secure', sec.length);
  else if ([...sessions.values()].some((x) => x.failed)) setStatus('failed');
  else if (sessions.size) setStatus('handshake');
  else if (ws && ws.readyState === 1) setStatus('waiting');
  $('call-btn').disabled = !sec.length || features.calls === false;
  $('peer-title').textContent = sec.length ? sec.map((x) => x.name || 'مخاطب').join(' · ') : 'مخاطب امن';
  document.body.classList.toggle('multi', knownNames.size > 1 || sessions.size > 1);
  if (!sec.length) $('typing').hidden = true;
}

function refreshSenderLabels() {
  for (const t of document.querySelectorAll('.msg .sender')) t.textContent = peerName(t.parentElement.dataset.from);
}

// ---------- message layer ----------
// Must run inside the serial queue.
async function sendInner(s, obj) {
  if (!s || !s.send || s.failed) throw new Error('no session');
  const ch = s.send;
  const e = s.sendEpoch;
  const n = ch.n;
  const mk = await hmac(ch.ck, ONE);
  const next = await hmac(ch.ck, TWO);
  wipe(ch.ck);
  ch.ck = next;
  ch.n++;
  const key = await subtle.importKey('raw', mk, 'AES-GCM', false, ['encrypt']);
  wipe(mk);
  const iv = rand(12);
  const ad = te.encode(`wn1|${s.role}|${e}|${n}`);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, pad(te.encode(JSON.stringify(obj)))));
  wireSend({ t: 'm', to: s.peer, e, n, iv: b64u(iv), c: b64u(ct) });
  s.epochMsgs++;
}

// Public send to every other device; resolves with the peer ids reached.
function post(obj) {
  return serial(async () => {
    const targets = secureSessions();
    if (!targets.length) throw new Error('not secure');
    for (const s of targets) {
      await sendInner(s, obj);
      await maybeRekey(s);
    }
    return targets.map((x) => x.peer);
  });
}

// Public send to one device.
function postTo(pid, obj) {
  return serial(async () => {
    const s = sessions.get(pid);
    if (!s?.secure) throw new Error('not secure');
    await sendInner(s, obj);
    await maybeRekey(s);
  });
}

async function onCipher(m) {
  const s = sessions.get(m.from);
  if (!s || !s.recv || s.failed) return;
  const peerRole = s.role === 'A' ? 'B' : 'A';
  let obj;
  try {
    if (!Number.isInteger(m.e) || !Number.isInteger(m.n) || m.n < 0) throw new Error('hdr');
    const ch = s.recv.get(m.e);
    if (!ch) throw new Error('epoch');
    let mk;
    let ck = ch.ck;
    let n = ch.n;
    const newSkipped = [];
    const sk = `${m.e}:${m.n}`;
    if (m.n < n) {
      mk = s.skipped.get(sk);
      if (!mk) throw new Error('replay');
    } else {
      if (m.n - n > MAX_SKIP) throw new Error('gap');
      while (n < m.n) {
        newSkipped.push([`${m.e}:${n}`, await hmac(ck, ONE)]);
        ck = await hmac(ck, TWO);
        n++;
      }
      mk = await hmac(ck, ONE);
      ck = await hmac(ck, TWO);
      n++;
    }
    const key = await subtle.importKey('raw', mk, 'AES-GCM', false, ['decrypt']);
    const ad = te.encode(`wn1|${peerRole}|${m.e}|${m.n}`);
    const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(m.iv), additionalData: ad }, key, unb64u(m.c)));
    obj = JSON.parse(td.decode(unpad(pt)));
    wipe(pt, mk);
    // Authentic: commit the chain advance.
    if (m.n < ch.n) {
      s.skipped.delete(sk);
    } else {
      wipe(ch.ck);
      ch.ck = ck;
      ch.n = n;
      for (const [k, v] of newSkipped) s.skipped.set(k, v);
      while (s.skipped.size > MAX_SKIP) {
        const [k, v] = s.skipped.entries().next().value;
        wipe(v);
        s.skipped.delete(k);
      }
    }
  } catch {
    if (!s.secure) failAuth(s);
    return; // forged, replayed or corrupted: drop silently
  }
  s.epochMsgs++;
  await onInner(s, obj);
  if (sessions.get(s.peer) === s) await maybeRekey(s);
}

async function onInner(s, o) {
  if (!o || typeof o.k !== 'string') return;
  const who = () => peerName(s.peer);
  switch (o.k) {
    case 'confirm':
      if (s.secure) return;
      s.secure = true;
      banner('');
      await sendInner(s, { k: 'hi', name: myName, dv: myDev, ty: matchMedia('(pointer: coarse)').matches ? 'm' : 'd' });
      updatePresence();
      await flushOutbox(s);
      break;
    case 'hi': {
      const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim().slice(0, 30) : '';
      s.name = name || (o.ty === 'm' ? 'موبایل' : 'کامپیوتر');
      s.dev = PID_RE.test(o.dv || '') ? o.dv : s.peer;
      knownNames.set(s.dev, s.name);
      knownNames.set(s.peer, s.name);
      updatePresence();
      refreshSenderLabels();
      if (secureSessions().length > 1) notice(`${s.name} هم به گفتگو وصل شد`);
      break;
    }
    case 'text': {
      if (typeof o.id !== 'string' || typeof o.body !== 'string') return;
      await sendInner(s, { k: 'ack', id: o.id });
      if (seen.has(o.id)) return;
      seen.set(o.id, Date.now() + 86400000);
      rememberName(o.a, o.an);
      renderText({ id: o.id, ts: o.ts, from: authorOf(s, o), body: o.body.slice(0, 4000), ttl: clampTtl(o.ttl), preview: sanitizePreview(o.preview), reply: sanitizeReply(o.reply) }, 'in');
      $('typing').hidden = true;
      bumpUnread();
      break;
    }
    case 'file':
      await onFileMeta(s, o);
      break;
    case 'ack': {
      const u = unacked.get(o.id);
      if (u) {
        u.acked.add(s.peer);
        if ([...u.targets].every((pid) => u.acked.has(pid))) unacked.delete(o.id);
      }
      const m = messages.get(o.id);
      if (m && m.dir === 'out') { m.el.classList.add('delivered'); setTick(m); if (m.stack) renderStack(m.stack); }
      break;
    }
    case 'read': {
      const m = messages.get(o.id);
      if (m && m.dir === 'out') {
        if (!m.expires && !m.kept && m.ttl) m.expires = Date.now() + lifeOf(m) * 1000;
        markOutRead(m, authorOf(s, o));
        tickTimers();
      }
      break;
    }
    case 'react': {
      if (!messages.has(o.id)) return;
      const a = authorOf(s, o);
      applyReaction({ target: o.id, a, an: o.an, e: o.e, t: o.t, ts: Date.now() }, false);
      if (o.e || o.t) bumpUnread();
      break;
    }
    case 'typing':
      $('typing').hidden = false;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { $('typing').hidden = true; }, 4000);
      break;
    case 'ttl':
      setTtl(clampTtl(o.v));
      notice(ttl ? `${who()} زمان حذف را روی «${ttlLabel(ttl)} پس از خواندن» گذاشت` : `${who()} حذف خودکار را خاموش کرد`);
      break;
    case 'del':
      if (Array.isArray(o.ids)) for (const id of o.ids.slice(0, 2000)) { const m = messages.get(id); if (m) removeEntry(m); }
      break;
    case 'clear':
      clearMessages();
      notice(`${who()} گفتگو را برای همه پاک کرد`);
      break;
    case 'saved': {
      const m = messages.get(o.id);
      const what = m?.kind === 'audio' ? `موزیک «${m.title}»` : m?.kind === 'video' ? 'یک ویدیو' : m?.kind === 'image' ? 'یک عکس' : 'یک مورد';
      notice(`${who()} ${what} را در دستگاه خود ماندگار کرد`, m?.kind === 'audio' ? '' : 'warn');
      break;
    }
    case 'shot':
      notice(`⚠ ${who()} احتمالاً از صفحه عکس گرفت`, 'warn');
      break;
    case 'rekey': {
      if (s.role !== 'B' || o.e !== s.sendEpoch + 1) return;
      const kp = await genKeyPair(s.curve);
      const shared = await ecdh(s.curve, kp.priv, unb64u(o.pub));
      await sendInner(s, { k: 'rekey-ack', e: o.e, pub: b64u(kp.pub) });
      await ratchet(s, shared, o.e);
      break;
    }
    case 'rekey-ack': {
      const p = s.rekeyPending;
      if (s.role !== 'A' || !p || o.e !== p.e) return;
      s.rekeyPending = null;
      const shared = await ecdh(s.curve, p.kp.priv, unb64u(o.pub));
      await ratchet(s, shared, o.e);
      break;
    }
    case 'call':
      await onCallSignal(s, o);
      break;
  }
}

async function ratchet(s, shared, epoch) {
  const root = await hkdf(shared, s.root, 'wn1/ratchet/' + epoch);
  wipe(shared, s.root);
  s.root = root;
  s.rekeys++;
  await installChains(s, epoch);
}

async function maybeRekey(s) {
  if (!s?.secure || s.role !== 'A' || s.rekeyPending) return;
  if (s.epochMsgs < REKEY_MESSAGES && Date.now() - s.epochStart < REKEY_MS) return;
  const kp = await genKeyPair(s.curve);
  s.rekeyPending = { e: s.sendEpoch + 1, kp };
  await sendInner(s, { k: 'rekey', e: s.rekeyPending.e, pub: b64u(kp.pub) });
}

async function flushOutbox(s) {
  // Resend what this device never acknowledged, then whatever was queued.
  for (const u of unacked.values()) if (u.targets.has(s.peer) && !u.acked.has(s.peer)) await sendInner(s, u.msg);
  while (outbox.length) {
    const m = outbox.shift();
    const entry = messages.get(m.id);
    if (!entry) continue;
    unacked.set(m.id, { msg: m, targets: new Set([s.peer]), acked: new Set() });
    entry.el.classList.remove('queued');
    setTick(entry);
    await sendInner(s, m);
  }
  // Read receipts for anything already on screen.
  checkReads();
}

// ---------- icons & small DOM helpers ----------
function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `i ${cls}`.trim());
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function fmtSize(n) {
  if (n < 1024) return `${fa(n)} بایت`;
  if (n < 1048576) return `${fa((n / 1024).toFixed(0))} کیلوبایت`;
  return `${fa((n / 1048576).toFixed(1))} مگابایت`;
}
function fmtDuration(s) {
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function clampTtl(v) { return TTLS.includes(v) ? v : 0; }
function ttlLabel(v) {
  return { 0: 'بدون حذف', 10: '۱۰ ثانیه', 30: '۳۰ ثانیه', 60: '۱ دقیقه', 300: '۵ دقیقه', 1800: '۳۰ دقیقه', 3600: '۱ ساعت' }[v];
}
function setTtl(v) {
  ttl = v;
  $('ttl-label').textContent = ttlLabel(v);
  for (const b of $('ttl-menu').querySelectorAll('button')) b.classList.toggle('active', Number(b.dataset.ttl) === v);
}

// ---------- message entries ----------
// entry: { id, dir, kind, el, content, timerEl, tickEl, reactEl, ttl,
//          expires (null until read), url, preview, snippet, react, acts, ready }
// When the message was really sent (the sender's clock, or the server's for
// history), not when it reached this screen. Never in the future.
function sentAt(t) {
  return Number.isFinite(t) && t > 1.6e12 ? Math.min(t, Date.now()) : Date.now();
}
function fmtSentAt(t) {
  const d = new Date(t);
  const time = d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('fa-IR', { day: 'numeric', month: 'long' })} ${time}`;
}

function createEntry({ id, dir, ttl: life, kind, snippet, from, ts }) {
  const li = el('li', `msg ${dir}`);
  const content = el('div', 'content');
  const meta = el('div', 'meta');
  const at = sentAt(ts);
  const time = el('span', 'time', fmtSentAt(at));
  time.title = new Date(at).toLocaleString('fa-IR', { dateStyle: 'full', timeStyle: 'short' });
  const timer = el('span', 'timer');
  meta.append(timer, time);
  let tick = null;
  let readLabel = null;
  if (dir === 'out') {
    readLabel = el('span', 'read-label', 'خوانده شد');
    tick = el('span', 'tick');
    meta.append(readLabel, tick);
  }
  // Confidential mode: one tap shows this message for 10 seconds.
  const eye = el('button', 'peek-btn');
  eye.type = 'button';
  eye.setAttribute('aria-label', 'نمایش موقت پیام');
  eye.append(icon('eye'));
  eye.onclick = (e) => {
    e.stopPropagation();
    clearTimeout(li._reveal);
    const on = !li.classList.contains('reveal');
    li.classList.toggle('reveal', on);
    eye.firstChild.querySelector('use').setAttribute('href', on ? '#i-eye-off' : '#i-eye');
    if (on) li._reveal = setTimeout(() => { li.classList.remove('reveal'); eye.firstChild.querySelector('use').setAttribute('href', '#i-eye'); }, 10000);
  };
  meta.prepend(eye);
  const reactBtn = el('button', 'react-btn');
  reactBtn.type = 'button';
  reactBtn.setAttribute('aria-label', 'واکنش');
  reactBtn.append(icon('react'));
  const reacts = el('div', 'reacts');
  reacts.hidden = true;
  li.append(content, meta, reacts, reactBtn);
  if (dir === 'in' && from) {
    li.dataset.from = from;
    li.prepend(el('div', 'sender', peerName(from))); // shown when 3 devices share the room
  }

  const entry = {
    id, dir, kind, el: li, content, timerEl: timer, tickEl: tick, readEl: readLabel, readBy: new Set(), ts: at, reactEl: reacts, ttl: life,
    expires: null, url: null, preview: null, snippet: snippet || '', ready: true,
    from: from || null, react: { me: null, peers: {} }, reply: { me: '', peers: {} }, acts: {},
  };
  messages.set(id, entry);
  li._entry = entry;

  reactBtn.onclick = (e) => { e.stopPropagation(); openReactBar(entry); };
  reacts.onclick = (e) => { e.stopPropagation(); openReactBar(entry); };
  li.addEventListener('dblclick', (e) => {
    if (Date.now() - lastTouchTapAt < 800) return; // handled by the touch double-tap
    if (e.target.closest('.media-wrap, .ig-card, .react-btn, .gif-mini, .voice-msg, .quote')) return;
    setReaction(entry, entry.react.me === '❤️' ? null : '❤️');
  });
  entry.heart = () => setReaction(entry, entry.react.me === '❤️' ? null : '❤️');
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!e.target.closest('.media-wrap')) openReactBar(entry); });
  bindLongPress(li, () => openReactBar(entry));

  const list = $('messages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  if (insertAnchor) list.insertBefore(li, insertAnchor); else list.append(li);
  $('empty-state').hidden = true;
  if (!insertAnchor && (atBottom || dir === 'out')) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  else if (!insertAnchor && dir === 'in') { newBelow++; updateToBottom(); }
  if (dir === 'out') setTick(entry);
  renderTimer(entry);
  return entry;
}

// "Go to the latest message" button, shown once scrolled up; counts what
// arrived meanwhile.
let newBelow = 0;
function updateToBottom() {
  const list = $('messages');
  const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
  const far = gap > 300;
  if (gap < 120) newBelow = 0;
  $('to-bottom').hidden = !far && !newBelow;
  const n = $('to-bottom-n');
  n.hidden = !newBelow;
  n.textContent = fa(newBelow);
}

function bindLongPress(target, fn) {
  let t = null;
  target.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('.media-wrap')) return;
    t = setTimeout(() => { t = null; navigator.vibrate?.(10); fn(); }, 450);
  });
  const cancel = () => { clearTimeout(t); t = null; };
  target.addEventListener('pointerup', cancel);
  target.addEventListener('pointermove', cancel);
  target.addEventListener('pointercancel', cancel);
}

function markOutRead(m, reader) {
  if (reader) m.readBy.add(reader);
  m.el.classList.add('read', 'delivered');
  showReaders(m);
  setTick(m);
  if (m.stack) renderStack(m.stack);
}

// Read receipts are also kept (encrypted, batched) in the room history, so a
// sender who was offline when the message was read still sees it.
const readQueue = new Set();
let readFlush = 0;
function queueSeen(id) {
  readQueue.add(id);
  clearTimeout(readFlush);
  readFlush = setTimeout(() => {
    const ids = [...readQueue].slice(0, 200);
    for (const x of ids) readQueue.delete(x);
    if (ids.length && room?.histKey) storeEvent({ k: 'seen', id: b64u(rand(12)), ids, a: myDev, an: myName }).catch(() => {});
    if (readQueue.size) queueSeen([...readQueue][0]);
  }, 1500);
}
const pendingSeen = new Map(); // message id -> readers, for messages not loaded yet
const seenByMe = new Set();    // messages this device already reported as read
function applySeen(ev) {
  if (!Array.isArray(ev.ids) || !PID_RE.test(ev.a || '')) return;
  if (ev.a === myDev) {
    for (const id of ev.ids.slice(0, 200)) {
      const m = messages.get(id);
      if (m?.dir === 'in') { m.readSent = true; visibleUnread.delete(m); } else if (typeof id === 'string') seenByMe.add(id);
    }
    return;
  }
  rememberName(ev.a, ev.an);
  for (const id of ev.ids.slice(0, 200)) {
    if (typeof id !== 'string') continue;
    const m = messages.get(id);
    if (m) { if (m.dir === 'out') markOutRead(m, ev.a); continue; }
    if (!pendingSeen.has(id)) pendingSeen.set(id, new Set());
    pendingSeen.get(id).add(ev.a);
  }
}

// "Read" next to a sent message; with 3 devices, who has read it.
function showReaders(entry) {
  if (!entry.readEl) return;
  const names = [...entry.readBy].filter(Boolean).map(peerName);
  entry.readEl.title = names.length ? `خوانده شد توسط: ${names.join('، ')}` : '';
  entry.readEl.textContent = names.length > 1 ? `خوانده شد (${fa(names.length)})` : 'خوانده شد';
}

function setTick(entry) {
  if (!entry.tickEl) return;
  const c = entry.el.classList;
  entry.tickEl.textContent = '';
  entry.tickEl.append(icon(c.contains('queued') ? 'clock' : c.contains('delivered') || c.contains('read') ? 'checks' : 'check'));
}

function renderTimer(entry) {
  const t = entry.timerEl;
  t.textContent = '';
  t.hidden = !entry.ttl && !entry.kept;
  if (t.hidden) return;
  if (entry.kept) {
    t.classList.remove('waiting');
    t.classList.add('kept');
    t.append(icon('pin'), document.createTextNode('ماندگار'));
    return;
  }
  t.classList.remove('kept');
  if (!entry.expires) {
    t.classList.add('waiting');
    t.append(icon('timer'), document.createTextNode(fmtDuration(entry.ttl)));
    return;
  }
  t.classList.remove('waiting');
  const left = Math.max(0, Math.ceil((entry.expires - Date.now()) / 1000));
  t.append(icon('timer'), document.createTextNode(fmtDuration(left)));
}

function tickTimers() {
  const now = Date.now();
  for (const entry of [...messages.values()]) {
    if (entry.expires && entry.expires <= now) removeEntry(entry);
    else if (entry.expires) renderTimer(entry);
  }
  for (const s of stacks) updateStackTimer(s);
  for (const [id, exp] of seen) if (exp < now) seen.delete(id);
  // A transfer that stopped (the sender went away or failed) must not spin forever.
  for (const [id, inc] of incoming) if (now - inc.lastAt > 60000) { failTransfer(inc.entry); incoming.delete(id); }
}

function removeEntry(entry) {
  if (player.cur?.key === 'm:' + entry.id) stopPlayer();
  if (voice.entry === entry) stopVoice();
  if (entry.wavUrl) URL.revokeObjectURL(entry.wavUrl);
  messages.delete(entry.id);
  unacked.delete(entry.id);
  readObserver.unobserve(entry.el);
  visibleUnread.delete(entry);
  for (const a of Object.values(entry.acts)) if (a) removeAct(a);
  if (entry.url) URL.revokeObjectURL(entry.url);
  entry.content.textContent = '';
  entry.el.remove();
  if (entry.stack) {
    const s = entry.stack;
    s.members = s.members.filter((m) => m !== entry);
    renderStack(s);
  }
  if (igModal) renderIgModal();
  if (!messages.size) $('empty-state').hidden = false;
}

function clearMessages() {
  for (const entry of [...messages.values()]) removeEntry(entry);
  outbox.length = 0;
  $('messages').textContent = '';
  $('empty-state').hidden = false;
}

// Read receipts: an incoming message counts as read once it is on screen while
// the window is visible and focused. Only then do both timers start.
const visibleUnread = new Set();
const readObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const stack = e.target._stack;
    if (stack) stack.visible = e.isIntersecting;
    const list = stack ? stack.members.filter((m) => m.dir === 'in') : [messages.get(e.target.dataset.id)];
    for (const entry of list) {
      if (!entry) continue;
      if (e.isIntersecting) visibleUnread.add(entry); else visibleUnread.delete(entry);
    }
  }
  checkReads();
}, { threshold: 0.5 });

function canSee() { return !document.hidden && document.hasFocus() && !shieldOn && !locked; }

function checkReads() {
  if (!canSee()) return;
  for (const entry of visibleUnread) {
    if (entry.expires || entry.readSent || !entry.ready || entry.awaitPlay) continue;
    markRead(entry);
  }
}

// Seconds a message stays after it is read. A voice message lives at least as
// long as it takes to listen to it (both ends and the server use this).
function lifeOf(entry) {
  return entry.kind === 'voice' ? Math.max(entry.ttl, (entry.voiceDur || 0) + 5) : entry.ttl;
}
// What the server is told: rounded up to one of the standard timer values, so
// a voice message's expiry does not reveal its length (it only lingers longer).
function serverLifeOf(entry) {
  const s = lifeOf(entry);
  return TTLS.find((t) => t >= s) || TTLS[TTLS.length - 1];
}

function markRead(entry) {
  entry.readSent = true;
  if (!entry.kept && entry.ttl) {
    entry.expires = Date.now() + lifeOf(entry) * 1000;
    storeExp(entry.id, Date.now() + serverLifeOf(entry) * 1000); // the server deletes it then, for everyone
  }
  visibleUnread.delete(entry);
  if (!entry.stack) readObserver.unobserve(entry.el);
  renderTimer(entry);
  if (entry.stack) renderStack(entry.stack);
  if (anySecure()) post({ k: 'read', id: entry.id }).catch(() => {});
  if (entry.dir === 'in') queueSeen(entry.id);
}

function watchRead(entry) {
  entry.el.dataset.id = entry.id;
  readObserver.observe(entry.el);
}

function bumpUnread(kind = 'msg') {
  if (!canSee()) { unread++; updateTitle(); notify(kind); }
}

// ---------- notifications ----------
// Optional, off by default. Never shows content or names: only that something
// arrived. Works while the page is open (also in the background); nothing is
// sent through any push service.
let notifyOn = (() => { try { return localStorage.getItem('najva:notify') === '1'; } catch { return false; } })();
let notifyAt = 0;
let swReg = null;
function applyNotifyUi() { $('notify-switch').classList.toggle('on', notifyOn && notifyAllowed()); }
const notifyAllowed = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';
function initNotify() {
  // Phones only show notifications through a service worker (sw.js: shows
  // them and focuses the chat on tap, nothing else).
  if (notifyOn && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; }).catch(() => {});
  // Sound needs a real tap first (mobile browsers). The first tap of this visit
  // makes the audio context, so a notification can chime afterwards.
  if (notifyOn) for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, makeSoundCtx, { once: true, capture: true });
  applyNotifyUi();
}
async function toggleNotify() {
  if (notifyOn) {
    notifyOn = false;
  } else {
    if (typeof Notification === 'undefined') { toast('این مرورگر اعلان ندارد'); return; }
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (p !== 'granted') { toast('اجازه‌ی اعلان داده نشد؛ از تنظیمات مرورگر برای این سایت فعالش کنید'); applyNotifyUi(); return; }
    notifyOn = true;
    makeSoundCtx(); // inside the tap: browsers only allow sound from a real tap
    playChime(); // a short sample, so you can hear right away that it works
  }
  try { localStorage.setItem('najva:notify', notifyOn ? '1' : '0'); } catch {}
  initNotify();
  toast(notifyOn ? 'اعلان روشن شد: وقتی سایت باز است ولی جلوی چشمتان نیست، خبر می‌دهد (بدون متن پیام)' : 'اعلان خاموش شد');
}
function notify(kind) {
  if (!notifyOn || !notifyAllowed()) return;
  const now = Date.now();
  if (kind !== 'call' && now - notifyAt < 4000) return; // a burst is one notification
  notifyAt = now;
  const title = kind === 'call' ? 'تماس صوتی' : 'نجوا';
  const body = kind === 'call' ? 'کسی تماس گرفته' : unread > 1 ? `${fa(unread)} پیام جدید` : 'پیام جدید';
  // A call already rings (ring()), so only messages get the extra chime. When
  // the chime really plays, the system sound is skipped so it never doubles.
  const chimed = kind !== 'call' && playChime();
  const opts = { body, tag: kind === 'call' ? 'najva-call' : 'najva', renotify: true, icon: '/favicon.svg', lang: 'fa', dir: 'rtl', silent: chimed };
  if (swReg) swReg.showNotification(title, opts).catch(() => {});
  else { try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); n.close(); }; } catch {} }
}

// Sound for message notifications: a short two-tone chime built with Web Audio,
// so no file is downloaded and nothing leaves the device. Browsers only let a
// page make sound after a real tap, so the context is made on the first tap of
// the visit (see initNotify) and reused after that.
let soundCtx = null;
function makeSoundCtx() { soundCtx ??= newAudioContext(); return soundCtx; }
function playChime() {
  try {
    const ctx = soundCtx;
    if (!ctx || ctx.state === 'suspended') return false;
    const at = ctx.currentTime;
    for (const [f, t, d] of [[880, 0, 0.16], [1174.66, 0.17, 0.26]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at + t);
      g.gain.exponentialRampToValueAtTime(0.12, at + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + t + d);
      o.connect(g).connect(ctx.destination);
      o.start(at + t);
      o.stop(at + t + d + 0.05);
    }
    return true;
  } catch { return false; }
}

// ---------- text & instagram ----------
function isEmojiOnly(s) {
  return s.length <= 16 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(s) && !/^[\d#*\s]+$/.test(s);
}

// ---------- replies ----------
// A reply carries a short quote of the original inside the encrypted message
// itself, so the quote travels and is stored end-to-end encrypted like the rest.
let replyTo = null;

function quoteOf(entry) {
  const what = {
    ig: 'پست اینستاگرام', image: 'عکس', gif: 'گیف', video: 'ویدیو',
    audio: `موزیک «${entry.title || ''}»`, file: `فایل «${entry.snippet || ''}»`,
    voice: `پیام صوتی (${fmtDuration(entry.voiceDur || 0)})`,
  }[entry.kind];
  return (what || entry.snippet || '').slice(0, 80);
}

function setReplyTo(entry) {
  replyTo = { id: entry.id, a: entry.dir === 'out' ? myDev : entry.from, s: quoteOf(entry), k: entry.kind };
  const bar = $('reply-bar');
  bar.textContent = '';
  const box = el('div', 'reply-info');
  box.append(el('div', 'reply-who', `پاسخ به ${replyTo.a === myDev ? 'خودتان' : peerName(replyTo.a)}`), el('div', 'reply-snip', replyTo.s));
  const x = el('button', 'btn-icon sm');
  x.type = 'button';
  x.setAttribute('aria-label', 'لغو پاسخ');
  x.append(icon('x'));
  x.onclick = clearReply;
  bar.append(icon('reply'), box, x);
  bar.hidden = false;
  $('input').focus();
}

function clearReply() {
  replyTo = null;
  $('reply-bar').hidden = true;
}

function sanitizeReply(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || r.id.length > 32) return null;
  return {
    id: r.id,
    a: PID_RE.test(r.a || '') ? r.a : null,
    s: typeof r.s === 'string' ? r.s.slice(0, 120) : '',
    k: typeof r.k === 'string' ? r.k.slice(0, 10) : 'text',
  };
}

function quoteBlock(r) {
  const q = el('div', 'quote');
  q.append(el('div', 'quote-who', r.a === myDev ? 'شما' : r.a ? peerName(r.a) : 'پیام'), el('div', 'quote-text body-like', r.s || '…'));
  q.onclick = (e) => {
    e.stopPropagation();
    const m = messages.get(r.id);
    if (m) focusMessage(m); else toast('پیام اصلی دیگر موجود نیست');
  };
  return q;
}

function renderText(msg, dir) {
  const prev = msg.preview && !insertAnchor ? lastRealItem() : null;
  const entry = createEntry({ from: msg.from, id: msg.id, ts: msg.ts, dir, ttl: msg.ttl, kind: msg.preview ? 'ig' : 'text', snippet: msg.body.slice(0, 40) });
  entry.preview = msg.preview || null;
  const body = msg.body;
  if (msg.reply) { entry.quote = msg.reply; entry.content.append(quoteBlock(msg.reply)); } // entry.reply holds reaction replies
  if (msg.preview) {
    entry.el.classList.add('media');
    const card = igCard(msg.preview);
    card.onclick = (e) => { e.preventDefault(); openIgModal([entry], 0); };
    entry.igTitleEl = card.querySelector('.ig-title');
    entry.content.append(card);
    entry.note = body.replace(IG_LINK_RE, '').trim();
    if (entry.note) entry.content.append(el('div', 'body', entry.note));
    if (placeIgEntry(entry, prev)) return entry;
    entry.el._igEntry = entry;
  } else if (isEmojiOnly(body)) {
    entry.el.classList.add('big-emoji');
    entry.content.append(el('div', 'body big', body));
  } else {
    entry.content.append(el('div', 'body', body));
  }
  if (dir === 'in') watchRead(entry);
  return entry;
}

// ---------- instagram stacks ----------
// Instagram posts sent back to back (only reactions or notices in between)
// merge into one stacked card instead of filling the chat.
const stacks = new Set();

function lastRealItem() {
  let n = $('messages').lastElementChild;
  while (n && (n.classList.contains('act-run') || n.classList.contains('notice'))) n = n.previousElementSibling;
  return n;
}

function placeIgEntry(entry, prev) {
  if (prev?._stack && prev._stack.dir === entry.dir) {
    addToStack(prev._stack, entry, true);
    return true;
  }
  const first = prev?._igEntry;
  if (first && first.dir === entry.dir && messages.has(first.id) && !first.stack) {
    const stack = makeStack(entry.dir);
    prev.replaceWith(stack.el);
    readObserver.unobserve(first.el);
    visibleUnread.delete(first);
    addToStack(stack, first, false);
    addToStack(stack, entry, true);
    readObserver.observe(stack.el);
    return true;
  }
  return false;
}

function makeStack(dir) {
  const li = el('li', `msg ${dir} media ig-stack`);
  const stack = { dir, el: li, members: [], visible: false };
  li._stack = stack;
  li.onclick = () => {
    const firstNew = stack.members.findIndex((m) => !m.react.me && !m.reply.me && m.dir === 'in');
    openIgModal(stack.members, firstNew >= 0 ? firstNew : stack.members.length - 1, stack);
  };
  bindLongPress(li, () => li.onclick());
  stacks.add(stack);
  return stack;
}

function addToStack(stack, entry, moveToEnd) {
  stack.members.push(entry);
  entry.stack = stack;
  entry.el.remove();
  if (moveToEnd) {
    const list = $('messages');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
    list.append(stack.el);
    if (atBottom || entry.dir === 'out') requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  if (stack.visible && entry.dir === 'in') { visibleUnread.add(entry); checkReads(); }
  renderStack(stack);
  if (igModal?.stack === stack) renderIgModal();
}

function renderStack(stack) {
  const { members, el: li } = stack;
  if (!members.length) { li.remove(); stacks.delete(stack); readObserver.unobserve(li); return; }
  li.textContent = '';
  const cards = el('div', 'stack-cards');
  for (const m of members.slice(-3)) {
    const c = el('div', 'stack-card');
    if (m.preview.img) {
      const img = new Image();
      img.src = m.preview.img;
      img.alt = '';
      img.draggable = false;
      c.append(img);
    } else {
      c.append(icon('insta'));
    }
    cards.append(c);
  }
  const top = members[members.length - 1];
  if (top.preview.kind === 'reel' || top.preview.kind === 'tv') {
    const play = el('span', 'ig-play');
    play.append(icon('play'));
    cards.append(play);
  }
  const count = el('span', 'stack-count', fa(members.length));
  cards.append(count);

  const info = el('div', 'stack-info');
  const brand = el('div', 'ig-brand');
  brand.append(icon('insta'), document.createTextNode(`${fa(members.length)} پست اینستاگرام`));
  const pending = members.filter((m) => m.dir === 'in' && !m.react.me && !m.reply.me).length;
  const sub = el('div', 'stack-sub', stack.dir === 'in' && pending ? `${fa(pending)} پست بدون ری‌اکشن شما · بزنید` : 'برای دیدن و ری‌اکشن بزنید');
  info.append(brand, sub);

  const meta = el('div', 'meta');
  const timer = el('span', 'timer');
  stack.timerEl = timer;
  updateStackTimer(stack);
  meta.append(timer);
  if (stack.dir === 'out') {
    const tick = el('span', 'tick');
    const all = (c) => members.every((m) => m.el.classList.contains(c));
    li.classList.toggle('read', all('read'));
    tick.append(icon(members.some((m) => m.el.classList.contains('queued')) ? 'clock' : all('delivered') || all('read') ? 'checks' : 'check'));
    meta.append(tick);
  }

  const emojis = members.flatMap((m) => reactionList(m));
  li.append(cards, info, meta);
  if (emojis.length) {
    const r = el('div', 'reacts');
    const uniq = [...new Set(emojis)].slice(0, 3);
    for (const e of uniq) r.append(el('span', '', e));
    if (emojis.length > 1) r.append(el('span', 'count', fa(emojis.length)));
    li.append(r);
    li.classList.add('has-reacts');
  } else {
    li.classList.remove('has-reacts');
  }
}

function updateStackTimer(stack) {
  const t = stack.timerEl;
  if (!t || !stack.members.length) return;
  const live = stack.members.filter((m) => m.expires);
  t.textContent = '';
  t.classList.toggle('waiting', !live.length);
  const secs = live.length
    ? Math.max(0, Math.ceil((Math.min(...live.map((m) => m.expires)) - Date.now()) / 1000))
    : stack.members[stack.members.length - 1].ttl;
  t.append(icon('timer'), document.createTextNode(fmtDuration(secs)));
}

// ---------- instagram modal ----------
let igModal = null; // { list, index, stack }

function openIgModal(list, index, stack = null) {
  closePanels();
  igModal = { list, index, stack };
  $('ig-modal').hidden = false;
  renderIgModal();
}

function closeIgModal() {
  igModal = null;
  $('ig-modal').hidden = true;
}

function renderIgModal() {
  if (!igModal) return;
  const live = (igModal.stack ? igModal.stack.members : igModal.list).filter((m) => messages.has(m.id));
  if (!live.length) { closeIgModal(); return; }
  const cur = igModal.list[igModal.index];
  igModal.list = live;
  igModal.index = Math.max(0, Math.min(live.length - 1, live.indexOf(cur) >= 0 ? live.indexOf(cur) : igModal.index));
  const entry = live[igModal.index];
  const p = entry.preview;

  const media = $('igm-media');
  media.textContent = '';
  if (p.img) {
    const img = new Image();
    img.src = p.img;
    img.alt = '';
    img.draggable = false;
    media.append(img);
  } else {
    media.append(icon('insta'));
  }
  if (p.kind === 'reel' || p.kind === 'tv') {
    const play = el('span', 'ig-play');
    play.append(icon('play'));
    media.append(play);
  }
  $('igm-kind').textContent = `Instagram · ${{ reel: 'ریلز', tv: 'ویدیو', p: 'پست' }[p.kind] || 'پست'}`;
  $('igm-from').textContent = entry.dir === 'in' ? 'فرستاده‌ی مخاطب' : 'فرستاده‌ی شما';
  const hasReplies = replyLines(entry).length > 0;
  $('igm-title').hidden = hasReplies;
  $('igm-title').textContent = p.title || 'پست اینستاگرام';
  $('igm-replies').hidden = !hasReplies;
  fillReplies($('igm-replies'), entry);
  if (igModal.shownId !== entry.id) {
    igModal.shownId = entry.id;
    $('igm-text').value = '';
    $('igm-text').placeholder = entry.reply.me ? 'ویرایش پاسخ شما…' : 'یک پیام هم بنویسید (اختیاری)…';
  }
  $('igm-note').hidden = !entry.note;
  $('igm-note').textContent = entry.note || '';
  $('igm-open').href = p.url;

  const row = $('igm-reacts');
  row.textContent = '';
  for (const e of REACTIONS) {
    const b = el('button', entry.react.me === e ? 'mine' : '', e);
    b.type = 'button';
    b.onclick = () => {
      setReaction(entry, entry.react.me === e ? null : e);
      renderIgModal();
    };
    row.append(b);
  }
  const others = Object.entries(entry.react.peers).filter(([pid, e]) => e && !entry.reply.peers[pid]);
  $('igm-peer').hidden = !others.length;
  $('igm-peer').textContent = others.map(([pid, e]) => `ری‌اکشن ${peerName(pid)}: ${e}`).join('   ·   ');

  const many = live.length > 1;
  $('igm-nav').hidden = !many;
  $('igm-count').textContent = `${fa(igModal.index + 1)} از ${fa(live.length)}`;
  $('igm-prev').disabled = igModal.index === 0;
  $('igm-next').disabled = igModal.index === live.length - 1;
  const dots = $('igm-dots');
  dots.textContent = '';
  if (many && live.length <= 12) for (let i = 0; i < live.length; i++) dots.append(el('i', i === igModal.index ? 'on' : live[i].react.me || live[i].reply.me ? 'done' : ''));
}

function igStep(d) {
  if (!igModal) return;
  const i = igModal.index + d;
  if (i < 0 || i >= igModal.list.length) return;
  igModal.index = i;
  renderIgModal();
}

function igCard(p) {
  const a = el('a', 'ig-card');
  a.href = p.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const thumb = el('div', 'ig-thumb');
  if (p.img) {
    const img = new Image();
    img.src = p.img;
    img.alt = '';
    img.draggable = false;
    thumb.append(img);
  } else {
    thumb.append(icon('insta'));
  }
  if (p.kind === 'reel' || p.kind === 'tv') {
    const play = el('span', 'ig-play');
    play.append(icon('play'));
    thumb.append(play);
  }
  const info = el('div', 'ig-info');
  const brand = el('div', 'ig-brand');
  brand.append(icon('insta'), document.createTextNode(`Instagram · ${{ reel: 'ریلز', tv: 'ویدیو', p: 'پست' }[p.kind] || 'پست'}`));
  info.append(brand, el('div', 'ig-title', p.title || 'مشاهده در اینستاگرام'));
  a.append(thumb, info);
  return a;
}

function sanitizePreview(p) {
  if (!p || typeof p !== 'object' || typeof p.url !== 'string' || !IG_CANON_RE.test(p.url)) return null;
  const img = typeof p.img === 'string' && p.img.startsWith('data:image/jpeg;base64,') && p.img.length < 400000 ? p.img : null;
  return {
    url: p.url,
    kind: ['p', 'reel', 'tv'].includes(p.kind) ? p.kind : 'p',
    title: typeof p.title === 'string' ? p.title.slice(0, 300) : '',
    img,
  };
}

function canonicalIg(link) {
  const m = IG_PATH_RE.exec(link);
  if (!m) return null;
  const kind = m[1] === 'reels' ? 'reel' : m[1];
  return { url: `https://www.instagram.com/${kind}/${m[2]}/`, kind, title: '', img: null };
}

async function fetchPreview(link) {
  try {
    const r = await fetch('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ u: link }),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const img = j.image ? await shrinkImage(j.image, 520, 0.72) : null;
    return sanitizePreview({ url: j.url, kind: j.kind, title: j.title, img });
  } catch {
    return null;
  }
}

async function shrinkImage(src, max, quality) {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
}

async function sendText() {
  const input = $('input');
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  textSentAt = Date.now();
  autoGrow();
  closePanels();
  let preview = null;
  const link = IG_LINK_RE.exec(body)?.[0];
  if (link) {
    if (previewsOn) {
      hint('در حال آماده‌سازی پیش‌نمایش اینستاگرام…');
      preview = await fetchPreview(link);
      hint('');
    }
    preview = preview || canonicalIg(link);
  }
  const msg = { k: 'text', id: b64u(rand(9)), body, ttl, ts: Date.now(), preview, a: myDev, an: myName };
  if (replyTo) { msg.reply = replyTo; clearReply(); }
  const entry = renderText(msg, 'out');
  seen.set(msg.id, Date.now() + 86400000);
  entry.el.classList.add('queued');
  setTick(entry);
  storeEvent(msg)
    .then(() => { entry.stored = true; entry.el.classList.remove('queued'); setTick(entry); })
    .catch(() => toast('ذخیره‌ی پیام روی سرور انجام نشد'));
  if (anySecure()) {
    unacked.set(msg.id, { msg, targets: new Set(secureSessions().map((x) => x.peer)), acked: new Set() });
    post(msg).catch(() => {});
  } else {
    outbox.push(msg);
    entry.el.classList.add('queued');
    setTick(entry);
  }
}

// ---------- reactions ----------
function openReactBar(entry) {
  const bar = $('react-bar');
  bar.textContent = '';
  for (const e of REACTIONS) {
    const b = el('button', entry.react.me === e ? 'mine' : '', e);
    b.type = 'button';
    b.onclick = (ev) => { ev.stopPropagation(); setReaction(entry, entry.react.me === e ? null : e); bar.hidden = true; };
    bar.append(b);
  }
  const rb = el('button', 'reply-btn');
  rb.type = 'button';
  rb.setAttribute('aria-label', 'پاسخ');
  rb.append(icon('reply'));
  rb.onclick = (ev) => { ev.stopPropagation(); bar.hidden = true; setReplyTo(entry); };
  bar.append(rb);
  bar.hidden = false;
  const r = entry.el.getBoundingClientRect();
  const w = bar.offsetWidth;
  const top = r.top - bar.offsetHeight - 8 < 70 ? r.bottom + 8 : r.top - bar.offsetHeight - 8;
  bar.style.top = `${top}px`;
  bar.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
}

function setReaction(entry, e, text) {
  entry.react.me = e;
  if (text !== undefined) entry.reply.me = text.trim().slice(0, 500);
  entry.reactTs = { ...(entry.reactTs || {}), [myDev]: Date.now() };
  renderReacts(entry);
  if (entry.stack) renderStack(entry.stack);
  if (entry.preview) updateIgCaption(entry);
  activity('me', entry);
  if (anySecure()) post({ k: 'react', id: entry.id, e, t: entry.reply.me, a: myDev, an: myName }).catch(() => {});
  storeEvent({ k: 'react', id: b64u(rand(12)), target: entry.id, a: myDev, an: myName, e, t: entry.reply.me }).catch(() => {});
  return true;
}

// A written reply to an Instagram post replaces the post caption in previews.
function replyLines(entry) {
  const out = Object.entries(entry.reply.peers).filter(([, t]) => t)
    .map(([pid, t]) => ({ who: peerName(pid), e: entry.react.peers[pid] || '💬', t }));
  if (entry.reply.me) out.push({ who: 'شما', e: entry.react.me || '💬', t: entry.reply.me });
  return out;
}

const reactionList = (entry) => [...Object.values(entry.react.peers), entry.react.me].filter(Boolean);

function fillReplies(box, entry) {
  box.textContent = '';
  for (const r of replyLines(entry)) {
    const line = el('div', 'ig-reply');
    line.append(el('span', 'who', r.who), el('span', 'emo', r.e), el('span', 'txt', r.t));
    box.append(line);
  }
}

function updateIgCaption(entry) {
  const t = entry.igTitleEl;
  if (!t) return;
  if (replyLines(entry).length) {
    t.classList.add('has-replies');
    fillReplies(t, entry);
  } else {
    t.classList.remove('has-replies');
    t.textContent = entry.preview.title || 'مشاهده در اینستاگرام';
  }
}

function renderReacts(entry) {
  const list = reactionList(entry);
  const r = entry.reactEl;
  r.textContent = '';
  if (!list.length) { r.hidden = true; entry.el.classList.remove('has-reacts'); return; }
  for (const e of [...new Set(list)].slice(0, 3)) r.append(el('span', '', e));
  if (list.length > 1) r.append(el('span', 'count', fa(list.length)));
  r.hidden = false;
  entry.el.classList.add('has-reacts');
}

// Reaction activity lines. Three or more in a row collapse into one summary
// row so a burst of reactions to Instagram posts doesn't flood the chat.
function activity(actor, entry) {
  if (entry.acts[actor]) { removeAct(entry.acts[actor]); entry.acts[actor] = null; }
  const e = actor === 'me' ? entry.react.me : entry.react.peers[actor];
  const text = actor === 'me' ? entry.reply.me : entry.reply.peers[actor];
  if (!e && !text) return;
  const a = el('div', 'act');
  const mini = el('span', 'mini');
  if (entry.preview?.img) {
    const img = new Image();
    img.src = entry.preview.img;
    img.className = 'mini';
    img.alt = '';
    a.append(img);
  } else {
    mini.append(icon({ image: 'image', gif: 'image', video: 'video', audio: 'music', voice: 'mic', file: 'file', ig: 'insta' }[entry.kind] || 'smile'));
    a.append(mini);
  }
  const who = actor === 'me' ? 'شما' : peerName(actor);
  const verb = actor === 'me' ? 'دادید' : 'داد';
  a.append(document.createTextNode(e ? `${who} با ${e} واکنش ${verb}` : `${who} پاسخ ${verb}`));
  if (text) a.append(el('span', 'snip', `«${text}»`));
  else if (!entry.preview && entry.kind === 'text') a.append(el('span', 'snip', `«${entry.snippet}»`));
  a.onclick = () => focusMessage(entry);
  a.dataset.e = e || '💬';
  a.dataset.ig = entry.preview ? '1' : '';
  const run = currentRun();
  run.querySelector('.act-items').append(a);
  a.run = run;
  entry.acts[actor] = a;
  updateRun(run);
  const list = $('messages');
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 160) list.scrollTop = list.scrollHeight;
}

function currentRun() {
  const list = $('messages');
  const last = list.lastElementChild;
  if (last && last.classList.contains('act-run')) return last;
  const run = el('li', 'act-run');
  const summary = el('button', 'act-summary');
  summary.type = 'button';
  summary.onclick = () => { run.classList.toggle('open'); updateRun(run); };
  run.append(summary, el('div', 'act-items'));
  list.append(run);
  return run;
}

function updateRun(run) {
  const items = [...run.querySelectorAll('.act')];
  if (!items.length) { run.remove(); return; }
  const grouped = items.length > 2;
  run.classList.toggle('grouped', grouped);
  if (!grouped) { run.classList.remove('open'); return; }
  const s = run.querySelector('.act-summary');
  s.textContent = '';
  const stack = el('span', 'stack');
  for (const e of [...new Set(items.map((i) => i.dataset.e))].slice(0, 4)) stack.append(el('span', '', e));
  const allIg = items.every((i) => i.dataset.ig);
  s.append(stack, document.createTextNode(`${fa(items.length)} واکنش${allIg ? ' به پست‌های اینستاگرام' : ''}`), icon('arrow', 'chev'));
  s.lastChild.style.transform = run.classList.contains('open') ? 'rotate(90deg)' : 'rotate(-90deg)';
}

function removeAct(a) {
  const run = a.run;
  a.remove();
  if (run) updateRun(run);
}

function focusMessage(entry) {
  if (entry.stack) {
    entry.stack.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    openIgModal(entry.stack.members, entry.stack.members.indexOf(entry), entry.stack);
    return;
  }
  if (entry.preview) { openIgModal([entry], 0); return; }
  entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  entry.el.classList.remove('flash');
  void entry.el.offsetWidth;
  entry.el.classList.add('flash');
}

// ---------- files ----------
function chunkIv(i) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, i);
  return iv;
}
function chunkAad(idBytes, i, total) { return concat(te.encode('wn1/file'), idBytes, u32(i), u32(total)); }
function kindOf(mime) {
  if (/^image\/(jpeg|png|gif|webp|avif)$/.test(mime)) return 'image';
  if (/^video\/(mp4|webm|quicktime|ogg)$/.test(mime)) return 'video';
  if (AUDIO_RE.test(mime)) return 'audio';
  return 'file';
}

// Re-encode photos to drop EXIF (GPS, device, time). GIFs keep their animation.
async function stripImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif|avif)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const out = await new Promise((r) => c.toBlob(r, type, 0.9));
    c.width = c.height = 0;
    return out || null;
  } catch {
    return null;
  }
}

async function sendFiles(files) {
  for (const f of files) await sendFile(f);
}

// extra (voice messages only): { voice: true, dur: seconds, wave: b64 levels, reply }
async function sendFile(file, gif = false, extra = null) {
  if (file.size > MAX_FILE) { toast(`حداکثر حجم فایل ${fa(100)} مگابایت است`); return; }
  let blob = file;
  if (!gif && file.type.startsWith('image/')) {
    const clean = await stripImage(file);
    if (clean) blob = clean;
    else if (!(await ask('اطلاعات عکس حذف نشد', 'حذف اطلاعات مکان و دستگاه از این عکس ممکن نشد. همین‌طور ارسال شود؟', 'ارسال', false))) return;
  }
  const mime = blob.type || guessMime(file.name) || 'application/octet-stream';
  const kind = gif ? 'gif' : extra?.voice && AUDIO_RE.test(mime) && blob.size <= VOICE_MAX_BYTES ? 'voice' : kindOf(mime);
  const idBytes = rand(12);
  const id = b64u(idBytes);
  const key = rand(32);
  const total = Math.max(1, Math.ceil(blob.size / CHUNK));
  const meta = { k: 'file', id, name: (file.name || 'file').slice(0, 200), mime, size: blob.size, total, key: b64u(key), ttl, kind, ts: Date.now(), a: myDev, an: myName };
  if (kind === 'voice') {
    meta.dur = Math.max(0, Math.min(VOICE_MAX_S, Math.round(extra.dur || 0)));
    if (extra.wave) meta.wave = extra.wave;
    if (extra.reply) meta.reply = extra.reply;
  }
  const aes = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  wipe(key);

  const entry = renderFile(meta, 'out');
  finalizeMedia(entry, blob, meta);
  entry.ready = true;
  seen.set(id, Date.now() + 86400000);
  let targets = [];
  if (anySecure()) { try { targets = await post(meta); } catch { targets = []; } }
  const bar = showProgress(entry);
  const uploads = new Set();
  let uploadFailed = false;
  for (let i = 0; i < total; i++) {
    targets = targets.filter((pid) => sessions.get(pid)?.secure);
    if (!messages.has(id)) return;
    while (targets.length && ws?.readyState === 1 && ws.bufferedAmount > 2 * 1024 * 1024) await sleep(25);
    let chunk = new Uint8Array(await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
    if (i === total - 1) {
      // Voice messages pad to whole chunks, so their size does not give away their length.
      const unit = kind === 'voice' ? CHUNK : 16384;
      const padded = new Uint8Array(Math.max(unit, Math.ceil(chunk.length / unit) * unit));
      padded.set(chunk);
      padded.set(rand(padded.length - chunk.length), chunk.length);
      chunk = padded;
    }
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(i), additionalData: chunkAad(idBytes, i, total) }, aes, chunk));
    if (targets.length && ws?.readyState === 1) for (const pid of targets) ws.send(concat(new Uint8Array([1]), unb64u(pid), idBytes, u32(i), ct));
    const up = uploadChunk(id, i, ct).catch(() => { uploadFailed = true; }).finally(() => uploads.delete(up));
    uploads.add(up);
    while (uploads.size >= 3) await Promise.race(uploads);
    if (uploadFailed) break;
    bar.style.width = `${((i + 1) / total) * 100}%`;
  }
  await Promise.all(uploads);
  bar.parentElement?.remove();
  if (uploadFailed) { entry.el.classList.add('failed'); toast('ذخیره‌ی فایل روی سرور انجام نشد'); return; }
  // The file entry goes into history only once all its chunks are on the server.
  storeEvent(meta, { blob: true }).then(() => { entry.stored = true; }).catch(() => toast('ذخیره‌ی فایل روی سرور انجام نشد'));
}

function renderFile(meta, dir) {
  const entry = createEntry({ from: meta.from, id: meta.id, ts: meta.ts, dir, ttl: meta.ttl, kind: meta.kind, snippet: meta.name });
  entry.el.classList.add('media');
  entry.ready = dir === 'out';
  if (meta.kind === 'voice') {
    entry.voiceDur = meta.dur || 0;
    entry.awaitPlay = dir === 'in'; // an incoming voice message counts as read once it is played
  }
  const box = el('div', 'media-loading');
  if (meta.kind === 'gif') box.classList.add('gif-loading');
  box.append(icon(meta.kind === 'image' || meta.kind === 'gif' ? 'image' : meta.kind === 'video' ? 'video' : meta.kind === 'audio' ? 'music' : meta.kind === 'voice' ? 'mic' : 'file'));
  if (meta.kind !== 'gif') box.append(el('div', '', `${meta.kind === 'file' ? meta.name : meta.kind === 'voice' ? `پیام صوتی · ${fmtDuration(meta.dur || 0)}` : { image: 'عکس', video: 'ویدیو', audio: trackTitle(meta.name) }[meta.kind]} · ${fmtSize(meta.size)}`));
  const prog = el('div', 'progress');
  prog.append(el('i'));
  box.append(prog);
  entry.content.append(box);
  entry.loading = box;
  return entry;
}

function showProgress(entry) {
  const p = el('div', 'progress');
  const bar = el('i');
  p.append(bar);
  p.style.margin = '6px auto 2px';
  entry.content.append(p);
  return bar;
}

function finalizeMedia(entry, blob, meta) {
  entry.content.textContent = '';
  const kind = meta.kind;
  if (kind === 'voice') {
    renderVoice(entry, blob, meta);
    return;
  }
  if (kind === 'audio') {
    entry.blob = blob;
    entry.url = URL.createObjectURL(blob);
    entry.title = trackTitle(meta.name);
    const card = el('div', 'music-msg');
    const play = el('button', 'music-play');
    play.type = 'button';
    play.setAttribute('aria-label', 'پخش');
    play.append(icon('play'));
    play.onclick = (e) => { e.stopPropagation(); playMessageTrack(entry); };
    const info = el('div', 'music-info');
    info.append(el('div', 'music-title', entry.title), el('div', 'music-sub', `موزیک · ${fmtSize(meta.size)}`));
    const save = el('button', 'music-save');
    save.type = 'button';
    save.title = 'ماندگار در حافظه‌ی همین دستگاه';
    save.append(icon('pin'), el('span', '', 'ماندگار'));
    save.onclick = (e) => { e.stopPropagation(); saveTrack(entry, save); };
    card.append(play, info, save);
    entry.content.append(card);
    entry.playBtn = play;
    entry.el.classList.remove('media');
    entry.el.classList.add('music');
    return;
  }
  if (kind === 'gif') {
    // Deliberately tiny and low-resolution: unreadable from beside you or
    // through another phone's zoom.
    entry.url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = entry.url;
    img.className = 'gif-mini';
    img.alt = '';
    img.draggable = false;
    entry.content.append(img);
    entry.el.classList.add('gif');
    return;
  }
  if (kind === 'file') {
    const safe = new Blob([blob], { type: 'application/octet-stream' });
    entry.url = URL.createObjectURL(safe);
    const a = el('a', 'file-card');
    a.href = entry.url;
    a.download = meta.name;
    const ic = el('span', 'file-ic');
    ic.append(icon('file'));
    const txt = el('div');
    txt.append(el('div', 'name', meta.name), el('div', 'size', `${fmtSize(meta.size)} · دانلود`));
    a.append(ic, txt);
    entry.content.append(a);
    entry.el.classList.remove('media');
    return;
  }
  entry.url = URL.createObjectURL(blob);
  entry.blob = blob;
  entry.title = kind === 'image' ? 'عکس' : 'ویدیو';
  const wrap = el('div', 'media-wrap');
  const media = kind === 'image' ? new Image() : document.createElement('video');
  media.src = entry.url;
  if (kind === 'video') { media.preload = 'metadata'; media.muted = true; media.playsInline = true; }
  media.draggable = false;
  const veil = el('div', 'media-veil');
  veil.append(icon('hand'), el('span', '', `${TOUCH ? 'با دو انگشت' : ''} برای ${kind === 'image' ? 'دیدن' : 'پخش'} نگه دارید`.trim()));
  wrap.append(media, veil);
  wrap.addEventListener('pointerdown', (e) => pressMedia(e, entry, kind));
  wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); if (e.pointerType !== 'touch' && !TOUCH) openKeepSheet(entry); });
  entry.content.append(wrap);
}

function failTransfer(entry) {
  if (!entry || !messages.has(entry.id)) return;
  entry.el.classList.add('failed');
  entry.el.querySelector('.progress')?.remove();
  if (!entry.url) {
    entry.content.textContent = '';
    const box = el('div', 'media-loading');
    box.append(icon('alert'), el('div', '', 'انتقال کامل نشد'));
    entry.content.append(box);
  }
  entry.ready = true;
  if (!entry.expires) entry.expires = Date.now() + 15000;
}

async function onFileMeta(s, o) {
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(o.id) || seen.has(o.id)) return;
  if (!Number.isInteger(o.size) || o.size < 0 || o.size > MAX_FILE) return;
  if (o.total !== Math.max(1, Math.ceil(o.size / CHUNK))) return;
  const kb = unb64u(o.key);
  if (kb.length !== 32) return;
  seen.set(o.id, Date.now() + 86400000);
  const key = await subtle.importKey('raw', kb, 'AES-GCM', false, ['decrypt']);
  wipe(kb);
  const mime = typeof o.mime === 'string' ? o.mime.slice(0, 100) : '';
  const isGif = o.kind === 'gif' && /^image\/(gif|webp)$/.test(mime) && o.size <= 2 * 1024 * 1024;
  const vf = isGif ? null : voiceFields(o, mime);
  rememberName(o.a, o.an);
  const meta = { from: authorOf(s, o), id: o.id, ts: o.ts, name: String(o.name || 'file').slice(0, 200), mime, size: o.size, total: o.total, ttl: clampTtl(o.ttl), kind: isGif ? 'gif' : vf ? 'voice' : kindOf(mime), ...vf };
  const entry = renderFile(meta, 'in');
  incoming.set(o.id, { from: s.peer, meta, key, idBytes: unb64u(o.id), parts: new Array(o.total), got: 0, entry, lastAt: Date.now() });
  bumpUnread();
}

async function onChunk(buf) {
  // [1][sender 12][file id 12][chunk index 4][ciphertext]
  if (buf.length < 29 || buf[0] !== 1) return;
  const from = b64u(buf.slice(1, 13));
  const idBytes = buf.slice(13, 25);
  const inc = incoming.get(b64u(idBytes));
  if (!inc || inc.from !== from) return;
  const i = new DataView(buf.buffer, buf.byteOffset).getUint32(25);
  const { meta } = inc;
  if (i >= meta.total || inc.parts[i]) return;
  let pt;
  try {
    pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(i), additionalData: chunkAad(idBytes, i, meta.total) }, inc.key, buf.subarray(29)));
  } catch {
    return;
  }
  const want = i < meta.total - 1 ? CHUNK : meta.size - (meta.total - 1) * CHUNK;
  if (pt.length < want || (i < meta.total - 1 && pt.length !== CHUNK)) return;
  inc.parts[i] = pt.subarray(0, want);
  inc.got++;
  inc.lastAt = Date.now();
  const bar = inc.entry.loading?.querySelector('.progress i');
  if (bar) bar.style.width = `${(inc.got / meta.total) * 100}%`;
  if (inc.got < meta.total) return;
  incoming.delete(meta.id);
  const blob = new Blob(inc.parts, { type: meta.kind === 'file' ? 'application/octet-stream' : meta.mime });
  for (const p of inc.parts) wipe(p);
  inc.parts = null;
  if (!messages.has(meta.id)) return;
  finalizeMedia(inc.entry, blob, meta);
  inc.entry.ready = true;
  watchRead(inc.entry);
  const sender = sessions.get(from);
  if (sender?.secure) await sendInner(sender, { k: 'ack', id: meta.id });
}

// Hold-to-view: media is shown full-screen only while held, for a limited
// time. On touch screens it takes two fingers, which leaves no hand free for
// the phone's screenshot buttons; a third finger (Android's screenshot
// gesture) closes it and warns the peer. One finger held still (or a right
// click) offers "keep".
const TOUCH = matchMedia('(pointer: coarse)').matches;
const VIEW_MS = { image: 10000, video: 10 * 60000 }; // videos: their own length (capped at 10 min)
const touchIds = new Set();
let pendingMedia = null; // { entry, kind }
let keepTimer = null;
let mouseHeld = false;
let viewer = null; // { close }

// Chat media already has a URL; kept items are decrypted on first press.
function ensureUrl(item) {
  if (item.url) return Promise.resolve(item.url);
  if (!item.load) return Promise.reject(new Error('no media'));
  if (!item.loading) {
    item.loading = item.load()
      .then((u) => { item.url = u; galleryUrls.add(u); return u; })
      .finally(() => { item.loading = null; });
  }
  return item.loading;
}

function tryOpen() {
  const p = pendingMedia;
  if (!p || viewer || !(mouseHeld || touchIds.size >= 2)) return;
  ensureUrl(p.entry)
    .then(() => { if (pendingMedia === p && (mouseHeld || touchIds.size >= 2)) openViewer(p.entry, p.kind); })
    .catch(() => toast('باز نشد'));
}

function pressMedia(e, entry, kind) {
  e.preventDefault();
  pendingMedia = { entry, kind };
  ensureUrl(entry).catch(() => {});
  if (e.pointerType !== 'touch') {
    if (e.button !== 0) return;
    mouseHeld = true;
    tryOpen();
    return;
  }
  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => {
    if (viewer || touchIds.size !== 1 || pendingMedia?.entry !== entry) return;
    navigator.vibrate?.(12);
    if (entry.id && messages.has(entry.id)) openKeepSheet(entry);
    else toast('برای دیدن، با دو انگشت روی صفحه نگه دارید');
  }, 550);
  if (touchIds.size >= 2) tryOpen();
}

function onGlobalPointerDown(e) {
  if (e.pointerType !== 'touch') return;
  touchIds.add(e.pointerId);
  if (touchIds.size >= 2) clearTimeout(keepTimer);
  if (touchIds.size >= 3) {
    if (viewer) { viewer.close(); screenshotAttempt(); }
    return;
  }
  if (touchIds.size === 2) tryOpen();
}

function onGlobalPointerUp(e) {
  if (e.pointerType === 'touch') {
    touchIds.delete(e.pointerId);
    if (viewer && touchIds.size < 2) viewer.close();
    if (!touchIds.size) { pendingMedia = null; clearTimeout(keepTimer); }
  } else {
    mouseHeld = false;
    if (pendingMedia && !viewer && e.button === 0) toast('برای دیدن، دکمه‌ی ماوس را روی تصویر نگه دارید');
    pendingMedia = null;
    if (viewer) viewer.close();
  }
}

function openViewer(entry, kind) {
  if (viewer || !entry.url || !canSee()) return;
  const v = $('viewer');
  v.textContent = '';
  const media = kind === 'image' ? new Image() : document.createElement('video');
  media.src = entry.url;
  media.draggable = false;
  if (kind === 'video') { media.playsInline = true; media.autoplay = true; media.loop = false; }
  const bar = el('div', 'view-time');
  const fill = el('i');
  bar.append(fill);
  v.append(media, bar, el('div', 'hint', 'برای بستن رها کنید'));
  v.hidden = false;
  if (kind === 'video') media.play().catch(() => { media.muted = true; media.play().catch(() => {}); });
  const limit = VIEW_MS[kind] || 10000;
  let timer = null;
  if (kind === 'video') {
    // A video may be watched exactly once through while held; the bar follows playback.
    media.addEventListener('timeupdate', () => {
      if (media.duration > 0 && Number.isFinite(media.duration)) fill.style.transform = `scaleX(${Math.max(0, 1 - media.currentTime / media.duration)})`;
    });
    media.addEventListener('ended', () => { close(); toast('ویدیو تمام شد'); });
  } else {
    fill.style.transition = `transform ${limit}ms linear`;
    requestAnimationFrame(() => { fill.style.transform = 'scaleX(0)'; });
  }
  timer = setTimeout(() => { close(); toast('زمان دیدن تمام شد؛ دوباره نگه دارید'); }, limit);
  // Leaving the page mid-view is how most screenshot tools start: tell the peer.
  const suspicious = () => { close(); screenshotAttempt(); };
  const onVis = () => { if (document.hidden) suspicious(); };
  const close = () => {
    if (!viewer) return;
    viewer = null;
    clearTimeout(timer);
    v.hidden = true;
    if (kind === 'video') media.pause();
    media.removeAttribute('src');
    v.textContent = '';
    window.removeEventListener('blur', suspicious);
    document.removeEventListener('visibilitychange', onVis);
  };
  viewer = { close };
  window.addEventListener('blur', suspicious);
  document.addEventListener('visibilitychange', onVis);
}

// "Keep" sheet for a photo or video in the chat.
function openKeepSheet(entry) {
  closePanels();
  const label = KIND_LABEL[entry.kind] || 'مورد';
  $('keep-title').textContent = entry.savedId ? `این ${label} ماندگار است` : `${label}`;
  const btn = $('keep-do');
  btn.querySelector('span').textContent = entry.savedId ? 'حذف از ماندگارها' : 'ماندگار کردن در این دستگاه';
  btn.classList.toggle('danger', !!entry.savedId);
  btn.onclick = async () => {
    closeKeepSheet();
    if (entry.savedId) {
      await deleteKept(entry.savedId);
      unkeepEntry(entry);
      toast('از ماندگارها حذف شد؛ تایمر دوباره فعال است');
    } else {
      await saveKept(entry);
    }
  };
  $('keep-sheet').hidden = false;
}
function closeKeepSheet() { $('keep-sheet').hidden = true; }

// ---------- screenshot deterrence ----------
// Browsers cannot block screenshots. We hide content whenever the window is
// not in focus, on screenshot shortcuts, and tell the peer when we notice one.
let shieldOn = false;
let shieldKeyTimer = null;
let lastShotSent = 0;
function setShield(on) {
  shieldOn = on;
  $('shield').hidden = !on || $('chat').hidden;
  if (!on) checkReads();
}
function evaluateShield() {
  setShield(document.hidden || !document.hasFocus());
}
function screenshotAttempt() {
  setShield(true);
  clearTimeout(shieldKeyTimer);
  shieldKeyTimer = setTimeout(evaluateShield, 2500);
  if (anySecure() && Date.now() - lastShotSent > 5000) {
    lastShotSent = Date.now();
    post({ k: 'shot' }).catch(() => {});
  }
}

// ---------- auto-lock ----------
// Leaving the page (minimize, app switch, screen off) locks the room; the
// password is needed again. Too many wrong tries wipe everything.
function lockNow() {
  if (locked || $('chat').hidden || !room.verifier) return;
  locked = true;
  closePanels();
  viewer?.close();
  cancelRecording(); // nothing keeps recording behind the lock screen
  voice.audio.pause();
  document.activeElement?.blur?.();
  $('lock-pass').value = '';
  $('lock-error').hidden = true;
  syncLockCall();
  $('lock').hidden = false;
}

function syncLockCall() {
  const lc = $('lock-call');
  lc.hidden = !call;
  if (call) lc.querySelector('span').textContent = call.state === 'incoming' ? 'تماس ورودی — برای پاسخ، قفل را باز کنید' : 'تماس در جریان است';
}

async function tryUnlock() {
  const pass = $('lock-pass').value;
  if (!pass || !locked) return;
  const btn = $('lock-btn');
  btn.disabled = true;
  btn.textContent = 'در حال بررسی…';
  const passKey = await passKeyFor(room.code, pass);
  const v = await hkdf(passKey, te.encode(room.code), 'wn1/unlock');
  wipe(passKey);
  let diff = v.length ^ room.verifier.length;
  for (let i = 0; i < v.length; i++) diff |= v[i] ^ room.verifier[i];
  wipe(v);
  btn.disabled = false;
  btn.textContent = 'باز کردن';
  $('lock-pass').value = '';
  if (!diff) {
    locked = false;
    unlockFails = 0;
    $('lock').hidden = true;
    evaluateShield();
    unread = 0;
    updateTitle();
    checkReads();
    return;
  }
  unlockFails++;
  if (unlockFails >= MAX_UNLOCK_TRIES) { await wipeLibrary(); leave(); return; }
  const err = $('lock-error');
  err.hidden = false;
  err.textContent = `رمز اشتباه است — ${fa(MAX_UNLOCK_TRIES - unlockFails)} تلاش دیگر تا پاک‌سازی کامل`;
  $('lock').classList.remove('shake');
  void $('lock').offsetWidth;
  $('lock').classList.add('shake');
  $('lock-pass').focus();
}

function passStrength(p) {
  let s = 0;
  if (p.length >= MIN_PASS) s++;
  if (p.length >= 10) s++;
  if (p.length >= 14) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return p.length < MIN_PASS ? 0 : Math.min(4, Math.ceil((s * 4) / 6));
}

// ---------- kept items: library + player ----------
// Music, photos and videos can be kept on this device ("ماندگار"). They are
// stored in IndexedDB, encrypted with a key derived from this room's code +
// password, so they open only inside this room. Nothing goes to the server.
const AUDIO_RE = /^audio\/(mpeg|mp3|mp4|aac|ogg|wav|x-wav|wave|webm|flac|x-flac|x-m4a|m4a|opus)$/;
const AUDIO_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm' };
const guessMime = (name) => AUDIO_EXT[(String(name).split('.').pop() || '').toLowerCase()] || '';
const trackTitle = (name) => String(name || 'موزیک').replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[_]+/g, ' ').trim().slice(0, 120) || 'موزیک';
const KIND_LABEL = { audio: 'موزیک', image: 'عکس', video: 'ویدیو' };
const galleryUrls = new Set();

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('najva', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('tmeta', { keyPath: 'id' }).createIndex('ns', 'ns');
        d.createObjectStore('tdata', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
function idb(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function stores(mode) {
  const t = (await db()).transaction(['tmeta', 'tdata'], mode);
  const done = new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
  return { meta: t.objectStore('tmeta'), data: t.objectStore('tdata'), done };
}

// Tiny thumbnail for the gallery (shown blurred); stored inside the encrypted metadata.
async function makeThumb(blob, kind) {
  let url = null;
  try {
    let src;
    if (kind === 'image') {
      src = await createImageBitmap(blob);
    } else {
      url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = url;
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(rej, 5000); });
      v.currentTime = Math.min(0.5, (v.duration || 2) / 4);
      await new Promise((res) => { v.onseeked = res; setTimeout(res, 1500); });
      src = v;
    }
    const w = src.width || src.videoWidth;
    const h = src.height || src.videoHeight;
    const scale = 72 / Math.max(w, h, 1);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    src.close?.();
    return c.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

async function saveKept(entry, btn) {
  if (!room.libKey || !entry.blob) return;
  const label = KIND_LABEL[entry.kind] || 'مورد';
  if (entry.savedId) { toast(`این ${label} قبلاً ماندگار شده`); return; }
  if (btn) btn.disabled = true;
  try {
    const buf = await entry.blob.arrayBuffer();
    const hash = b64u(await sha256(new Uint8Array(buf)));
    const existing = (await listKept()).find((t) => t.hash === hash);
    if (existing) {
      keepEntry(entry, existing.id, btn);
      toast(`این ${label} از قبل در ماندگارها هست`);
      return;
    }
    const id = b64u(rand(12));
    const ad = te.encode('wn1/track/' + id);
    const iv1 = rand(12);
    const iv2 = rand(12);
    const info = {
      kind: entry.kind, title: entry.title, size: buf.byteLength, savedAt: Date.now(), hash,
      mime: entry.blob.type || (entry.kind === 'audio' ? 'audio/mpeg' : 'application/octet-stream'),
      thumb: entry.kind === 'audio' ? null : await makeThumb(entry.blob, entry.kind),
    };
    const meta = await subtle.encrypt({ name: 'AES-GCM', iv: iv1, additionalData: ad }, room.libKey, te.encode(JSON.stringify(info)));
    const data = await subtle.encrypt({ name: 'AES-GCM', iv: iv2, additionalData: ad }, room.libKey, buf);
    const st = await stores('readwrite');
    st.meta.put({ id, ns: room.libNs, iv: iv1, meta });
    st.data.put({ id, iv: iv2, data });
    await st.done;
    navigator.storage?.persist?.().catch(() => {});
    keepEntry(entry, id, btn);
    toast(`${label} در ماندگارهای این دستگاه ذخیره شد`);
    if (anySecure()) post({ k: 'saved', id: entry.id }).catch(() => {});
    if (!$('music-modal').hidden) renderLibrary();
  } catch {
    if (btn) btn.disabled = false;
    toast('ذخیره نشد (فضای مرورگر کافی نیست؟)');
  }
}
const saveTrack = saveKept;

// A kept message no longer self-destructs on this device.
function keepEntry(entry, id, btn) {
  entry.savedId = id;
  entry.kept = true;
  entry.expires = null;
  btn = btn || entry.el.querySelector('.music-save');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('saved');
    btn.lastChild.textContent = 'ماندگار شد';
  }
  entry.el.classList.add('kept');
  renderTimer(entry);
}

function unkeepEntry(entry) {
  entry.savedId = null;
  if (!entry.kept) return;
  entry.kept = false;
  entry.el.classList.remove('kept');
  if (entry.ttl && (entry.readSent || entry.el.classList.contains('read'))) entry.expires = Date.now() + entry.ttl * 1000;
  const btn = entry.el.querySelector('.music-save');
  if (btn) { btn.disabled = false; btn.classList.remove('saved'); btn.lastChild.textContent = 'ماندگار'; }
  renderTimer(entry);
}

async function listKept() {
  if (!room.libNs) return [];
  const st = await stores('readonly');
  const rows = await idb(st.meta.index('ns').getAll(room.libNs));
  const out = [];
  for (const r of rows) {
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: r.iv, additionalData: te.encode('wn1/track/' + r.id) }, room.libKey, r.meta);
      out.push({ kind: 'audio', id: r.id, ...JSON.parse(td.decode(pt)) });
    } catch {}
  }
  return out.sort((a, b) => a.savedAt - b.savedAt);
}

async function loadKeptUrl(id, mime) {
  const st = await stores('readonly');
  const r = await idb(st.data.get(id));
  if (!r) throw new Error('missing');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: r.iv, additionalData: te.encode('wn1/track/' + id) }, room.libKey, r.data);
  return URL.createObjectURL(new Blob([pt], { type: mime || 'application/octet-stream' }));
}

async function deleteKept(id) {
  const st = await stores('readwrite');
  st.meta.delete(id);
  st.data.delete(id);
  await st.done;
}

async function wipeLibrary() {
  if (!room.libNs) return;
  try {
    const st = await stores('readwrite');
    const ids = await idb(st.meta.index('ns').getAllKeys(room.libNs));
    for (const id of ids) { st.meta.delete(id); st.data.delete(id); }
    await st.done;
  } catch {}
}

// ----- player -----
const player = { audio: new Audio(), queue: [], index: -1, url: null, owned: false, cur: null, shuffle: false, repeat: false };
player.audio.preload = 'auto';
player.audio.addEventListener('ended', () => playerNext(true));
player.audio.addEventListener('timeupdate', updateProgress);
player.audio.addEventListener('loadedmetadata', updateProgress);
player.audio.addEventListener('play', syncPlayerUi);
player.audio.addEventListener('pause', syncPlayerUi);

async function playQueue(items, index) {
  player.queue = items;
  await playAt(index);
}

async function playAt(i) {
  if (i < 0 || i >= player.queue.length) { stopPlayer(); return; }
  const it = player.queue[i];
  let url;
  try { url = await it.load(); } catch { toast('پخش نشد'); return; }
  if (voice.entry) stopVoice();
  if (player.url && player.owned && player.url !== url) URL.revokeObjectURL(player.url);
  player.index = i;
  player.cur = it;
  player.url = url;
  player.owned = it.owned;
  player.audio.src = url;
  player.audio.play().catch(() => {});
  setMediaSession();
  syncPlayerUi();
}

function playerNext(auto) {
  const n = player.queue.length;
  if (!n) return;
  let i;
  if (player.shuffle && n > 1) {
    do { i = Math.floor(Math.random() * n); } while (i === player.index);
  } else {
    i = player.index + 1;
  }
  if (i >= n) {
    if (player.repeat) i = 0;
    else if (auto) { stopPlayer(); return; }
    else i = n - 1;
  }
  playAt(i);
}

function playerPrev() {
  if (player.audio.currentTime > 3 || player.index <= 0) { player.audio.currentTime = 0; return; }
  playAt(player.index - 1);
}

function togglePlay() {
  if (!player.cur) return;
  if (player.audio.paused) player.audio.play().catch(() => {}); else player.audio.pause();
}

function stopPlayer() {
  player.audio.pause();
  player.audio.removeAttribute('src');
  player.audio.load();
  if (player.url && player.owned) URL.revokeObjectURL(player.url);
  player.url = null;
  player.cur = null;
  player.index = -1;
  syncPlayerUi();
}

// Lock-screen controls work, but never show the track name there.
function setMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'نجوا', artist: '' });
    navigator.mediaSession.setActionHandler('play', () => player.audio.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => player.audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => playerNext(false));
    navigator.mediaSession.setActionHandler('previoustrack', () => playerPrev());
  } catch {}
}

function messageQueue() {
  return [...messages.values()]
    .filter((m) => m.kind === 'audio' && m.url)
    .map((m) => ({ key: 'm:' + m.id, title: m.title, owned: false, load: async () => m.url }));
}

function playMessageTrack(entry) {
  if (player.cur?.key === 'm:' + entry.id) { togglePlay(); return; }
  const q = messageQueue();
  playQueue(q, Math.max(0, q.findIndex((x) => x.key === 'm:' + entry.id)));
}

async function playLibrary(startId) {
  const list = (await listKept()).filter((t) => t.kind === 'audio');
  if (!list.length) { toast('هنوز موزیکی ماندگار نشده'); return; }
  const q = list.map((t) => ({ key: 'l:' + t.id, title: t.title, owned: true, load: () => loadKeptUrl(t.id, t.mime) }));
  const i = startId ? Math.max(0, q.findIndex((x) => x.key === 'l:' + startId)) : (player.shuffle ? Math.floor(Math.random() * q.length) : 0);
  await playQueue(q, i);
}

function setIconBtn(btn, name) {
  btn.textContent = '';
  btn.append(icon(name));
}

function syncPlayerUi() {
  const playing = !!player.cur && !player.audio.paused;
  $('mini-player').hidden = !player.cur;
  $('mp-title').textContent = player.cur?.title || '';
  setIconBtn($('mp-play'), playing ? 'pause' : 'play');
  setIconBtn($('np-play'), playing ? 'pause' : 'play');
  $('np-title').textContent = player.cur?.title || 'چیزی در حال پخش نیست';
  $('mini-player').classList.toggle('playing', playing);
  $('np-shuffle').classList.toggle('on', player.shuffle);
  $('np-repeat').classList.toggle('on', player.repeat);
  for (const m of messages.values()) {
    if (m.kind === 'audio' && m.playBtn) setIconBtn(m.playBtn, playing && player.cur?.key === 'm:' + m.id ? 'pause' : 'play');
  }
  for (const li of document.querySelectorAll('#lib-list li')) li.classList.toggle('current', player.cur?.key === 'l:' + li.dataset.id);
  updateProgress();
}

let seeking = false;
function updateProgress() {
  const a = player.audio;
  const ratio = a.duration > 0 && Number.isFinite(a.duration) ? a.currentTime / a.duration : 0;
  $('mp-bar').style.transform = `scaleX(${ratio})`;
  if (!seeking) $('np-seek').value = String(Math.round(ratio * 1000));
  $('np-cur').textContent = fmtDuration(Math.floor(a.currentTime || 0));
  $('np-dur').textContent = a.duration > 0 && Number.isFinite(a.duration) ? fmtDuration(Math.floor(a.duration)) : '0:00';
}

// ----- library modal (music + photos/videos) -----
let libTab = 'music';

function releaseGallery() {
  for (const u of galleryUrls) URL.revokeObjectURL(u);
  galleryUrls.clear();
}

async function renderLibrary() {
  const all = await listKept();
  const music = all.filter((t) => t.kind === 'audio');
  const media = all.filter((t) => t.kind === 'image' || t.kind === 'video');
  $('lib-count').textContent = all.length ? `${fa(all.length)} مورد · فقط روی همین دستگاه` : 'خالی';
  $('tab-music').textContent = `موزیک (${fa(music.length)})`;
  $('tab-media').textContent = `عکس و ویدیو (${fa(media.length)})`;
  $('tab-music').classList.toggle('active', libTab === 'music');
  $('tab-media').classList.toggle('active', libTab === 'media');
  $('music-pane').hidden = libTab !== 'music';
  $('media-pane').hidden = libTab !== 'media';

  const list = $('lib-list');
  list.textContent = '';
  $('lib-empty').hidden = music.length > 0;
  music.forEach((t, i) => {
    const li = el('li');
    li.dataset.id = t.id;
    const info = el('div', 'lib-info');
    info.append(el('div', 'lib-title', t.title), el('div', 'lib-sub', fmtSize(t.size)));
    const del = el('button', 'btn-icon sm lib-del');
    del.type = 'button';
    del.setAttribute('aria-label', 'حذف');
    del.append(icon('trash'));
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!(await ask('حذف از ماندگارها', `«${t.title}» از ماندگارهای این دستگاه پاک شود؟`, 'حذف'))) return;
      if (player.cur?.key === 'l:' + t.id) stopPlayer();
      await removeKept(t.id);
    };
    li.append(el('span', 'lib-num', fa(i + 1)), info, del);
    li.onclick = () => playLibrary(t.id);
    list.append(li);
  });

  releaseGallery();
  const g = $('gallery');
  g.textContent = '';
  $('gallery-empty').hidden = media.length > 0;
  for (const t of media) {
    const tile = el('div', 'g-tile');
    if (t.thumb && t.thumb.startsWith('data:image/jpeg;base64,')) {
      const img = new Image();
      img.src = t.thumb;
      img.alt = '';
      img.draggable = false;
      tile.append(img);
    } else {
      tile.append(icon(t.kind === 'video' ? 'video' : 'image'));
    }
    const badge = el('span', 'g-badge');
    badge.append(icon(t.kind === 'video' ? 'play' : 'hand'));
    const del = el('button', 'g-del');
    del.type = 'button';
    del.setAttribute('aria-label', 'حذف');
    del.append(icon('trash'));
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!(await ask('حذف از ماندگارها', `این ${KIND_LABEL[t.kind]} از ماندگارهای این دستگاه پاک شود؟`, 'حذف'))) return;
      await removeKept(t.id);
    };
    tile.append(badge, del);
    const item = { url: null, load: () => loadKeptUrl(t.id, t.mime) };
    tile.addEventListener('pointerenter', () => { ensureUrl(item).catch(() => {}); }); // decrypt ahead on desktop hover
    tile.addEventListener('pointerdown', (e) => pressMedia(e, item, t.kind));
    tile.addEventListener('contextmenu', (e) => e.preventDefault());
    g.append(tile);
  }
  syncPlayerUi();
}

async function removeKept(id) {
  await deleteKept(id);
  for (const m of messages.values()) if (m.savedId === id) unkeepEntry(m);
  renderLibrary();
}

function openMusic() {
  closePanels();
  $('music-modal').hidden = false;
  renderLibrary();
}

function closeMusic() {
  $('music-modal').hidden = true;
  releaseGallery();
}

function bindMusic() {
  $('music-btn').onclick = openMusic;
  $('mp-open').onclick = () => { libTab = 'music'; openMusic(); };
  $('music-close').onclick = closeMusic;
  $('music-modal').addEventListener('click', (e) => { if (e.target === $('music-modal')) closeMusic(); });
  $('tab-music').onclick = () => { libTab = 'music'; renderLibrary(); };
  $('tab-media').onclick = () => { libTab = 'media'; renderLibrary(); };
  $('mp-play').onclick = togglePlay;
  $('np-play').onclick = () => (player.cur ? togglePlay() : playLibrary());
  $('mp-next').onclick = () => playerNext(false);
  $('np-next').onclick = () => playerNext(false);
  $('mp-prev').onclick = playerPrev;
  $('np-prev').onclick = playerPrev;
  $('mp-close').onclick = stopPlayer;
  $('np-shuffle').onclick = () => { player.shuffle = !player.shuffle; syncPlayerUi(); };
  $('np-repeat').onclick = () => { player.repeat = !player.repeat; syncPlayerUi(); };
  $('lib-playall').onclick = () => playLibrary();
  $('lib-wipe').onclick = async () => {
    if (!(await ask('حذف همه‌ی ماندگارها', 'همه‌ی موزیک‌ها، عکس‌ها و ویدیوهای ماندگارِ این اتاق از این دستگاه پاک می‌شوند. مطمئنید؟', 'بله، همه را پاک کن'))) return;
    stopPlayer();
    await wipeLibrary();
    for (const m of messages.values()) if (m.savedId) unkeepEntry(m);
    renderLibrary();
  };
  $('keep-cancel').onclick = closeKeepSheet;
  $('keep-sheet').addEventListener('click', (e) => { if (e.target === $('keep-sheet')) closeKeepSheet(); });
  const seek = $('np-seek');
  seek.addEventListener('input', () => { seeking = true; });
  seek.addEventListener('change', () => {
    const a = player.audio;
    if (a.duration > 0 && Number.isFinite(a.duration)) a.currentTime = (Number(seek.value) / 1000) * a.duration;
    seeking = false;
  });
}

// ---------- encrypted history on the server ----------
// Every content event (message, file, reaction) is also kept on the server,
// encrypted with a key derived from the room code + password, so the chat is
// still there after closing the tab or coming back on another device. The
// server only sees opaque blobs; access needs a password-derived token.
const pendingReacts = new Map(); // target id -> reactions that arrived before it
let histBefore = null;
let histMore = false;
let histLoading = false;
let insertAnchor = null; // set while older history is inserted above the chat

function storeFetch(url, init = {}) {
  const headers = { 'X-Room': room.id, 'X-Room-Auth': room.storeAuth };
  if (typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  return fetch(url, { ...init, headers, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(init.timeout || 20000) });
}

async function storeEvent(ev, opts = {}) {
  const iv = rand(12);
  const ad = te.encode(`wn1/hist/${room.id}/${ev.id}`);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, room.histKey, pad(te.encode(JSON.stringify(ev)))));
  const body = JSON.stringify({ id: ev.id, iv: b64u(iv), ct: b64u(ct), blob: opts.blob ? 1 : 0, exp: opts.exp || 0 });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await storeFetch('/h/log', { method: 'POST', body });
      if (r.ok) return (await r.json()).ts;
      if (r.status === 403) break;
    } catch {}
    await sleep(1200 * (attempt + 1));
  }
  throw new Error('store failed');
}

async function openEvent(it) {
  try {
    const ad = te.encode(`wn1/hist/${room.id}/${it.id}`);
    const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(it.iv), additionalData: ad }, room.histKey, unb64u(it.ct)));
    const ev = JSON.parse(td.decode(unpad(pt)));
    if (!ev || ev.id !== it.id) return null;
    ev.ts = it.ts;
    ev.exp = it.exp || 0;
    return ev;
  } catch {
    return null;
  }
}

function storeExp(id, exp) {
  storeFetch('/h/exp', { method: 'POST', body: JSON.stringify({ ids: [id], exp }) }).catch(() => {});
}

async function uploadChunk(id, i, ct) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await storeFetch(`/h/blob/${id}/${i}`, { method: 'PUT', body: ct, timeout: 90000 });
      if (r.ok) return;
    } catch {}
    await sleep(1000 * (attempt + 1));
  }
  throw new Error('upload failed');
}

// Delete for everyone: from the server, from the other devices, from here.
async function deleteForAll(ids) {
  if (!ids.length) return;
  const r = await storeFetch('/h/del', { method: 'POST', body: JSON.stringify({ ids }) }).catch(() => null);
  if (!r || !r.ok) { toast('حذف از سرور انجام نشد'); return false; }
  if (anySecure()) post({ k: 'del', ids }).catch(() => {});
  for (const id of ids) { const m = messages.get(id); if (m) removeEntry(m); }
  return true;
}

function rememberName(dev, name) {
  if (PID_RE.test(dev || '') && typeof name === 'string' && name.trim() && !knownNames.has(dev)) knownNames.set(dev, name.replace(/\s+/g, ' ').trim().slice(0, 30));
}
const authorOf = (s, o) => (PID_RE.test(o.a || '') ? o.a : (s.dev || s.peer));

function applyReaction(ev, quiet) {
  if (!(ev.e == null || REACTIONS.includes(ev.e)) || !PID_RE.test(ev.a || '')) return;
  const m = messages.get(ev.target);
  if (!m) {
    const list = pendingReacts.get(ev.target) || [];
    if (list.length < 20) list.push(ev);
    pendingReacts.set(ev.target, list);
    return;
  }
  m.reactTs = m.reactTs || {};
  if ((m.reactTs[ev.a] || 0) > (ev.ts || 0)) return; // an older event than what we show
  m.reactTs[ev.a] = ev.ts || Date.now();
  rememberName(ev.a, ev.an);
  const t = typeof ev.t === 'string' ? ev.t.trim().slice(0, 500) : '';
  if (ev.a === myDev) { m.react.me = ev.e || null; m.reply.me = t; }
  else { m.react.peers[ev.a] = ev.e || null; m.reply.peers[ev.a] = t; }
  renderReacts(m);
  if (m.stack) renderStack(m.stack);
  if (m.preview) updateIgCaption(m);
  if (igModal) renderIgModal();
  if (!quiet) activity(ev.a === myDev ? 'me' : ev.a, m);
}

function validFileEvent(o) {
  return typeof o.id === 'string' && /^[A-Za-z0-9_-]{16}$/.test(o.id) && Number.isInteger(o.size) && o.size >= 0 && o.size <= MAX_FILE
    && o.total === Math.max(1, Math.ceil(o.size / CHUNK)) && typeof o.key === 'string';
}

function afterHistoryEntry(entry, ev, dir) {
  entry.stored = true;
  entry.serverTs = ev.ts;
  if (ev.exp) { entry.expires = ev.exp; entry.readSent = true; renderTimer(entry); }
  if (dir === 'in' && seenByMe.delete(entry.id)) entry.readSent = true;
  if (dir === 'out') {
    entry.el.classList.add('delivered');
    if (ev.exp) entry.el.classList.add('read'); // its timer only starts once read
    const readers = pendingSeen.get(entry.id);
    pendingSeen.delete(entry.id);
    if (readers) for (const a of readers) entry.readBy.add(a);
    if (readers || ev.exp) markOutRead(entry); else setTick(entry);
  }
  const pend = pendingReacts.get(entry.id);
  if (pend) { pendingReacts.delete(entry.id); for (const r of pend) applyReaction(r, true); }
}

function applyHistory(ev) {
  if (ev.k === 'react') { applyReaction(ev, true); return; }
  if (ev.k === 'seen') { applySeen(ev); return; }
  if (messages.has(ev.id) || seen.has(ev.id)) return;
  if (ev.k === 'text') {
    if (typeof ev.body !== 'string') return;
    seen.set(ev.id, Date.now() + 86400000);
    rememberName(ev.a, ev.an);
    const dir = ev.a === myDev ? 'out' : 'in';
    const entry = renderText({ id: ev.id, ts: ev.ts, from: dir === 'in' ? ev.a : null, body: ev.body.slice(0, 4000), ttl: clampTtl(ev.ttl), preview: sanitizePreview(ev.preview), reply: sanitizeReply(ev.reply) }, dir);
    afterHistoryEntry(entry, ev, dir);
  } else if (ev.k === 'file') {
    if (!validFileEvent(ev)) return;
    seen.set(ev.id, Date.now() + 86400000);
    rememberName(ev.a, ev.an);
    const dir = ev.a === myDev ? 'out' : 'in';
    const mime = typeof ev.mime === 'string' ? ev.mime.slice(0, 100) : '';
    const isGif = ev.kind === 'gif' && /^image\/(gif|webp)$/.test(mime) && ev.size <= 2 * 1024 * 1024;
    const vf = isGif ? null : voiceFields(ev, mime);
    const meta = { from: dir === 'in' ? ev.a : null, id: ev.id, ts: ev.ts, name: String(ev.name || 'file').slice(0, 200), mime, size: ev.size, total: ev.total, ttl: clampTtl(ev.ttl), kind: isGif ? 'gif' : vf ? 'voice' : kindOf(mime), ...vf };
    const entry = renderFile(meta, dir);
    entry.ready = false;
    entry.remote = { meta, key: ev.key };
    entry.el.dataset.id = ev.id;
    blobObserver.observe(entry.el);
    afterHistoryEntry(entry, ev, dir);
  }
}

// Media from history is fetched and decrypted when it scrolls into view.
const blobObserver = new IntersectionObserver((list) => {
  for (const e of list) {
    if (!e.isIntersecting) continue;
    blobObserver.unobserve(e.target);
    const entry = messages.get(e.target.dataset.id);
    if (entry?.remote) downloadRemote(entry);
  }
}, { rootMargin: '400px' });

async function downloadRemote(entry) {
  const job = entry.remote;
  entry.remote = null;
  const { meta } = job;
  try {
    const aes = await subtle.importKey('raw', unb64u(job.key), 'AES-GCM', false, ['decrypt']);
    const idBytes = unb64u(meta.id);
    const parts = [];
    for (let i = 0; i < meta.total; i++) {
      if (!messages.has(meta.id)) return;
      const r = await storeFetch(`/h/blob/${meta.id}/${i}`, { timeout: 90000 });
      if (!r.ok) throw new Error('missing');
      const ct = new Uint8Array(await r.arrayBuffer());
      const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(i), additionalData: chunkAad(idBytes, i, meta.total) }, aes, ct));
      parts.push(pt.subarray(0, i < meta.total - 1 ? CHUNK : meta.size - (meta.total - 1) * CHUNK));
      const bar = entry.loading?.querySelector('.progress i');
      if (bar) bar.style.width = `${((i + 1) / meta.total) * 100}%`;
    }
    if (!messages.has(meta.id)) return;
    finalizeMedia(entry, new Blob(parts, { type: meta.kind === 'file' ? 'application/octet-stream' : meta.mime }), meta);
    entry.ready = true;
    if (entry.dir === 'in' && !entry.readSent) watchRead(entry);
  } catch {
    if (!messages.has(meta.id)) return;
    entry.content.textContent = '';
    const box = el('div', 'media-loading');
    const retry = el('button', 'btn btn-soft btn-sm', 'تلاش دوباره');
    retry.type = 'button';
    retry.onclick = (e) => { e.stopPropagation(); entry.remote = job; entry.content.textContent = ''; entry.content.append(entry.loading); downloadRemote(entry); };
    box.append(icon('alert'), el('div', '', 'دریافت از سرور انجام نشد'), retry);
    entry.content.append(box);
  }
}

async function loadHistory(initial) {
  if (histLoading || (!initial && !histMore) || !room.histKey) return;
  histLoading = true;
  const list = $('messages');
  try {
    const q = new URLSearchParams({ limit: '80' });
    if (!initial && histBefore) q.set('before', String(histBefore));
    const r = await storeFetch('/h/log?' + q);
    if (r.status === 403) { banner('به تاریخچه‌ی این اتاق دسترسی ندارید: رمز با رمز این اتاق یکی نیست.'); return; }
    if (!r.ok) throw new Error('history');
    const { items, more } = await r.json();
    histMore = !!more;
    if (items.length) histBefore = items[items.length - 1].ts;
    const events = [];
    for (const it of items) { const ev = await openEvent(it); if (ev) events.push(ev); }
    events.reverse(); // oldest first
    const prevHeight = list.scrollHeight;
    const prevTop = list.scrollTop;
    insertAnchor = [...list.children].find((c) => c.id !== 'load-older') || null;
    try {
      for (const ev of events) if (ev.k !== 'react' && ev.k !== 'seen') applyHistory(ev);
      for (const ev of events) if (ev.k === 'react' || ev.k === 'seen') applyHistory(ev);
    } finally {
      insertAnchor = null;
    }
    updateOlderButton();
    if (initial) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    else list.scrollTop = list.scrollHeight - prevHeight + prevTop;
    checkReads();
  } catch {
    if (initial) toast('تاریخچه‌ی گفتگو از سرور دریافت نشد');
  } finally {
    histLoading = false;
  }
}

function updateOlderButton() {
  let li = $('load-older');
  if (!histMore) { li?.remove(); return; }
  if (!li) {
    li = el('li', 'load-older');
    li.id = 'load-older';
    const btn = el('button', 'btn btn-soft btn-sm', 'پیام‌های قدیمی‌تر');
    btn.type = 'button';
    btn.onclick = () => loadHistory(false);
    li.append(btn);
  }
  $('messages').prepend(li);
}

// ---------- content manager ----------
let mgItems = [];
let mgFilter = 'all';
const mgSelected = new Set();
const MG_KIND = (ev) => (ev.k === 'text' ? (ev.preview ? 'ig' : 'text') : ev.kind === 'gif' ? 'image' : ev.kind === 'voice' && AUDIO_RE.test(ev.mime || '') ? 'voice' : kindOf(ev.mime || ''));
const MG_LABEL = { text: 'متن', ig: 'اینستاگرام', image: 'عکس', video: 'ویدیو', audio: 'موزیک', voice: 'ویس', file: 'فایل' };
const MG_ICON = { text: 'message', ig: 'insta', image: 'image', video: 'video', audio: 'music', voice: 'mic', file: 'file' };

async function openManager() {
  closePanels();
  $('manage-modal').hidden = false;
  mgSelected.clear();
  mgItems = [];
  $('mg-list').textContent = '';
  $('mg-sub').textContent = 'در حال بارگذاری از سرور…';
  $('mg-empty').hidden = true;
  const [usage, items] = await Promise.all([fetchUsage(), fetchAllContent()]);
  mgItems = items;
  renderUsage(usage);
  renderManager();
}

async function fetchUsage() {
  try {
    const r = await storeFetch('/h/usage');
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function fetchAllContent() {
  const out = [];
  let before = null;
  for (let page = 0; page < 40; page++) {
    const q = new URLSearchParams({ limit: '500' });
    if (before) q.set('before', String(before));
    let data;
    try {
      const r = await storeFetch('/h/log?' + q);
      if (!r.ok) break;
      data = await r.json();
    } catch {
      break;
    }
    for (const it of data.items) {
      const ev = await openEvent(it);
      if (ev && (ev.k === 'text' || (ev.k === 'file' && validFileEvent(ev)))) out.push(ev);
    }
    if (!data.more || !data.items.length) break;
    before = data.items[data.items.length - 1].ts;
  }
  return out;
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${fa((n / 1024 ** 3).toFixed(2))} گیگابایت`;
  return fmtSize(n);
}

function renderUsage(u) {
  if (!u) { $('mg-room').textContent = '—'; $('mg-total').textContent = '—'; return; }
  $('mg-room').textContent = `${fmtBytes(u.roomBytes)} · ${fa(mgItems.length)} مورد`;
  $('mg-total').textContent = `${fmtBytes(u.totalBytes)} از ${fmtBytes(u.capBytes)}`;
  $('mg-bar').style.width = `${Math.min(100, (u.totalBytes / u.capBytes) * 100).toFixed(1)}%`;
}

function renderManager() {
  const list = $('mg-list');
  list.textContent = '';
  const rows = mgItems.filter((ev) => mgFilter === 'all' || MG_KIND(ev) === mgFilter);
  $('mg-sub').textContent = `${fa(mgItems.length)} مورد ذخیره‌شده · رمزشده روی سرور`;
  $('mg-empty').hidden = rows.length > 0;
  for (const b of $('mg-filter').querySelectorAll('button')) b.classList.toggle('active', b.dataset.f === mgFilter);
  for (const ev of rows) {
    const kind = MG_KIND(ev);
    const li = el('li', mgSelected.has(ev.id) ? 'selected' : '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = mgSelected.has(ev.id);
    box.setAttribute('aria-label', 'انتخاب');
    box.onclick = (e) => {
      e.stopPropagation();
      if (box.checked) mgSelected.add(ev.id); else mgSelected.delete(ev.id);
      li.classList.toggle('selected', box.checked);
      syncManagerTools();
    };
    const ic = el('span', `mg-ic k-${kind}`);
    ic.append(icon(MG_ICON[kind]));
    const info = el('div', 'mg-info');
    const title = kind === 'text' ? ev.body : kind === 'ig' ? (ev.preview?.title || 'پست اینستاگرام') : String(ev.name || MG_LABEL[kind]);
    const who = ev.a === myDev ? 'شما' : (knownNames.get(ev.a) || ev.an || 'مخاطب');
    const when = new Date(ev.ts).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
    const size = ev.k === 'file' ? ev.size : te.encode(ev.body || '').length;
    info.append(el('div', 'mg-title', title.slice(0, 120)), el('div', 'mg-meta', `${MG_LABEL[kind]} · ${who} · ${when} · ${fmtSize(size)}`));
    li.append(box, ic, info);
    li.onclick = () => goToMessage(ev.id); // the checkbox selects; the row jumps to the message
    list.append(li);
  }
  syncManagerTools();
}

// Close the manager and bring the message into view, loading older history
// pages until it shows up.
async function goToMessage(id) {
  $('manage-modal').hidden = true;
  if (!messages.has(id) && histMore) {
    toast('در حال پیدا کردن پیام…');
    for (let i = 0; i < 40 && !messages.has(id) && histMore; i++) {
      while (histLoading) await sleep(50);
      await loadHistory(false);
    }
  }
  const m = messages.get(id);
  if (!m) { toast('این پیام دیگر در گفتگو نیست'); return; }
  const target = m.stack ? m.stack.el : m.el;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
}

function syncManagerTools() {
  const n = mgSelected.size;
  $('mg-count').textContent = n ? `${fa(n)} مورد انتخاب شده` : '';
  $('mg-del').disabled = !n;
  const visible = mgItems.filter((ev) => mgFilter === 'all' || MG_KIND(ev) === mgFilter);
  $('mg-all').checked = visible.length > 0 && visible.every((ev) => mgSelected.has(ev.id));
}

function bindManager() {
  $('mg-close').onclick = () => { $('manage-modal').hidden = true; };
  $('manage-modal').addEventListener('click', (e) => { if (e.target === $('manage-modal')) $('manage-modal').hidden = true; });
  $('mg-filter').onclick = (e) => {
    const f = e.target.closest('button')?.dataset.f;
    if (!f) return;
    mgFilter = f;
    renderManager();
  };
  $('mg-all').onchange = () => {
    const visible = mgItems.filter((ev) => mgFilter === 'all' || MG_KIND(ev) === mgFilter);
    for (const ev of visible) { if ($('mg-all').checked) mgSelected.add(ev.id); else mgSelected.delete(ev.id); }
    renderManager();
  };
  $('mg-del').onclick = async () => {
    const ids = [...mgSelected];
    if (!ids.length) return;
    if (!(await ask('حذف برای همه', `${fa(ids.length)} مورد از سرور و از همه‌ی دستگاه‌ها پاک می‌شود. مطمئنید؟`, 'بله، پاک کن'))) return;
    if (!(await deleteForAll(ids))) return;
    mgItems = mgItems.filter((ev) => !mgSelected.has(ev.id));
    mgSelected.clear();
    renderManager();
    renderUsage(await fetchUsage());
    toast('پاک شد');
  };
}

// ---------- confidential text (anti-zoom) ----------
// Message text stays blurred and is shown only while a finger rests on the
// bubble (or the mouse hovers it), so it can't be read from across the room.
let veilOn = (() => { try { return localStorage.getItem('najva:veil') !== '0'; } catch { return true; } })();
function applyVeil() {
  document.body.classList.toggle('veil', veilOn);
  $('veil-switch').classList.toggle('on', veilOn);
}
function bindVeil() {
  $('messages').addEventListener('pointerdown', (e) => {
    const m = e.target.closest('.msg, .act');
    if (m && veilOn) m.classList.add('peek');
  });
  // The Instagram post sheet: hold the picture or the text to see it.
  $('ig-modal').addEventListener('pointerdown', (e) => {
    if (veilOn && e.target.closest('.igm-media, .igm-title, .igm-note, .igm-replies')) $('ig-modal').classList.add('peek');
  });
  const unpeek = () => { for (const m of document.querySelectorAll('.peek')) m.classList.remove('peek'); };
  window.addEventListener('pointerup', unpeek);
  window.addEventListener('pointercancel', unpeek);
  window.addEventListener('blur', unpeek);
  applyVeil();
}

// ---------- gif picker ----------
const GIF_TOPICS = [['❤️ عاشقانه', 'love'], ['😂 خنده', 'laugh'], ['😘 بوس', 'kiss'], ['🤗 بغل', 'hug'], ['😢 ناراحت', 'sad'], ['😍 دلتنگ', 'miss you'], ['👋 سلام', 'hello'], ['🙏 ممنون', 'thank you'], ['🎂 تولد', 'happy birthday'], ['😴 شب بخیر', 'good night']];
let gifSeq = 0;

function buildGifTopics() {
  const row = $('gif-topics');
  for (const [label, q] of GIF_TOPICS) {
    const b = el('button', 'chip-btn', label);
    b.type = 'button';
    b.onclick = () => { $('gif-q').value = ''; searchGifs(q); };
    row.append(b);
  }
}

async function searchGifs(q) {
  q = q.trim();
  if (!q) return;
  const seq = ++gifSeq;
  const grid = $('gif-grid');
  grid.textContent = '';
  grid.append(el('div', 'gif-msg', 'در حال جستجو…'));
  let items = null;
  let err = '';
  try {
    const ask = () => fetch('/gif/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }), credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const r = await ask().catch(() => ask()); // one retry if the first request stalls
    if (r.status === 429) err = 'سقف جستجوی این ساعت پر شده؛ کمی بعد دوباره امتحان کنید';
    else if (!r.ok) err = 'جستجو انجام نشد';
    else items = (await r.json()).items;
  } catch {
    err = 'جستجو انجام نشد';
  }
  if (seq !== gifSeq) return;
  resetGifPreviews();
  grid.textContent = '';
  if (err || !items?.length) { grid.append(el('div', 'gif-msg', err || 'چیزی پیدا نشد')); return; }
  for (const it of items) {
    if (typeof it.thumb !== 'string' || !it.thumb.startsWith('/gif/m?') || typeof it.send !== 'string' || !it.send.startsWith('/gif/m?')) continue;
    const b = el('button', 'gif-cell loading');
    b.type = 'button';
    b._src = it.send;
    b.onclick = () => pickGif(it.send);
    grid.append(b);
    gifObserver().observe(b);
  }
}

// Previews play: each cell shows the same tiny animated file that would be
// sent, fetched once when it scrolls into view (a few at a time) and reused
// when it is picked.
const gifPrev = { blobs: new Map(), urls: [], queue: [], active: 0, seq: 0, io: null };
function gifObserver() {
  gifPrev.io ??= new IntersectionObserver((list) => {
    for (const e of list) {
      if (!e.isIntersecting) continue;
      gifPrev.io.unobserve(e.target);
      gifPrev.queue.push(e.target);
    }
    pumpGifPreviews();
  }, { root: $('gif-grid'), rootMargin: '160px' });
  return gifPrev.io;
}

async function fetchGif(src) {
  const get = () => fetch(src, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const r = await get().catch(() => get());
  if (!r.ok) throw new Error('gif');
  const blob = await r.blob();
  if (!/^image\/(gif|webp)$/.test(blob.type) || blob.size > 2 * 1024 * 1024) throw new Error('type');
  return blob;
}

function pumpGifPreviews() {
  while (gifPrev.active < 6 && gifPrev.queue.length) {
    const cell = gifPrev.queue.shift();
    if (!cell.isConnected) continue;
    const seq = gifPrev.seq;
    gifPrev.active++;
    fetchGif(cell._src)
      .then((blob) => {
        if (seq !== gifPrev.seq || !cell.isConnected) return;
        gifPrev.blobs.set(cell._src, blob);
        const url = URL.createObjectURL(blob);
        gifPrev.urls.push(url);
        const img = new Image();
        img.alt = '';
        img.draggable = false;
        img.onload = () => cell.classList.remove('loading');
        img.onerror = () => cell.remove();
        img.src = url;
        cell.append(img);
      })
      .catch(() => { if (seq === gifPrev.seq) cell.remove(); }) // a GIF that no longer exists
      .finally(() => { gifPrev.active--; pumpGifPreviews(); });
  }
}

function resetGifPreviews() {
  gifPrev.seq++;
  gifPrev.queue.length = 0;
  gifPrev.io?.disconnect();
  for (const u of gifPrev.urls) URL.revokeObjectURL(u);
  gifPrev.urls.length = 0;
  gifPrev.blobs.clear();
}

async function pickGif(src) {
  closePanels();
  try {
    const blob = gifPrev.blobs.get(src) || await fetchGif(src);
    await sendFile(new File([blob], blob.type === 'image/gif' ? 'gif.gif' : 'gif.webp', { type: blob.type }), true);
  } catch {
    toast('ارسال گیف انجام نشد');
  }
}

// ---------- double-tap ----------
// Double-tap a message: ❤️. Double-tap anywhere else in the chat: lock now.
let lastTouchTapAt = 0;
function bindDoubleTap() {
  let last = null;
  const ignore = 'input, textarea, button, a, select, .composer-wrap, .popover, .emoji-panel, .gif-panel, .media-wrap, .ig-card, .ig-stack, .act-run, .share-card, .react-bar, .voice-msg, .quote';
  $('chat').addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    if (touchIds.size > 0) { last = null; return; } // another finger still down: not a tap
    if (Date.now() - swipeEndAt < 400) { last = null; return; } // end of a swipe-to-reply
    const now = Date.now();
    const target = e.target.closest?.('.msg') ? 'msg' : e.target.closest?.(ignore) ? null : 'bg';
    const msgEl = e.target.closest?.('.msg');
    if (last && now - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40 && last.target === target && last.el === msgEl) {
      last = null;
      lastTouchTapAt = now;
      if (target === 'bg') lockNow();
      else if (target === 'msg' && !e.target.closest(ignore)) [...messages.values()].find((m) => m.el === msgEl)?.heart?.();
      return;
    }
    last = target ? { t: now, x: e.clientX, y: e.clientY, target, el: msgEl } : null;
  });
  // Mouse: double-click on empty chat area locks too.
  $('chat').addEventListener('dblclick', (e) => {
    if (Date.now() - lastTouchTapAt < 800) return;
    if (!e.target.closest('.msg') && !e.target.closest(ignore)) lockNow();
  });
}

// ---------- swipe to reply ----------
// Like WhatsApp: drag a message to the left with one finger and let go to
// reply to it. Only a clearly horizontal drag starts it, so scrolling, the
// two-finger media hold, long-press and double-tap keep working.
const SWIPE_REPLY_PX = 64;
const SWIPE_MAX_PX = 96;
let swipeEndAt = 0;
function bindSwipeReply() {
  const list = $('messages');
  let s = null; // { li, entry, id, x, y, active, armed, ic }
  const finish = (reply) => {
    const cur = s;
    s = null;
    if (!cur?.active) return;
    swipeEndAt = Date.now();
    cur.li.classList.remove('swiping', 'swipe-armed');
    cur.li.classList.add('swipe-back');
    cur.li.style.transform = '';
    cur.li.style.removeProperty('--swipe');
    setTimeout(() => { cur.li.classList.remove('swipe-back'); cur.ic.remove(); }, 220);
    if (reply && messages.get(cur.entry.id) === cur.entry) setReplyTo(cur.entry);
  };
  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || s || touchIds.size > 1) return;
    const li = e.target.closest('.msg');
    if (!li?._entry || li.classList.contains('failed')) return;
    s = { li, entry: li._entry, id: e.pointerId, x: e.clientX, y: e.clientY, active: false, armed: false, ic: null };
  });
  list.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    if (touchIds.size > 1) { finish(false); return; } // a second finger: media hold, not a swipe
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { s = null; return; } // scrolling
      if (!(dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.6)) return;
      s.active = true;
      pendingMedia = null; // not a press on the photo/video any more
      clearTimeout(keepTimer);
      s.ic = el('span', 'swipe-ic');
      s.ic.append(icon('reply'));
      s.li.append(s.ic);
      s.li.classList.add('swiping');
      try { s.li.setPointerCapture(e.pointerId); } catch {}
    }
    // Follow the finger, with resistance past the reply point.
    const pull = -dx;
    const d = pull <= SWIPE_REPLY_PX ? pull : Math.min(SWIPE_MAX_PX, SWIPE_REPLY_PX + (pull - SWIPE_REPLY_PX) * 0.35);
    s.li.style.transform = `translateX(${-Math.max(0, d)}px)`;
    s.li.style.setProperty('--swipe', String(Math.min(1, Math.max(0, d) / SWIPE_REPLY_PX)));
    const armed = d >= SWIPE_REPLY_PX;
    if (armed !== s.armed) {
      s.armed = armed;
      s.li.classList.toggle('swipe-armed', armed);
      if (armed) navigator.vibrate?.(12);
    }
  });
  list.addEventListener('pointerup', (e) => { if (s && e.pointerId === s.id) finish(s.armed); });
  list.addEventListener('pointercancel', (e) => { if (s && e.pointerId === s.id) finish(false); });
  // A swipe must not also count as a tap on what is under the finger.
  list.addEventListener('click', (e) => {
    if (Date.now() - swipeEndAt < 400) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

// ---------- voice messages ----------
// Recorded on this device (through the female-voice filter when it is on),
// then sent like any other file: a fresh AES key, encrypted chunks, and an
// encrypted history entry. Duration and a coarse level outline travel inside
// the encrypted message so the bubble can draw a waveform.
const VOICE_MAX_S = 600;
const VOICE_MIN_MS = 700;
const VOICE_BARS = 40;
const VOICE_MAX_BYTES = 20 * 1024 * 1024; // 10 minutes of 16 kHz WAV, with room to spare
// Voice messages are plain 16 kHz 16-bit WAV: every browser on every platform
// plays it (MediaRecorder's formats differ per platform and do not).
const VOICE_RATE = 16000;
// Versioned: the file is cached for a day (by browsers and Cloudflare), so a
// new build must get a new address.
const FX_URL = '/voicefx-worklet.js?v=5';
const CAN_RECORD = !!(navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode);
const voice = { audio: new Audio(), entry: null };
voice.audio.preload = 'auto';
let rec = null;
let textSentAt = 0;
let micReadyAt = 0;

function voiceFields(o, mime) {
  if (o.kind !== 'voice' || !AUDIO_RE.test(mime) || !(o.size <= VOICE_MAX_BYTES)) return null;
  const dur = Number.isFinite(o.dur) ? Math.max(0, Math.min(VOICE_MAX_S, Math.round(o.dur))) : 0;
  let wave = null;
  if (typeof o.wave === 'string' && o.wave.length <= 120) {
    try { const w = unb64u(o.wave); if (w.length <= 64) wave = w; } catch {}
  }
  return { dur, wave, reply: sanitizeReply(o.reply) };
}

// Levels (0..255) resampled to the bubble's bar count, as 0..1.
function waveBars(w) {
  const src = typeof w === 'string' ? (() => { try { return unb64u(w); } catch { return null; } })() : w;
  const out = new Array(VOICE_BARS);
  for (let i = 0; i < VOICE_BARS; i++) {
    out[i] = src?.length ? src[Math.min(src.length - 1, Math.floor((i * src.length) / VOICE_BARS))] / 255 : 0.3;
  }
  return out;
}

function renderVoice(entry, blob, meta) {
  entry.blob = blob;
  entry.url = URL.createObjectURL(blob);
  entry.voiceDur = meta.dur || 0;
  if (meta.reply) entry.content.append(quoteBlock(meta.reply));
  const card = el('div', 'voice-msg');
  const play = el('button', 'voice-play');
  play.type = 'button';
  play.setAttribute('aria-label', 'پخش پیام صوتی');
  play.append(icon('play'));
  play.onclick = (e) => { e.stopPropagation(); toggleVoice(entry); };
  const wave = el('div', 'voice-wave');
  for (const v of waveBars(meta.wave)) {
    const b = el('i');
    b.style.height = `${Math.round(14 + v * 86)}%`;
    wave.append(b);
  }
  wave.onclick = (e) => { e.stopPropagation(); seekVoice(entry, e); };
  const time = el('span', 'voice-time', fmtDuration(entry.voiceDur));
  card.append(play, wave, time);
  entry.content.append(card);
  entry.voiceUi = { play, time, bars: [...wave.children] };
  entry.el.classList.remove('media');
  entry.el.classList.add('voice');
}

function voiceLength(entry) {
  const d = voice.audio.duration;
  return Number.isFinite(d) && d > 0 ? d : entry.voiceDur || 0; // recorder WebM often has no duration
}

function syncVoiceUi(entry) {
  const ui = entry?.voiceUi;
  if (!ui) return;
  const active = voice.entry === entry;
  const a = voice.audio;
  const len = voiceLength(entry);
  const at = active ? a.currentTime : 0;
  const lit = len ? Math.round(Math.min(1, at / len) * ui.bars.length) : 0;
  ui.bars.forEach((b, i) => b.classList.toggle('on', i < lit));
  ui.time.textContent = fmtDuration(Math.max(0, Math.round(active && at > 0 ? len - at : len)));
  setIconBtn(ui.play, active && !a.paused ? 'pause' : 'play');
}

// play() rejections other than "can't play this format" (a pause, the lock
// screen) are not failures.
const playVoice = (entry) => voice.audio.play().catch((e) => { if (e?.name === 'NotSupportedError') voiceFallback(entry); });

function toggleVoice(entry) {
  if (voice.entry === entry) {
    if (voice.audio.paused) playVoice(entry); else voice.audio.pause();
    return;
  }
  stopVoice();
  voice.entry = entry;
  voice.audio.src = entry.wavUrl || entry.url;
  playVoice(entry);
  syncVoiceUi(entry);
}

function seekVoice(entry, e) {
  const r = e.currentTarget.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  if (voice.entry !== entry) toggleVoice(entry);
  const len = voiceLength(entry);
  if (len) { try { voice.audio.currentTime = p * len; } catch {} }
  syncVoiceUi(entry);
}

function stopVoice() {
  const e = voice.entry;
  voice.entry = null;
  voice.audio.pause();
  voice.audio.removeAttribute('src');
  voice.audio.load();
  syncVoiceUi(e);
}

// A recording from another platform may not play in this browser's <audio>
// (e.g. WebM/Opus on older Safari): decode it with Web Audio and play a WAV.
async function voiceFallback(entry) {
  if (entry.wavState === 'trying') return; // the error event and play() can both report the same failure
  if (entry.wavState === 'done' || entry.wavState === 'failed') {
    if (voice.entry === entry && entry.wavState === 'failed') toast('این پیام صوتی روی این مرورگر پخش نمی‌شود');
    return;
  }
  entry.wavState = 'trying';
  try {
    // 16 kHz is plenty for speech and keeps a hostile file's decoded size small.
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 16000);
    const buf = await ctx.decodeAudioData(await entry.blob.arrayBuffer());
    if (buf.duration > VOICE_MAX_S + 30) throw new Error('too long');
    if (!messages.has(entry.id)) return; // deleted meanwhile: no decrypted copy left behind
    entry.wavUrl = URL.createObjectURL(toWav(buf));
    entry.wavState = 'done';
    if (voice.entry !== entry || locked || document.hidden) return;
    voice.audio.src = entry.wavUrl;
    await voice.audio.play().catch(() => {});
  } catch {
    entry.wavState = 'failed';
    if (voice.entry === entry) toast(`این پیام صوتی (${entry.blob?.type || 'نامشخص'}) روی این مرورگر پخش نمی‌شود`);
  }
}

function toWav(buf) {
  const ch = buf.getChannelData(0);
  const n = ch.length;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * 2, true);
  out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, ch[i])) * 0x7fff, true);
  return new Blob([out], { type: 'audio/wav' });
}

for (const ev of ['play', 'pause', 'timeupdate', 'loadedmetadata']) voice.audio.addEventListener(ev, () => syncVoiceUi(voice.entry));
voice.audio.addEventListener('ended', () => { const e = voice.entry; stopVoice(); syncVoiceUi(e); });
voice.audio.addEventListener('error', () => { if (voice.entry && voice.audio.getAttribute('src')) voiceFallback(voice.entry); });
// An incoming voice message counts as read once it actually starts playing.
voice.audio.addEventListener('playing', () => {
  const e = voice.entry;
  if (!e?.awaitPlay) return;
  e.awaitPlay = false;
  visibleUnread.add(e);
  checkReads();
});
// Voice messages and music never play over each other.
voice.audio.addEventListener('play', () => { if (!player.audio.paused) player.audio.pause(); });
player.audio.addEventListener('play', () => { if (!voice.audio.paused) voice.audio.pause(); });

// Recording. The AudioContext is created right inside the tap, because
// mobile browsers only let a page start audio during a user gesture.
async function startRecording(mode) {
  if (rec || !CAN_RECORD) return;
  if (call) { toast('هنگام تماس نمی‌شود پیام صوتی ضبط کرد'); return; }
  voice.audio.pause(); // nothing playing may end up in the recording
  player.audio.pause();
  const r = rec = { state: 'starting', mode, chunks: [], peaks: [], ctx: newAudioContext(), send: false, fxAsked: voiceFxOn };
  showRecUi();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch {
    endRec(r);
    toast('دسترسی به میکروفون داده نشد');
    return;
  }
  r.stream = stream;
  if (rec !== r) { endRec(r); return; }
  try {
    if (!r.ctx) throw new Error('audio');
    await r.ctx.audioWorklet.addModule(FX_URL);
    if (rec !== r) { endRec(r); return; }
    const src = r.ctx.createMediaStreamSource(stream);
    r.pcm = pcmStore();
    const resample = makeResampler(r.ctx.sampleRate, VOICE_RATE, r.pcm);
    r.capture = new AudioWorkletNode(r.ctx, 'najva-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    r.capture.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) { if (!r.captureDone) resample(e.data); } else if (e.data?.done) r.onCaptured?.();
    };
    // A silent path to the speakers keeps the capture node running everywhere.
    const mute = r.ctx.createGain();
    mute.gain.value = 0;
    src.connect(r.capture);
    r.capture.connect(mute);
    mute.connect(r.ctx.destination);
    r.analyser = r.ctx.createAnalyser();
    r.analyser.fftSize = 1024;
    r.level = new Float32Array(r.analyser.fftSize);
    src.connect(r.analyser);
  } catch {
    const cancelled = rec !== r;
    endRec(r);
    if (!cancelled) toast('ضبط صدا روی این مرورگر ممکن نیست');
    return;
  }
  if (rec !== r) { endRec(r); return; }
  r.state = 'recording';
  r.t0 = Date.now();
  navigator.vibrate?.(15);
  r.tick = setInterval(() => recTick(r), 80);
  showRecUi();
}

function recTick(r) {
  if (rec !== r) return;
  const s = (Date.now() - r.t0) / 1000;
  $('rec-time').textContent = fmtDuration(Math.floor(s));
  r.analyser.getFloatTimeDomainData(r.level);
  let sum = 0;
  for (const v of r.level) sum += v * v;
  const lvl = Math.min(1, Math.sqrt(sum / r.level.length) * 4);
  r.peaks.push(lvl);
  const bars = $('rec-level').children;
  for (let i = 0; i < bars.length; i++) {
    const v = r.peaks[r.peaks.length - bars.length + i] || 0;
    bars[i].style.height = `${Math.round(8 + Math.sqrt(v) * 92)}%`;
  }
  if (s >= VOICE_MAX_S) { r.capped = true; stopRecording(true); }
}

function stopRecording(send) {
  const r = rec;
  if (!r) return;
  rec = null;
  micReadyAt = Date.now() + 600;
  showRecUi();
  clearInterval(r.tick);
  if (r.state !== 'recording') { endRec(r); return; } // still starting: nothing recorded yet
  r.t1 = Date.now();
  r.send = send;
  if (send && r.t1 - r.t0 < VOICE_MIN_MS) { r.send = false; toast('پیام صوتی خیلی کوتاه بود'); }
  // The capture node hands over its last samples, then says it is done.
  const done = () => {
    if (r.captureDone) return;
    r.captureDone = true;
    clearTimeout(r.stopTimer);
    finishRecording(r);
  };
  r.onCaptured = done;
  r.stopTimer = setTimeout(done, 1500);
  try { r.capture.port.postMessage('stop'); } catch { done(); }
}

function cancelRecording() { if (rec) stopRecording(false); }

function endRec(r) {
  if (rec === r) { rec = null; showRecUi(); }
  clearInterval(r.tick);
  clearTimeout(r.stopTimer);
  r.stream?.getTracks().forEach((t) => t.stop());
  try { r.capture?.disconnect(); } catch {}
  if (r.capture) r.capture.port.onmessage = null;
  r.ctx?.close().catch(() => {});
  r.ctx = null;
}

async function finishRecording(r) {
  let pcm = r.pcm?.take() || null;
  r.pcm = null;
  endRec(r);
  if (!r.send) return;
  if (!pcm?.length) { toast('ضبط پیام صوتی انجام نشد'); return; }
  // Hands-free recording that ran into the limit: the user may have walked away.
  if (r.capped && r.mode === 'locked' && !(await ask('سقف پیام صوتی', `ضبط به سقف ${fa(10)} دقیقه رسید و متوقف شد. ارسال شود؟`, 'ارسال', false))) return;
  let rate = VOICE_RATE;
  let peaks = r.peaks;
  const reply = replyTo;
  if (r.fxAsked) {
    // Anonymous voice message: what was said is read out by an AI voice made
    // here, on this device. The real voice is never sent.
    let out;
    try {
      out = await aiVoiceNote(pcm);
    } catch {
      hint('');
      out = undefined;
    }
    if (out === null) return; // cancelled
    if (!out) {
      if (!(await ask('صدای هوش مصنوعی ساخته نشد', 'به‌جایش با صدای رباتیک ناشناس فرستاده شود؟', 'ارسال رباتیک', false))) return;
      hint('در حال ساختن صدای رباتیک…');
      try {
        out = { pcm: await processVoiceFx(pcm, VOICE_RATE), rate: VOICE_RATE };
      } catch {
        hint('');
        toast('تغییر صدا انجام نشد؛ پیام صوتی ارسال نشد');
        return;
      }
      hint('');
    }
    ({ pcm, rate } = out);
    peaks = levels(pcm, rate); // the outline of the new voice, not of the speaker's
  }
  const blob = encodeWav(pcm, rate);
  const dur = pcm.length / rate;
  // Waveform outline: the loudest level in each slice, square-root scaled.
  const w = new Uint8Array(VOICE_BARS);
  const peak = Math.max(0.05, ...peaks);
  for (let i = 0; i < VOICE_BARS; i++) {
    const a = Math.floor((i * peaks.length) / VOICE_BARS);
    const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / VOICE_BARS));
    let m = 0;
    for (let j = a; j < b && j < peaks.length; j++) m = Math.max(m, peaks[j]);
    w[i] = Math.round(Math.sqrt(m / peak) * 255);
  }
  if (replyTo === reply) clearReply();
  sendFile(new File([blob], 'voice.wav', { type: 'audio/wav' }), false, { voice: true, dur, wave: b64u(w), reply });
}

// Loudness every 80 ms, like the live meter while recording.
function levels(pcm, rate) {
  const n = Math.round(rate * 0.08);
  const out = [];
  for (let i = 0; i < pcm.length; i += n) {
    let s = 0;
    const e = Math.min(pcm.length, i + n);
    for (let k = i; k < e; k++) s += pcm[k] * pcm[k];
    out.push(Math.min(1, Math.sqrt(s / (e - i)) * 4));
  }
  return out;
}

// ---------- AI voice (voice messages) ----------
// Speech -> text -> a female AI voice, entirely on this device (ai-voice.js:
// Vosk + a VITS model in WASM). The models (~190 MB) are downloaded from this
// site the first time and cached. The text is shown for correction first.
let aiVoice = null;
const aiMod = () => (aiVoice ??= import('/ai-voice.js?v=1').catch((e) => { aiVoice = null; throw e; }));

// -> { pcm, rate } | null (cancelled); throws if the voice can't be made.
async function aiVoiceNote(pcm16k) {
  const ai = await aiMod();
  const pct = (p) => fa(Math.round(p * 100));
  hint('در حال آماده‌سازی تبدیل گفتار به متن (فقط بار اول کمی طول می‌کشد)…');
  const voiceLoad = ai.loadVoice(); // in parallel; its own progress is shown below
  voiceLoad.catch(() => {});
  let text = '';
  try {
    await ai.loadAsr((p) => hint(`دریافت مدل تشخیص گفتار: ${pct(p)}٪`));
    hint('در حال تبدیل صدا به متن…');
    text = await ai.transcribe(pcm16k);
  } catch {
    text = ''; // still lets the user type it
  }
  hint('');
  for (;;) {
    text = await askVoiceText(text);
    if (text === null) return null;
    try {
      hint('در حال ساختن صدای هوش مصنوعی…');
      const out = await ai.speak(text, (p) => hint(p < 1 ? `دریافت صدای هوش مصنوعی (فقط بار اول): ${pct(p)}٪` : 'در حال ساختن صدای هوش مصنوعی…'));
      hint('');
      return out;
    } catch (e) {
      hint('');
      if (e?.message !== 'empty') throw e;
      toast('متنی برای خواندن نیست');
    }
  }
}

function askVoiceText(text) {
  return new Promise((resolve) => {
    const d = $('aiv-dlg');
    const t = $('aiv-text');
    t.value = text;
    const done = (v) => {
      $('aiv-ok').onclick = $('aiv-cancel').onclick = d.oncancel = null;
      if (d.open) d.close();
      resolve(v);
    };
    $('aiv-ok').onclick = () => { const v = t.value.trim(); if (v) done(v); else t.focus(); };
    $('aiv-cancel').onclick = () => done(null);
    d.oncancel = (e) => { e.preventDefault(); done(null); };
    closePanels();
    d.showModal();
    if (!text) t.focus();
  });
}

// Growable store of 16 kHz samples (one-second blocks, no giant arrays).
function pcmStore() {
  const blocks = [];
  let cur = new Float32Array(VOICE_RATE);
  let n = 0;
  return {
    push(v) {
      cur[n++] = v;
      if (n === cur.length) { blocks.push(cur); cur = new Float32Array(VOICE_RATE); n = 0; }
    },
    take() {
      const all = new Float32Array(blocks.length * VOICE_RATE + n);
      let o = 0;
      for (const b of blocks) { all.set(b, o); o += b.length; }
      all.set(cur.subarray(0, n), o);
      blocks.length = 0;
      return all;
    },
  };
}

// Streaming resampler: 2nd-order low-pass below the new Nyquist, then linear
// interpolation. Plenty for speech.
function makeResampler(srIn, srOut, store) {
  const fc = Math.min(srOut, srIn) * 0.45;
  const w = (2 * Math.PI * fc) / srIn;
  const cw = Math.cos(w);
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const b0 = (1 - cw) / 2 / (1 + al);
  const b1 = (1 - cw) / (1 + al);
  const a1 = (-2 * cw) / (1 + al);
  const a2 = (1 - al) / (1 + al);
  const step = srIn / srOut;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, prev = 0, pos = 0;
  return (block) => {
    for (let i = 0; i < block.length; i++) {
      const x = block[i];
      const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      while (pos <= i) { store.push(prev + (y - prev) * (pos - (i - 1))); pos += step; }
      prev = y;
    }
    pos -= block.length;
  };
}

function encodeWav(x, rate) {
  const n = x.length;
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 0x7fff, true);
  return new Blob([v], { type: 'audio/wav' });
}

// Runs the female-voice engine over a finished recording, in small slices so
// the page stays responsive. Uses the higher-quality engine: no real-time limit.
async function processVoiceFx(pcm, rate) {
  const mod = await import(FX_URL);
  const p = VOICE_NOTE_FX;
  const Engine = mod[{ psola: 'PsolaFx', robot: 'RobotFx' }[p.engine] || 'VocoderFx'];
  const fx = new Engine(rate, p);
  fx.setParams(p);
  const lat = Math.max(0, fx.latencySamples | 0);
  const out = new Float32Array(pcm.length);
  const inB = new Float32Array(128);
  const outB = new Float32Array(128);
  let t0 = performance.now();
  for (let i = 0; i < pcm.length + lat; i += 128) {
    inB.fill(0);
    if (i < pcm.length) inB.set(pcm.subarray(i, Math.min(pcm.length, i + 128)));
    fx.process(inB, outB);
    for (let k = 0; k < 128; k++) {
      const t = i + k - lat;
      if (t >= 0 && t < out.length) out[t] = outB[k];
    }
    if (performance.now() - t0 > 20) { await new Promise((res) => setTimeout(res, 0)); t0 = performance.now(); }
  }
  return out;
}

function showRecUi() {
  const on = !!rec;
  const c = $('composer');
  c.classList.toggle('recording', on);
  c.classList.toggle('locked', on && rec.mode === 'locked');
  c.classList.toggle('holding', on && rec.mode === 'hold');
  $('rec-bar').hidden = !on;
  $('rec-bar').classList.remove('cancelling');
  $('rec-fx').hidden = !on || !rec.fxAsked;
  $('rec-hint').textContent = on && rec.mode === 'hold' ? 'رها کنید تا ارسال شود · برای لغو به کنار بکشید' : 'برای ارسال، دکمه را بزنید';
  if (!on) {
    $('rec-time').textContent = '0:00';
    for (const b of $('rec-level').children) b.style.height = '8%';
  }
  setIconBtn($('mic-btn'), on && rec.mode === 'locked' ? 'send' : 'mic');
  $('mic-btn').setAttribute('aria-label', on && rec.mode === 'locked' ? 'ارسال پیام صوتی' : 'ضبط پیام صوتی');
}

// Hold the mic to record and let go to send (slide away to cancel), or tap it
// once to record hands-free and tap again to send.
function bindVoice() {
  // Every client loads the filter module once (cached), whether or not it is
  // switched on, so fetching it never singles out who uses it.
  fetch(FX_URL, { credentials: 'omit', priority: 'low' }).catch(() => {});
  const mic = $('mic-btn');
  const lv = $('rec-level');
  for (let i = 0; i < 28; i++) lv.append(el('i'));
  let hold = null;
  mic.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    // The mic takes Send's place once the text is sent, and stays put after a
    // voice message is sent: a quick second tap must not start a recording.
    if (!rec && (Date.now() - textSentAt < 700 || Date.now() < micReadyAt)) return;
    if (rec) {
      if (rec.mode === 'locked') stopRecording(true);
      return;
    }
    hold = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
    try { mic.setPointerCapture(e.pointerId); } catch {}
    startRecording('hold');
  });
  mic.addEventListener('pointermove', (e) => {
    if (!hold || e.pointerId !== hold.id || !rec) return;
    $('rec-bar').classList.toggle('cancelling', Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 80);
  });
  const up = (e) => {
    if (!hold || e.pointerId !== hold.id) return;
    const h = hold;
    hold = null;
    if (!rec) return;
    // The browser's microphone prompt can steal the touch: keep the recording going.
    if (e.type === 'pointercancel' && rec.state !== 'recording') { rec.mode = 'locked'; showRecUi(); return; }
    if (e.type === 'pointercancel' || Math.hypot(e.clientX - h.x, e.clientY - h.y) > 80) { stopRecording(false); return; }
    // A tap, or let go while the browser was still asking for the microphone:
    // keep recording until the send button is tapped.
    if (rec.state !== 'recording' || Date.now() - h.t < 400) { rec.mode = 'locked'; showRecUi(); return; }
    stopRecording(true);
  };
  mic.addEventListener('pointerup', up);
  mic.addEventListener('pointercancel', up);
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
  mic.addEventListener('click', (e) => e.preventDefault()); // it sits in the composer form
  $('rec-cancel').onclick = () => cancelRecording();
}

// ---------- female voice ----------
// Optional, off by default. When on, the microphone goes through an on-device
// AudioWorklet (voicefx-worklet.js) that raises the pitch and moves the
// formants like a woman's voice, before encryption: in calls and in voice
// messages. Nothing about it reaches the server.
// "Anonymous voice": a robotic voice with a fixed, neutral pitch - no gender,
// none of the speaker's own character (calls in real time, voice messages
// after recording).
const VOICE_FX_PARAMS = { engine: 'robot', f0: 155, formant: 1.18, ring: 0.15, smooth: 40, mix: 1 };
const VOICE_NOTE_FX = { engine: 'robot', f0: 155, formant: 1.18, ring: 0.15, smooth: 40, mix: 1 };
let voiceFxOn = (() => { try { return localStorage.getItem('najva:voicefx') === '1'; } catch { return false; } })();

function newAudioContext() {
  try {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

async function attachVoiceFx(ctx, src) {
  if (!ctx.audioWorklet) throw new Error('no AudioWorklet');
  await ctx.audioWorklet.addModule(FX_URL);
  const node = new AudioWorkletNode(ctx, 'najva-voicefx', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: VOICE_FX_PARAMS,
  });
  const dest = ctx.createMediaStreamDestination();
  src.connect(node);
  node.connect(dest);
  const fx = {
    node, src, stream: dest.stream, track: dest.stream.getAudioTracks()[0],
    // Feed a different microphone stream into the same filter (output track unchanged).
    rewire(stream) { try { fx.src.disconnect(); } catch {} fx.src = ctx.createMediaStreamSource(stream); fx.src.connect(node); },
    close() { try { fx.src.disconnect(); node.disconnect(); } catch {} fx.track?.stop(); },
  };
  return fx;
}

function applyVoiceFxUi() {
  $('voicefx-switch').classList.toggle('on', voiceFxOn);
  $('call-fx').hidden = !call?.fx;
}

// In a call: route the microphone through the filter. If the filter cannot
// start, the microphone is muted rather than sending the real voice.
async function setupCallFx(c) {
  if (!voiceFxOn || c.fx) return;
  try {
    c.fxCtx ??= newAudioContext();
    if (!c.fxCtx) throw new Error('audio');
    c.fx = await attachVoiceFx(c.fxCtx, c.fxCtx.createMediaStreamSource(c.stream));
  } catch {
    c.fx = null;
    for (const t of c.stream.getAudioTracks()) t.enabled = false;
    setMuteIcon(true);
    toast('صدای ناشناس راه نیفتاد؛ میکروفون بی‌صدا شد. برای صحبت با صدای خودتان، دکمه‌ی میکروفون را بزنید.');
  }
  if (call === c) applyVoiceFxUi();
}

function closeCallFx(c) {
  c.fx?.close();
  c.fx = null;
}

const sendTrackOf = (c) => c.fx?.track || c.stream?.getAudioTracks()[0] || null;

// Switched from the menu during a call: swap what the call sends. Runs one at
// a time and re-reads the state after every await, so quick toggles settle on
// the final setting.
let callFxBusy = Promise.resolve();
function applyCallFx() {
  callFxBusy = callFxBusy.then(async () => {
    const c = call;
    if (!c?.stream) return;
    const audioSender = () => c.pc?.getSenders().find((s) => s.track?.kind === 'audio');
    if (voiceFxOn && !c.fx) {
      await setupCallFx(c);
      if (call !== c || !c.fx) return;
      const sender = audioSender(); // if there is none yet, addLocalTrack will use the filter
      if (sender) await sender.replaceTrack(c.fx.track).catch(() => {});
    } else if (!voiceFxOn && c.fx) {
      const sender = audioSender();
      if (sender) await sender.replaceTrack(c.stream.getAudioTracks()[0]).catch(() => {});
      closeCallFx(c);
    }
    if (call === c) applyVoiceFxUi();
  }).catch(() => {});
  return callFxBusy;
}

// ---------- updates ----------
// A tab left open keeps running old code. When a newer version is published
// (public/version.json), offer a reload; before entering a room, just reload.
// Bump APP_VERSION and version.json together on every release.
const APP_VERSION = '2026-10-15.1';
let updateOffered = false;
async function checkUpdate() {
  if (updateOffered || document.hidden) return;
  try {
    const r = await fetch('/version.json', { cache: 'no-store', credentials: 'omit' });
    const { v } = await r.json();
    if (typeof v !== 'string' || v === APP_VERSION) return;
    updateOffered = true;
    if ($('chat').hidden) { leaving = true; location.reload(); return; } // nothing to lose yet
    banner('نسخه‌ی جدید نجوا منتشر شده است. برای استفاده از آن صفحه را دوباره بارگذاری کنید؛ پیام‌ها رمزشده روی سرور هستند و برمی‌گردند.', {
      label: 'بارگذاری دوباره',
      fn: () => { leaving = true; location.replace(room.code ? `/#${room.code}` : '/'); }, // only the password is asked again
    });
  } catch {}
}

// ---------- emoji picker ----------
const EMOJI = {
  'شکلک‌ها': '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 😶 😐 😑 😬 🙄 😯 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 😈 👻 💀 🤡 💩 🙈 🙉 🙊',
  'عاشقانه': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💋 🌹 💐 🌸 🌷 💍 🫶 😻 💌 🥂',
  'دست‌ها': '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐 👋 👏 🙌 👐 🤲 🙏 💪 🤝 ✍️',
  'متفرقه': '🔥 ✨ 🎉 🎊 🎁 🎈 🌟 ⭐ 💫 ☀️ 🌙 🌈 ☕ 🍕 🍔 🍟 🍿 🍰 🎂 🍫 🍓 🍉 🍷 🍹 🎵 🎶 🎮 ⚽ 🚗 ✈️ 🏖 📷 🎬 💯 ✅ ❌ ❓ ❗ 💤 💬 👀 🐶 🐱 🐻 🐼 🦋 🌍',
};
function buildEmojiPanel() {
  const panel = $('emoji-panel');
  for (const [title, list] of Object.entries(EMOJI)) {
    panel.append(el('h4', '', title));
    const grid = el('div', 'emoji-grid');
    for (const e of list.split(' ')) {
      const b = el('button', '', e);
      b.type = 'button';
      b.onclick = (ev) => {
        ev.stopPropagation();
        const input = $('input');
        const start = input.selectionStart ?? input.value.length;
        input.setRangeText(e, start, input.selectionEnd ?? start, 'end');
        input.focus();
        autoGrow();
      };
      grid.append(b);
    }
    panel.append(grid);
  }
}

// ---------- confirm dialog ----------
// App-styled replacement for window.confirm(); resolves true/false.
function ask(title, text, okLabel = 'بله', danger = true) {
  return new Promise((resolve) => {
    const d = $('confirm-dlg');
    $('cf-title').textContent = title;
    $('cf-text').textContent = text;
    $('cf-ok').textContent = okLabel;
    $('cf-ok').classList.toggle('btn-danger', danger);
    $('cf-ok').classList.toggle('btn-primary', !danger);
    $('cf-icon').classList.toggle('danger', danger);
    const done = (v) => {
      $('cf-ok').onclick = $('cf-cancel').onclick = d.oncancel = null;
      if (d.open) d.close();
      resolve(v);
    };
    $('cf-ok').onclick = () => done(true);
    $('cf-cancel').onclick = () => done(false);
    d.oncancel = (e) => { e.preventDefault(); done(false); };
    closePanels();
    d.showModal();
    $('cf-cancel').focus();
  });
}

// ---------- chrome ----------
function notice(text, kind = '') {
  const li = el('li', `notice ${kind}`, text);
  $('messages').append(li);
  $('messages').scrollTop = $('messages').scrollHeight;
  setTimeout(() => li.remove(), 20000);
}

function banner(text, action) {
  const b = $('banner');
  b.hidden = !text;
  b.textContent = '';
  if (!text) return;
  const body = el('div');
  body.append(el('div', '', text));
  if (action) {
    const btn = el('button', 'btn btn-sm btn-ghost', action.label);
    btn.type = 'button';
    btn.style.marginTop = '8px';
    btn.onclick = action.fn;
    body.append(btn);
  }
  b.append(icon('alert'), body);
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
}

function hint(text) {
  const h = $('upload-hint');
  h.hidden = !text;
  h.textContent = text;
}

const STATUS = {
  connecting: ['در حال اتصال…', ''],
  waiting: ['منتظر ورود مخاطب — کد اتاق را برایش بفرستید', 'amber'],
  handshake: ['در حال تبادل کلید…', 'amber'],
  secure: ['آنلاین · رمزنگاری سرتاسری', 'green'],
  failed: ['احراز هویت ناموفق', 'red'],
  full: ['این اتاق پر است (حداکثر ۳ دستگاه)', 'red'],
  closed: ['ساخت اتاق جدید فعلاً غیرفعال است', 'red'],
  deleted: ['این اتاق توسط مدیر حذف شد', 'red'],
  kicked: ['اتصال این اتاق توسط مدیر قطع شد', 'red'],
};
function setStatus(key, n = 1) {
  const [base, color] = STATUS[key];
  const text = key === 'secure' && n > 1 ? `${base} · ${fa(n + 1)} دستگاه` : base;
  const st = $('status-text');
  st.textContent = '';
  if (key === 'secure') st.append(icon('lock'));
  st.append(document.createTextNode(text));
  st.classList.toggle('secure', key === 'secure');
  $('status-dot').className = `presence ${color}`;
  $('share-card').hidden = key !== 'waiting';
}

function updateTitle() {
  document.title = unread ? `(${fa(unread)}) نجوا` : 'نجوا';
}

function show(screen) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== screen;
}

function autoGrow() {
  const i = $('input');
  i.style.height = 'auto';
  i.style.height = Math.min(i.scrollHeight, 150) + 'px';
  $('send-btn').classList.toggle('idle', !i.value.trim());
  $('composer').classList.toggle('can-record', CAN_RECORD && !i.value.trim()); // empty box: the mic replaces send
}

function closePanels() {
  $('menu').hidden = true;
  $('ttl-menu').hidden = true;
  $('emoji-panel').hidden = true;
  $('gif-panel').hidden = true;
  $('react-bar').hidden = true;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('کپی شد'); }
  catch { toast('کپی نشد؛ دستی انتخاب کنید'); }
}

function sasDigits(s) {
  const n = s.sas.slice(0, 15);
  let digits = '';
  for (let i = 0; i < 15; i += 3) digits += String(((n[i] << 16) | (n[i + 1] << 8) | n[i + 2]) % 100000).padStart(5, '0');
  return digits.match(/.{5}/g).join(' ');
}

function showSafety() {
  const list = secureSessions();
  if (!list.length) { toast('هنوز ارتباط امن برقرار نشده'); return; }
  const box = $('safety-code');
  box.textContent = '';
  for (const s of list) {
    const row = el('div', 'sas-row');
    if (list.length > 1) row.append(el('div', 'sas-name', `با ${s.name || 'مخاطب'}`));
    row.append(el('div', 'sas-digits', sasDigits(s)));
    box.append(row);
  }
  const s = list[0];
  $('safety-meta').textContent = `${s.curve === 'x25519' ? 'X25519' : 'P-256'} · AES-256-GCM · ${fa(list.reduce((t, x) => t + x.rekeys, 0))} بار چرخش کلید در این جلسه`;
  $('safety').showModal();
}

function leave() {
  leaving = true;
  stopPlayer();
  hangupLocal('');
  clearMessages();
  serial(() => endAllSessions());
  if (ws) ws.close();
  wipe(room.psk, room.verifier);
  room.psk = room.verifier = room.pendingPass = null;
  room.code = room.id = '';
  location.replace('/');
}

// ---------- voice call ----------
const FE_SCRIPT = 'RTCRtpScriptTransform' in window;
const FE_LEGACY = !!(window.RTCRtpSender && 'createEncodedStreams' in RTCRtpSender.prototype);
const FE_SUPPORTED = FE_SCRIPT || FE_LEGACY;
let call = null;
const iceWaiters = [];

// TURN credentials expire; fetch fresh ones before every call.
function refreshIce() {
  return new Promise((resolve) => {
    iceWaiters.push(resolve);
    wireSend({ t: 'ice?' });
    setTimeout(resolve, 2000);
  });
}
const hasTurn = () => iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));

async function startCall() {
  if (!anySecure() || call) return;
  cancelRecording();
  const fxCtx = voiceFxOn ? newAudioContext() : null; // made inside the tap (mobile audio rules)
  let stream;
  try { stream = await getMic(); }
  catch { fxCtx?.close().catch(() => {}); toast('دسترسی به میکروفون داده نشد'); return; }
  await refreshIce();
  if (!anySecure() || call) { stream.getTracks().forEach((t) => t.stop()); fxCtx?.close().catch(() => {}); return; }
  call = { id: b64u(rand(9)), role: 'caller', secret: rand(32), stream, fxCtx, state: 'ringing', pending: [], peer: null, declined: new Set() };
  showCall('در حال زنگ زدن…', false);
  const c = call;
  await setupCallFx(c);
  if (call !== c) return;
  post({ k: 'call', op: 'ring', id: c.id, secret: b64u(c.secret), fe: FE_SUPPORTED })
    .then((targets) => { c.rang = new Set(targets); })
    .catch(() => hangupLocal(''));
  call.timeout = setTimeout(() => hangup('پاسخی داده نشد'), 45000);
}

// Call audio route. On phones a call starts on the earpiece (it is private);
// the speaker button switches to the loudspeaker. Browsers have no direct
// control for this, so:
//  - Android Chrome routes output along with the chosen "microphone": its
//    inputs include "Headset earpiece" and "Speakerphone".
//  - iOS Safari plays an <audio> element of a play-and-record session on the
//    receiver (earpiece), while Web Audio output goes to the loudspeaker.
// A connected headset or Bluetooth device always wins.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const audioRoute = { speaker: false, ctx: null, src: null };

async function routeInput(speaker) {
  if (!IS_ANDROID) return null;
  try {
    const ins = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    if (ins.some((d) => /bluetooth|wired|usb/i.test(d.label))) return null;
    const want = ins.find((d) => (speaker ? /speaker/i : /earpiece|handset|receiver/i).test(d.label));
    return want?.deviceId || null;
  } catch { return null; }
}

async function getMic(speaker = false) {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const open = (id) => navigator.mediaDevices.getUserMedia({ audio: id ? { ...base, deviceId: { exact: id } } : base, video: false });
  if (IS_IOS && navigator.audioSession) { try { navigator.audioSession.type = 'play-and-record'; } catch {} }
  const id = await routeInput(speaker);
  let stream = await open(id).catch((e) => { if (id) return open(null); throw e; });
  // The first time, device labels only appear after permission is granted.
  if (IS_ANDROID && !id) {
    const id2 = await routeInput(speaker);
    if (id2 && stream.getAudioTracks()[0]?.getSettings().deviceId !== id2) {
      try { const s2 = await open(id2); stream.getTracks().forEach((t) => t.stop()); stream = s2; } catch {}
    }
  }
  return stream;
}

async function setSpeaker(on) {
  const c = call;
  if (!c) return;
  audioRoute.speaker = on;
  $('speaker-btn').classList.toggle('off', on);
  $('speaker-btn').setAttribute('aria-pressed', String(on));
  if (IS_ANDROID && c.stream) {
    try {
      const ns = await getMic(on);
      if (call !== c) { ns.getTracks().forEach((t) => t.stop()); return; }
      const nt = ns.getAudioTracks()[0];
      const old = c.stream.getAudioTracks()[0];
      nt.enabled = old ? old.enabled : true;
      const sender = c.pc?.getSenders().find((s) => s.track?.kind === 'audio');
      if (c.fx) c.fx.rewire(ns);                    // the filter keeps sending its own track
      else if (sender) await sender.replaceTrack(nt); // the frame-encryption transform stays on the sender
      old?.stop();
      c.stream = ns;
    } catch { toast('تغییر خروجی صدا انجام نشد'); }
  } else if (IS_IOS) {
    const el = $('remote-audio');
    audioRoute.src?.disconnect();
    audioRoute.src = null;
    if (on && c.remote) {
      audioRoute.ctx ??= new AudioContext();
      audioRoute.ctx.resume().catch(() => {});
      audioRoute.src = audioRoute.ctx.createMediaStreamSource(c.remote);
      audioRoute.src.connect(audioRoute.ctx.destination);
      el.muted = true;
    } else {
      el.muted = false;
    }
  }
}

function resetAudioRoute() {
  audioRoute.speaker = false;
  audioRoute.src?.disconnect();
  audioRoute.src = null;
  audioRoute.ctx?.close().catch(() => {});
  audioRoute.ctx = null;
  $('remote-audio').muted = false;
  if (IS_IOS && navigator.audioSession) { try { navigator.audioSession.type = 'auto'; } catch {} }
}

async function onCallSignal(s, o) {
  if (o.op === 'ring') {
    if (call) { await sendInner(s, { k: 'call', op: 'busy', id: o.id }); return; }
    call = { id: o.id, role: 'callee', secret: unb64u(o.secret), peerFe: !!o.fe, state: 'incoming', pending: [], peer: s.peer };
    if (call.secret.length !== 32) { call = null; return; }
    showCall(`تماس صوتی از ${peerName(s.peer)}…`, true);
    ring(true);
    call.timeout = setTimeout(() => hangup(''), 45000);
    bumpUnread('call');
    return;
  }
  if (!call || o.id !== call.id) return;
  // While ringing several devices, the first to answer takes the call.
  if (call.role === 'caller' && !call.peer) {
    if (o.op === 'decline' || o.op === 'busy') {
      call.declined.add(s.peer);
      if (call.rang && [...call.rang].every((pid) => call.declined.has(pid) || !sessions.get(pid)?.secure)) {
        hangupLocal(o.op === 'busy' ? 'مخاطب در حال تماس است' : 'تماس رد شد');
      }
      return;
    }
    if (o.op !== 'accept') return;
  } else if (s.peer !== call.peer) {
    if (o.op === 'accept') await sendInner(s, { k: 'call', op: 'cancel', id: o.id });
    return;
  }
  const pc = call.pc;
  switch (o.op) {
    case 'accept':
      if (call.role !== 'caller' || call.state !== 'ringing') return;
      call.peer = s.peer;
      for (const other of secureSessions()) if (other.peer !== s.peer) await sendInner(other, { k: 'call', op: 'cancel', id: call.id });
      clearTimeout(call.timeout);
      call.state = 'connecting';
      call.fe = FE_SUPPORTED && !!o.fe;
      setCallState('در حال برقراری اتصال…');
      await setupPeer();
      await call.pc.setLocalDescription(await call.pc.createOffer());
      await sendInner(s, { k: 'call', op: 'offer', id: call.id, sdp: call.pc.localDescription.sdp });
      break;
    case 'offer':
      if (call.role !== 'callee' || !pc) return;
      await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
      addLocalTrack();
      await flushIce();
      await pc.setLocalDescription(await pc.createAnswer());
      await sendInner(s, { k: 'call', op: 'answer', id: call.id, sdp: pc.localDescription.sdp });
      break;
    case 'answer':
      if (call.role !== 'caller' || !pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: o.sdp });
      await flushIce();
      break;
    case 'ice':
      if (!o.c) return;
      if (pc && pc.remoteDescription) await pc.addIceCandidate(o.c).catch(() => {});
      else call.pending.push(o.c);
      break;
    case 'decline':
      hangupLocal('تماس رد شد');
      break;
    case 'busy':
      hangupLocal('مخاطب در حال تماس است');
      break;
    case 'hangup':
      hangupLocal('تماس پایان یافت');
      break;
    case 'cancel':
      hangupLocal(call.state === 'incoming' || call.state === 'accepting' ? 'تماس روی دستگاه دیگری پاسخ داده شد' : '');
      break;
  }
}

async function acceptCall() {
  const c = call;
  if (!c || c.role !== 'callee' || c.state !== 'incoming') return;
  c.state = 'accepting'; // a second tap on Answer does nothing
  $('accept-btn').hidden = true;
  setCallState('در حال برقراری اتصال…');
  ring(false);
  clearTimeout(c.timeout);
  cancelRecording();
  const fxCtx = voiceFxOn ? newAudioContext() : null; // made inside the tap (mobile audio rules)
  let stream;
  try { stream = await getMic(); }
  catch { fxCtx?.close().catch(() => {}); toast('دسترسی به میکروفون داده نشد'); if (call === c) hangup(''); return; }
  // The call may have ended (or another one started) while the mic was opening.
  if (call !== c) { stream.getTracks().forEach((t) => t.stop()); fxCtx?.close().catch(() => {}); return; }
  c.stream = stream;
  c.fxCtx = fxCtx;
  await setupCallFx(c);
  await refreshIce();
  if (call !== c) return;
  c.state = 'connecting';
  c.fe = FE_SUPPORTED && c.peerFe;
  await serial(async () => {
    const s = sessions.get(c.peer);
    if (call !== c) return;
    if (!s?.secure) { hangupLocal('ارتباط قطع شد'); return; }
    await setupPeer();
    await sendInner(s, { k: 'call', op: 'accept', id: c.id, fe: FE_SUPPORTED });
  });
}

async function setupPeer() {
  const c = call;
  // With a TURN relay available, route media only through it: neither side
  // learns the other's IP address.
  const config = { iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', iceTransportPolicy: hasTurn() ? 'relay' : 'all' };
  if (c.fe && !FE_SCRIPT) config.encodedInsertableStreams = true;
  const pc = new RTCPeerConnection(config);
  c.pc = pc;

  if (c.fe) {
    const c2e = await hkdf(c.secret, ZERO, `wn1/call/${c.id}/caller`);
    const e2c = await hkdf(c.secret, ZERO, `wn1/call/${c.id}/callee`);
    const [enc, dec] = c.role === 'caller' ? [c2e, e2c] : [e2c, c2e];
    c.worker = new Worker('/frame-worker.js');
    c.worker.postMessage({ op: 'keys', enc: enc.buffer, dec: dec.buffer }, [enc.buffer, dec.buffer]);
  }
  wipe(c.secret);

  pc.onicecandidate = (e) => {
    if (e.candidate && call === c && c.peer) postTo(c.peer, { k: 'call', op: 'ice', id: c.id, c: e.candidate.toJSON() }).catch(() => {});
  };
  pc.ontrack = (e) => {
    if (c.fe) attachTransform(e.receiver, 'dec');
    c.remote = e.streams[0] || new MediaStream([e.track]);
    $('remote-audio').srcObject = c.remote;
    $('remote-audio').play().catch(() => {});
    if (audioRoute.speaker) setSpeaker(true);
  };
  pc.onconnectionstatechange = () => {
    if (call !== c) return;
    if (pc.connectionState === 'connected' && c.state !== 'active') {
      c.state = 'active';
      c.started = Date.now();
      setCallState('متصل');
      $('call').classList.add('active');
      $('call-timer').hidden = false;
      $('mute-btn').hidden = false;
      $('speaker-btn').hidden = !(IS_IOS || IS_ANDROID);
      c.clock = setInterval(() => { $('call-timer').textContent = fmtDuration(Math.floor((Date.now() - c.started) / 1000)); }, 1000);
    } else if (pc.connectionState === 'failed') {
      hangup(hasTurn() ? 'اتصال صوتی برقرار نشد؛ دوباره تلاش کنید' : 'اتصال صوتی برقرار نشد (سرور رله‌ی تماس هنوز تنظیم نشده)');
    }
  };
  $('call-crypto').textContent = c.fe
    ? 'رمزنگاری دولایه · DTLS-SRTP + AES-256-GCM'
    : 'رمزنگاری سرتاسری · DTLS-SRTP';
  if (c.role === 'caller') addLocalTrack();
}

function addLocalTrack() {
  const c = call;
  const out = sendTrackOf(c); // the female-voice filter's output when it is on
  for (const track of out ? [out] : []) {
    const sender = c.pc.addTrack(track, c.fx?.stream || c.stream);
    if (!c.fe) continue;
    attachTransform(sender, 'enc');
    // Chrome ignores a receiver transform set later in ontrack on the
    // offering side (frames then reach the decoder still encrypted, which
    // sounds like crackling). Attach it now, before negotiation.
    const tr = c.pc.getTransceivers().find((t) => t.sender === sender);
    if (tr) attachTransform(tr.receiver, 'dec');
  }
}

const transformed = new WeakSet();
function attachTransform(senderOrReceiver, dir) {
  const c = call;
  if (transformed.has(senderOrReceiver)) return;
  transformed.add(senderOrReceiver);
  if (FE_SCRIPT) {
    senderOrReceiver.transform = new RTCRtpScriptTransform(c.worker, { dir });
  } else {
    const { readable, writable } = senderOrReceiver.createEncodedStreams();
    c.worker.postMessage({ op: 'stream', dir, readable, writable }, [readable, writable]);
  }
}

async function flushIce() {
  const c = call;
  while (c.pending.length) await c.pc.addIceCandidate(c.pending.shift()).catch(() => {});
}

function hangup(reason) {
  const c = call;
  if (!c) return;
  const op = c.role === 'callee' && (c.state === 'incoming' || c.state === 'accepting') ? 'decline' : 'hangup';
  if (c.peer) postTo(c.peer, { k: 'call', op, id: c.id }).catch(() => {});
  else if (anySecure()) post({ k: 'call', op, id: c.id }).catch(() => {});
  hangupLocal(reason);
}

function hangupLocal(reason) {
  const c = call;
  if (!c) return;
  call = null;
  ring(false);
  clearTimeout(c.timeout);
  clearInterval(c.clock);
  c.stream?.getTracks().forEach((t) => t.stop());
  closeCallFx(c);
  c.fxCtx?.close().catch(() => {});
  try { c.pc?.close(); } catch {}
  if (c.worker) { c.worker.postMessage({ op: 'wipe' }); c.worker.terminate(); }
  wipe(c.secret);
  $('remote-audio').srcObject = null;
  resetAudioRoute();
  applyVoiceFxUi();
  $('call').hidden = true;
  $('call').classList.remove('active');
  syncLockCall();
  if (reason) toast(reason);
}

function showCall(state, incomingCall) {
  $('call').hidden = false;
  $('call').classList.remove('active');
  $('call-state').textContent = state;
  $('call-timer').hidden = true;
  $('call-timer').textContent = '00:00';
  $('call-crypto').textContent = 'تبادل کلید تماس از کانال رمزشده';
  $('accept-btn').hidden = !incomingCall;
  $('mute-btn').hidden = true;
  $('speaker-btn').hidden = true;
  $('speaker-btn').classList.remove('off');
  $('call-fx').hidden = !call?.fx;
  setMuteIcon(false);
  syncLockCall();
}
function setCallState(text) { $('call-state').textContent = text; }
function setMuteIcon(muted) {
  const b = $('mute-btn');
  b.classList.toggle('off', muted);
  b.textContent = '';
  b.append(icon(muted ? 'mic-off' : 'mic'));
}

let ringCtx = null;
let ringTimer = null;
function ring(on) {
  clearInterval(ringTimer);
  if (ringCtx) { ringCtx.close().catch(() => {}); ringCtx = null; }
  if (!on) return;
  try {
    ringCtx = new AudioContext();
    const beep = () => {
      for (const [f, t] of [[523, 0], [659, 0.18]]) {
        const o = ringCtx.createOscillator();
        const g = ringCtx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, ringCtx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.09, ringCtx.currentTime + t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + t + 0.35);
        o.connect(g).connect(ringCtx.destination);
        o.start(ringCtx.currentTime + t);
        o.stop(ringCtx.currentTime + t + 0.4);
      }
    };
    beep();
    ringTimer = setInterval(beep, 2200);
  } catch {}
  navigator.vibrate?.([300, 150, 300]);
}

// ---------- wiring ----------
function step(name) {
  for (const id of ['choose', 'create', 'join', 'pass']) $(`${id}-step`).hidden = id !== name;
  for (const id of ['create-error', 'join-error', 'pass-error']) $(id).hidden = true;
}

function formError(id, text) {
  const e = $(id);
  e.hidden = false;
  e.textContent = text;
}

// The device name is remembered on this device and pre-filled next time.
function saveName(n) { try { localStorage.setItem('najva:name', n); } catch {} }
function savedName() { try { return (localStorage.getItem('najva:name') || '').slice(0, 30); } catch { return ''; } }

function bindEntry() {
  $('new-name').value = savedName();
  $('join-name').value = savedName();
  let createCode = '';
  let joinCode = '';
  const regen = () => { createCode = newCode(); $('new-code').textContent = fmtCode(createCode); };

  $('go-create').onclick = () => { regen(); step('create'); $('new-pass').focus(); };
  $('go-join').onclick = () => { step('join'); $('join-code').focus(); };
  $('regen-btn').onclick = regen;
  for (const b of document.querySelectorAll('[data-back]')) {
    b.onclick = () => { step(b.dataset.back || 'choose'); if (b.dataset.back === 'join') $('join-code').focus(); };
  }

  $('new-pass').addEventListener('input', () => {
    const score = passStrength($('new-pass').value);
    const bar = $('strength-bar');
    bar.style.width = `${[8, 30, 55, 80, 100][score]}%`;
    bar.style.background = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e'][score];
    $('strength-text').textContent = ['خیلی کوتاه', 'ضعیف', 'متوسط', 'خوب', 'عالی'][score];
  });

  $('create-step').onsubmit = async (e) => {
    e.preventDefault();
    const pass = $('new-pass').value;
    if (pass.length < MIN_PASS) { formError('create-error', `رمز باید دست‌کم ${fa(MIN_PASS)} کاراکتر باشد`); return; }
    myName = $('new-name').value.replace(/\s+/g, ' ').trim().slice(0, 30) || defaultName();
    saveName(myName);
    $('new-pass').value = '';
    show('busy');
    await openRoom(createCode, pass, true);
  };

  $('join-code').addEventListener('input', () => {
    const d = normDigits($('join-code').value).slice(0, 7);
    $('join-code').value = d;
    if (d.length === 7) $('join-step').requestSubmit();
  });
  $('join-step').onsubmit = (e) => {
    e.preventDefault();
    const d = normDigits($('join-code').value);
    if (d.length !== 7) { formError('join-error', 'کد اتاق باید ۷ رقم باشد'); return; }
    joinCode = d;
    $('pass-code').textContent = fmtCode(d);
    step('pass');
    $('join-pass').focus();
  };
  $('pass-step').onsubmit = async (e) => {
    e.preventDefault();
    const pass = $('join-pass').value;
    if (!pass) { formError('pass-error', 'رمز اتاق را وارد کنید'); return; }
    myName = $('join-name').value.replace(/\s+/g, ' ').trim().slice(0, 30) || defaultName();
    saveName(myName);
    $('join-pass').value = '';
    show('busy');
    await openRoom(joinCode, pass, false);
  };

  // Deep link from the SMS: /#1234567 opens straight at the password step.
  return (code) => {
    joinCode = code;
    $('join-code').value = code;
    $('pass-code').textContent = fmtCode(code);
    step('pass');
    $('join-pass').focus();
  };
}

function bindUi() {
  $('copy-code-btn').onclick = () => copy(room.code);
  $('lock').onsubmit = (e) => { e.preventDefault(); tryUnlock(); };
  $('lock-leave').onclick = async () => { if (await ask('خروج و پاک‌سازی', 'همه‌ی پیام‌ها از حافظه پاک می‌شود و از اتاق خارج می‌شوید. ادامه؟', 'خروج')) leave(); };
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-eye]');
    if (!b) return;
    const input = $(b.dataset.eye);
    input.type = input.type === 'password' ? 'text' : 'password';
    b.querySelector('use').setAttribute('href', input.type === 'password' ? '#i-eye' : '#i-eye-off');
  });

  $('composer').onsubmit = (e) => { e.preventDefault(); sendText(); };
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      sendText();
    }
  });
  $('input').addEventListener('input', () => {
    autoGrow();
    if (anySecure() && Date.now() - lastTypingSent > 3000) {
      lastTypingSent = Date.now();
      post({ k: 'typing' }).catch(() => {});
    }
  });
  $('input').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); sendFiles(files); }
  });

  $('emoji-btn').onclick = (e) => { e.stopPropagation(); const p = $('emoji-panel'); const open = p.hidden; closePanels(); p.hidden = !open; };
  $('emoji-panel').onclick = (e) => e.stopPropagation();
  $('gif-btn').onclick = (e) => {
    e.stopPropagation();
    const p = $('gif-panel');
    const open = p.hidden;
    closePanels();
    p.hidden = !open;
    if (open && !$('gif-grid').childElementCount) searchGifs(GIF_TOPICS[0][1]);
    if (open && matchMedia('(pointer: fine)').matches) $('gif-q').focus();
  };
  $('gif-panel').onclick = (e) => e.stopPropagation();
  $('gif-form').onsubmit = (e) => { e.preventDefault(); searchGifs($('gif-q').value); };
  buildGifTopics();
  bindDoubleTap();
  bindSwipeReply();
  bindVoice();
  applyVoiceFxUi();
  bindMusic();
  bindManager();
  bindVeil();
  $('messages').addEventListener('scroll', () => { if ($('messages').scrollTop < 60) loadHistory(false); updateToBottom(); }, { passive: true });
  $('to-bottom').onclick = () => {
    const list = $('messages');
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    newBelow = 0;
    updateToBottom();
  };
  initNotify();
  $('attach-btn').onclick = () => $('file-input').click();
  $('file-input').onchange = () => { const f = [...$('file-input').files]; $('file-input').value = ''; sendFiles(f); };

  const chat = $('chat');
  let dragDepth = 0;
  chat.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('drop-zone').hidden = false; } });
  chat.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-zone').hidden = true; } });
  chat.addEventListener('dragover', (e) => e.preventDefault());
  chat.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop-zone').hidden = true;
    sendFiles([...(e.dataTransfer?.files || [])]);
  });

  $('ttl-btn').onclick = (e) => { e.stopPropagation(); const m = $('ttl-menu'); const open = m.hidden; closePanels(); m.hidden = !open; };
  $('ttl-menu').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.ttl === undefined) return;
    setTtl(clampTtl(Number(b.dataset.ttl)));
    if (anySecure()) post({ k: 'ttl', v: ttl }).catch(() => {});
    notice(ttl ? `پیام‌های بعدی ${ttlLabel(ttl)} پس از خوانده شدن حذف می‌شوند` : 'پیام‌های بعدی خودکار حذف نمی‌شوند');
  };

  $('call-btn').onclick = startCall;
  $('accept-btn').onclick = acceptCall;
  $('hangup-btn').onclick = () => hangup('');
  $('mute-btn').onclick = () => {
    if (!call?.stream) return;
    const track = call.stream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    setMuteIcon(!track.enabled);
  };
  $('speaker-btn').onclick = () => setSpeaker(!audioRoute.speaker);

  $('menu-btn').onclick = (e) => { e.stopPropagation(); const m = $('menu'); const open = m.hidden; closePanels(); m.hidden = !open; };
  document.addEventListener('click', closePanels);
  window.addEventListener('pointerdown', onGlobalPointerDown, true);
  window.addEventListener('pointerup', onGlobalPointerUp, true);
  window.addEventListener('pointercancel', onGlobalPointerUp, true);
  $('ig-modal').onclick = (e) => { if (e.target === $('ig-modal')) closeIgModal(); };
  $('igm-close').onclick = closeIgModal;
  $('igm-prev').onclick = () => igStep(-1);
  $('igm-next').onclick = () => igStep(1);
  let swipeX = null;
  $('igm-media').addEventListener('pointerdown', (e) => { swipeX = e.clientX; });
  $('igm-media').addEventListener('pointerup', (e) => {
    if (swipeX === null) return;
    const dx = e.clientX - swipeX;
    swipeX = null;
    if (Math.abs(dx) > 50) igStep(dx > 0 ? 1 : -1); // RTL: swipe right = next
  });
  $('igm-form').onsubmit = (e) => {
    e.preventDefault();
    if (!igModal) return;
    const entry = igModal.list[igModal.index];
    const text = $('igm-text').value.trim();
    if (!entry || !text) return;
    if (!setReaction(entry, entry.react.me, text)) return;
    $('igm-text').value = '';
    renderIgModal();
    toast('پاسخ شما فرستاده شد');
    // In a stack, move on to the next post.
    if (igModal.index < igModal.list.length - 1) setTimeout(() => { if (igModal) { igModal.index++; renderIgModal(); } }, 500);
  };
  window.addEventListener('keydown', (e) => {
    if (!igModal || e.target.closest?.('input, textarea')) return;
    if (e.key === 'Escape') closeIgModal();
    if (e.key === 'ArrowLeft') igStep(1);
    if (e.key === 'ArrowRight') igStep(-1);
  });
  $('menu').onclick = (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'safety') showSafety();
    if (act === 'copy') copy(room.code);
    if (act === 'lock') lockNow();
    if (act === 'preview') {
      e.stopPropagation();
      previewsOn = !previewsOn;
      $('preview-switch').classList.toggle('on', previewsOn);
      toast(previewsOn ? 'پیش‌نمایش لینک اینستاگرام روشن شد' : 'پیش‌نمایش خاموش شد؛ لینک‌ها هرگز به سرور فرستاده نمی‌شوند');
    }
    if (act === 'clear') {
      ask('پاک کردن گفتگو برای همه', 'با این کار تمام پیام‌ها و فایل‌های این گفتگو از سرور و از همه‌ی دستگاه‌ها پاک می‌شود! مطمئنید؟\nموارد «ماندگار» در کتابخانه‌ی هر دستگاه باقی می‌مانند.', 'بله، پاک کن').then(async (ok) => {
        if (!ok) return;
        const r = await storeFetch('/h/clear', { method: 'POST', body: '{}' }).catch(() => null);
        if (!r?.ok) { toast('پاک کردن روی سرور انجام نشد'); return; }
        clearMessages();
        histMore = false;
        updateOlderButton();
        if (anySecure()) post({ k: 'clear' }).catch(() => {});
        toast('گفتگو برای همه پاک شد');
      });
    }
    if (act === 'leave') {
      ask('خروج از اتاق', 'از اتاق خارج می‌شوید. پیام‌ها رمزشده روی سرور می‌مانند و دفعه‌ی بعد با همین کد و رمز برمی‌گردند.', 'خروج', false).then((ok) => ok && leave());
    }
    if (act === 'manage') openManager();
    if (act === 'notify') { e.stopPropagation(); toggleNotify(); }
    if (act === 'voicefx') {
      e.stopPropagation();
      // A recording keeps the voice it started with: drop it rather than mix.
      if (rec) { cancelRecording(); toast('ضبط لغو شد؛ با تنظیم جدید دوباره ضبط کنید'); }
      voiceFxOn = !voiceFxOn;
      try { localStorage.setItem('najva:voicefx', voiceFxOn ? '1' : '0'); } catch {}
      if (call && voiceFxOn) call.fxCtx ??= newAudioContext(); // inside the tap (mobile audio rules)
      applyVoiceFxUi();
      applyCallFx();
      toast(voiceFxOn ? 'صدای ناشناس روشن شد: تماس با صدای رباتیک بدون جنسیت؛ پیام صوتی به متن تبدیل و با صدای خانم هوش مصنوعی خوانده می‌شود. صدای شما فرستاده نمی‌شود' : 'صدای ناشناس خاموش شد');
    }
    if (act === 'veil') {
      e.stopPropagation();
      veilOn = !veilOn;
      try { localStorage.setItem('najva:veil', veilOn ? '1' : '0'); } catch {}
      applyVeil();
      toast(veilOn ? 'متن محرمانه روشن شد: برای خواندن، روی پیام نگه دارید' : 'متن محرمانه خاموش شد');
    }
  };

  // Privacy: hide content when the window loses focus, flag screenshot keys.
  setTimeout(checkUpdate, 5000);
  setInterval(checkUpdate, 30 * 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkUpdate();
    if (document.hidden) lockNow();
    evaluateShield();
    if (!document.hidden && !locked) { unread = 0; updateTitle(); }
  });
  window.addEventListener('pagehide', lockNow);
  window.addEventListener('blur', evaluateShield);
  window.addEventListener('focus', () => { evaluateShield(); if (!locked) { unread = 0; updateTitle(); } });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'PrintScreen' || (e.metaKey && e.shiftKey) || (e.key === 'Meta' && e.shiftKey) || (e.key === 'Shift' && e.metaKey)) screenshotAttempt();
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'PrintScreen') screenshotAttempt(); });
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('#viewer, .media-wrap, .ig-card')) e.preventDefault(); });
  document.addEventListener('dragstart', (e) => { if (e.target.closest?.('#chat, #viewer')) e.preventDefault(); });

  window.addEventListener('beforeunload', (e) => {
    if (!leaving && (messages.size || call)) e.preventDefault();
  });
  setInterval(tickTimers, 1000);
  buildEmojiPanel();
  setTtl(ttl);
  autoGrow();
}

async function main() {
  if (!window.isSecureContext || !crypto.subtle || !window.WebSocket) {
    document.body.textContent = 'این مرورگر از رمزنگاری لازم پشتیبانی نمی‌کند. لطفاً از نسخه‌ی جدید Chrome، Firefox یا Safari استفاده کنید.';
    return;
  }
  bindUi();
  const openAtPassword = bindEntry();
  // A link pasted into an already-open tab only changes the fragment; start over.
  window.addEventListener('hashchange', () => { if (location.hash.length > 1) location.reload(); });
  const code = normDigits(decodeURIComponent(location.hash.slice(1)));
  if (location.hash) history.replaceState(null, '', '/');
  show('home');
  if (code.length === 7) openAtPassword(code);
  else step('choose');
}

main();
