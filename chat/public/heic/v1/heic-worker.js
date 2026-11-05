// Decodes HEIC/HEIF photos on the device (libheif, LGPL-3.0: see
// LICENSE-libheif.txt) for browsers that cannot open them themselves, and
// re-encodes them as JPEG. Rotation/mirroring stored in the file is applied;
// EXIF (location, device) is not carried over.
importScripts('./libheif.js');

const MAX_PIXELS = 64e6; // larger than any phone camera; guards memory
let lib = null;
function load() {
  // The runtime can finish starting before libheif() returns, so the module is
  // handed over only once both have happened.
  lib ??= new Promise((resolve, reject) => {
    let started = false;
    let m = null;
    m = libheif({ onRuntimeInitialized: () => { started = true; if (m) resolve(m); }, onAbort: reject });
    if (started) resolve(m);
  });
  return lib;
}

async function decode(buf, quality) {
  const m = await load();
  const dec = new m.HeifDecoder();
  let images = [];
  try {
    images = dec.decode(new Uint8Array(buf));
    const img = images[0];
    if (!img) throw new Error('no image');
    const width = img.get_width();
    const height = img.get_height();
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('size');
    const data = await new Promise((resolve, reject) => {
      img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) => (d ? resolve(d.data) : reject(new Error('decode'))));
    });
    if (typeof OffscreenCanvas === 'function') {
      const c = new OffscreenCanvas(width, height);
      c.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
      return { blob: await c.convertToBlob({ type: 'image/jpeg', quality }) };
    }
    return { pixels: data, width, height };
  } finally {
    for (const i of images) i.free?.();
    dec.free?.();
  }
}

self.onmessage = async (e) => {
  const { id, buf, quality } = e.data || {};
  try {
    const r = await decode(buf, quality ?? 0.9);
    self.postMessage({ id, ...r }, r.pixels ? [r.pixels.buffer] : []);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
