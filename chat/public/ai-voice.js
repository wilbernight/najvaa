// On-device "AI voice" for voice messages. Nothing leaves the device:
//  - speech -> text: Vosk (Kaldi, Persian small model) in a web worker;
//  - text -> speech: the VITS voice "karim" (ONNX Runtime WASM) in
//    ai-tts-worker.js.
// Model files are fetched once from our own origin and then cached.

const BASE = '/ai/v1/';

let worker = null;
let seq = 0;
const jobs = new Map();
function tts(msg, onProgress) {
  if (!worker) {
    worker = new Worker('/ai-tts-worker.js?v=1', { type: 'module' });
    worker.onmessage = ({ data }) => {
      const j = jobs.get(data.id);
      if (!j) return;
      if (data.progress !== undefined) { j.onProgress?.(data.progress); return; }
      jobs.delete(data.id);
      if (data.error) j.reject(new Error(data.error)); else j.resolve(data);
    };
    worker.onerror = (e) => {
      for (const j of jobs.values()) j.reject(new Error(e.message || 'worker'));
      jobs.clear();
      worker = null;
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, ...msg });
  });
}

// text -> { pcm: Float32Array, rate }
export async function speak(text, onProgress) {
  const r = await tts({ op: 'speak', text }, onProgress);
  return { pcm: r.pcm, rate: r.rate };
}

export const loadVoice = (onProgress) => tts({ op: 'load' }, onProgress);

let vosk = null;
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('script'));
    document.head.append(s);
  });
}
export function loadAsr(onProgress) {
  vosk ??= (async () => {
    if (!window.Vosk) await loadScript(BASE + 'vosk.js');
    const url = location.origin + BASE + 'vosk-fa.tar.gz';
    // Download it here first, for the progress bar; Vosk's own worker then
    // finds it in the browser's HTTP cache (served as long-lived, immutable).
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error(`asr: ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0;
    const reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (total) onProgress?.(got / total);
    }
    return window.Vosk.createModel(url);
  })().catch((e) => { vosk = null; throw e; });
  return vosk;
}

// 16 kHz mono PCM -> text
export async function transcribe(pcm) {
  const model = await loadAsr();
  const rec = new model.KaldiRecognizer(16000);
  const parts = [];
  return new Promise((resolve) => {
    let done = false, quiet = 0;
    const finish = () => { if (done) return; done = true; clearTimeout(quiet); try { rec.remove(); } catch {} resolve(parts.join(' ').trim()); };
    // Results arrive in order; the last one follows retrieveFinalResult().
    rec.on('result', (m) => {
      const t = m?.result?.text;
      if (t) parts.push(t);
      clearTimeout(quiet);
      quiet = setTimeout(finish, 700);
    });
    for (let i = 0; i < pcm.length; i += 16000) rec.acceptWaveformFloat(pcm.subarray(i, Math.min(pcm.length, i + 16000)), 16000);
    rec.retrieveFinalResult();
    setTimeout(finish, 10000 + pcm.length / 16);
  });
}
