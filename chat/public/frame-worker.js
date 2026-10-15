// Second encryption layer for call audio: every encoded Opus frame is sealed
// with AES-256-GCM using per-direction keys that only the two browsers hold.
// This sits on top of WebRTC's own DTLS-SRTP, so a TURN relay or a forged
// SDP still yields nothing but noise.

let encKey = null;
let decKey = null;
let ivPrefix = 0;
let counter = 0n;

self.onmessage = async (e) => {
  const d = e.data;
  if (d.op === 'keys') {
    encKey = await crypto.subtle.importKey('raw', d.enc, 'AES-GCM', false, ['encrypt']);
    decKey = await crypto.subtle.importKey('raw', d.dec, 'AES-GCM', false, ['decrypt']);
    ivPrefix = crypto.getRandomValues(new Uint32Array(1))[0];
    counter = 0n;
    new Uint8Array(d.enc).fill(0);
    new Uint8Array(d.dec).fill(0);
  } else if (d.op === 'stream') {
    pipe(d.readable, d.writable, d.dir);
  } else if (d.op === 'wipe') {
    encKey = decKey = null;
  }
};

// RTCRtpScriptTransform path (Firefox, Safari, recent Chrome).
self.onrtctransform = (e) => {
  const t = e.transformer;
  pipe(t.readable, t.writable, t.options.dir);
};

function pipe(readable, writable, dir) {
  readable
    .pipeThrough(new TransformStream({ transform: dir === 'enc' ? encryptFrame : decryptFrame }))
    .pipeTo(writable)
    .catch(() => {});
}

async function encryptFrame(frame, controller) {
  if (!encKey) return; // never let plaintext audio out
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  view.setUint32(0, ivPrefix);
  view.setBigUint64(4, counter++);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, frame.data));
  const out = new Uint8Array(ct.length + 12);
  out.set(ct, 0);
  out.set(iv, ct.length);
  frame.data = out.buffer;
  controller.enqueue(frame);
}

async function decryptFrame(frame, controller) {
  if (!decKey) return;
  const buf = new Uint8Array(frame.data);
  if (buf.length < 29) return;
  const iv = buf.slice(buf.length - 12);
  try {
    frame.data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decKey, buf.subarray(0, buf.length - 12));
    controller.enqueue(frame);
  } catch {
    // Forged or corrupted frame: drop it.
  }
}
