// Text -> speech worker for the AI voice (keeps the page responsive while the
// VITS model runs). Phonemes come from a dictionary built offline with
// espeak-ng (every word the speech recogniser can output, stress removed,
// hand-checked colloquial overrides); unknown typed words fall back to simple
// letter rules.

import * as ort from '/ai/v1/ort.wasm.min.mjs';

const BASE = '/ai/v1/';
const CACHE = 'najva-ai-v1';
ort.env.wasm.wasmPaths = BASE;
// Threads need SharedArrayBuffer, i.e. a cross-origin isolated page (COOP/COEP).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

async function fetchCached(name, onProgress) {
  const url = BASE + name;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  const hit = cache && await cache.match(url);
  if (hit) return hit.arrayBuffer();
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress?.(got / total);
  }
  const buf = await new Blob(parts).arrayBuffer();
  try { await cache?.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })); } catch {}
  return buf;
}

async function gunzipText(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}

let ready = null;
const listeners = new Set();
const progress = (p) => { for (const f of listeners) f(p); };
function load() {
  ready ??= (async () => {
    const sizes = { 'karim.onnx': 114.3, 'phones-fa.tsv.gz': 2.5 };
    const done = {};
    const report = (name) => (p) => {
      done[name] = p;
      const all = Object.values(sizes).reduce((a, b) => a + b, 0);
      progress(Object.entries(sizes).reduce((a, [k, v]) => a + (done[k] || 0) * v, 0) / all);
    };
    const [model, dict, tok, lex] = await Promise.all([
      fetchCached('karim.onnx', report('karim.onnx')),
      fetchCached('phones-fa.tsv.gz', report('phones-fa.tsv.gz')),
      fetch(BASE + 'tokens.json').then((r) => r.json()),
      fetch(BASE + 'lexicon.json').then((r) => r.json()),
    ]);
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    const words = new Map();
    for (const line of (await gunzipText(dict)).split('\n')) {
      const t = line.indexOf('\t');
      if (t > 0) words.set(line.slice(0, t), line.slice(t + 1));
    }
    for (const [k, v] of Object.entries(lex)) words.set(k, v);
    const idx = new Map(tok.chars.map((c, i) => [c, i]));
    return { session, words, idx, blank: idx.get('<BLNK>') ?? tok.chars.length - 1, sr: tok.sr };
  })();
  return ready;
}

// Letter rules for words missing from the dictionary (rare: names, typos).
const C = { 'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's', 'ج': 'dʒ', 'چ': 'tʃ', 'ح': 'h', 'خ': 'x', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'ژ': 'ʒ', 'س': 's', 'ش': 'ʃ', 'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z', 'ع': 'ʔ', 'غ': 'ɢ', 'ف': 'f', 'ق': 'ɢ', 'ک': 'k', 'ك': 'k', 'گ': 'ɡ', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ء': 'ʔ', 'ئ': 'ʔ', 'ؤ': 'ʔ' };
function letters(w) {
  let out = '';
  const ch = [...w];
  const vowel = () => /[ɑaeiou]$/.test(out);
  ch.forEach((c, i) => {
    const last = i === ch.length - 1;
    if (c === 'آ') out += 'ɑ';
    else if (c === 'ا' || c === 'أ' || c === 'إ') out += i === 0 ? 'a' : 'ɑ';
    else if (c === 'و') out += i === 0 || vowel() ? 'v' : 'u';
    else if (c === 'ی' || c === 'ي') out += i === 0 || vowel() ? 'j' : 'i';
    else if (c === 'ه' || c === 'ة') out += last && i > 0 ? 'e' : 'h';
    else if (C[c]) {
      if (out && !vowel() && !out.endsWith(' ')) out += 'a';   // break consonant clusters
      out += C[c];
    }
  });
  return out;
}

const DIGITS = ['صفر', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
const PUNCT = { '،': ',', '؛': ';', '؟': '?', '!': '!', '.': '.', ',': ',', '?': '?' };

function phonemes(t, text) {
  text = text.normalize('NFC')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/\d/g, (d) => ` ${DIGITS[d]} `)
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[ً-ْ]/g, '');   // harakat
  const out = [];
  for (const tok of text.match(/[؀-ۿ‌]+|[،؛؟!.,?]/g) || []) {
    if (PUNCT[tok]) { if (out.length) out[out.length - 1] += PUNCT[tok]; continue; }
    const w = tok.replace(/^‌+|‌+$/g, '');
    if (!w) continue;
    let p = t.words.get(w) ?? t.words.get(w.replace(/‌/g, ''));
    if (p === undefined && w.includes('‌')) {
      const parts = w.split('‌').map((x) => t.words.get(x) ?? letters(x));
      p = parts.join('');
    }
    out.push(p ?? letters(w));
  }
  return out.join(' ').normalize('NFC');
}

async function speak(text) {
  const t = await load();
  const ph = phonemes(t, text);
  const ids = [t.blank];
  for (const c of ph) { const i = t.idx.get(c); if (i !== undefined) ids.push(i, t.blank); }
  if (ids.length < 3) throw new Error('empty');
  const out = await t.session.run({
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([0.667, 1.0, 0.8]), [3]),
  });
  const y = out[Object.keys(out)[0]].data;
  let peak = 1e-4;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  const pcm = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) pcm[i] = (y[i] / peak) * 0.9;
  return { pcm, rate: t.sr, ph };
}

self.onmessage = async ({ data: { id, op, text } }) => {
  const f = (p) => self.postMessage({ id, progress: p });
  listeners.add(f);
  try {
    if (op === 'load') { await load(); self.postMessage({ id, ok: true }); return; }
    const r = await speak(text);
    self.postMessage({ id, ok: true, ...r }, [r.pcm.buffer]);
  } catch (e) {
    if (ready && await ready.then(() => false, () => true)) ready = null; // a failed download may be retried
    self.postMessage({ id, error: String(e?.message || e) });
  } finally {
    listeners.delete(f);
  }
};
