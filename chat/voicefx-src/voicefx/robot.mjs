// robot.mjs - "anonymous voice": an LPC vocoder with a fixed, neutral pitch.
//
// Every 10 ms the shape of the speaker's vocal tract is measured with linear
// prediction (that is what makes words intelligible: the formants), then the
// sound is re-made from a synthetic source: a steady buzz at one neutral
// pitch (default 155 Hz) for voiced sounds, noise for s / sh / f. The real
// voice source - pitch, intonation, breathiness, roughness, the cues that
// carry gender and identity - is never passed on. Works internally at 16 kHz
// (speech bandwidth), ~20 ms latency, no allocations in process(), so it is
// safe in an AudioWorklet for live calls.
// API: constructor(sampleRate, opts), process(input, output),
// setParams({ f0, mix, order }), latencySamples.

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const R = 16000;     // internal rate
const N = 400;       // analysis window (25 ms)
const H = 160;       // hop (10 ms)
const P = 16;        // LPC order
const BLK = 32;      // coefficient update step in samples (2 ms)
const K = 128;       // envelope bins for formant normalisation (0..8 kHz)

// 4th-order Butterworth low-pass as two biquads (normalised coefficients).
function lowpass4(c, fc, sr) {
  const qs = [0.5411961, 1.3065630];
  for (let s = 0; s < 2; s++) {
    const w = 2 * Math.PI * fc / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * qs[s]), a0 = 1 + al, o = s * 5;
    c[o] = (1 - cw) / 2 / a0; c[o + 1] = (1 - cw) / a0; c[o + 2] = (1 - cw) / 2 / a0;
    c[o + 3] = -2 * cw / a0; c[o + 4] = (1 - al) / a0;
  }
}
function biquads(c, st, x) {
  for (let s = 0; s < 2; s++) {
    const o = s * 5, q = s * 4;
    const y = c[o] * x + c[o + 1] * st[q] + c[o + 2] * st[q + 1] - c[o + 3] * st[q + 2] - c[o + 4] * st[q + 3];
    st[q + 1] = st[q]; st[q] = x; st[q + 3] = st[q + 2]; st[q + 2] = y;
    x = y;
  }
  return x;
}

export class VoiceFx {
  constructor(sampleRate, opts = {}) {
    const sr = num(sampleRate) && sampleRate >= 8000 && sampleRate <= 384000 ? sampleRate : 48000;
    this.sr = sr;
    this.f0 = 155;
    this.mix = 1;
    this.step = R / sr;                       // internal samples per input sample
    // resampling filters
    this.dnC = new Float64Array(10); this.dnS = new Float64Array(8);
    this.upC = new Float64Array(10); this.upS = new Float64Array(8);
    lowpass4(this.dnC, Math.min(7200, sr * 0.45), sr);
    lowpass4(this.upC, Math.min(7200, sr * 0.45), sr);
    this.dnPos = 0; this.dnPrev = 0;          // input -> 16 kHz (fractional)
    // 16 kHz input ring for analysis
    this.ring = new Float64Array(1024); this.wr = 0; this.got = 0; this.sinceHop = 0;
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N);
    this.lagW = new Float64Array(P + 1);       // lag window (60 Hz Gaussian) for well-conditioned LPC
    for (let i = 0; i <= P; i++) this.lagW[i] = Math.exp(-0.5 * Math.pow(2 * Math.PI * 60 * i / R, 2));
    this.frame = new Float64Array(N);
    this.ac = new Float64Array(P + 1);
    this.tmp = new Float64Array(P + 1);
    this.kPrev = new Float64Array(P); this.kCur = new Float64Array(P); this.kNow = new Float64Array(P);
    this.a = new Float64Array(P + 1);           // direct-form A(z) = 1 + sum a[j] z^-j
    this.aT = new Float64Array(P + 1);
    this.gPrev = 0; this.gCur = 0;
    this.uPrev = 1; this.uCur = 1;              // unvoiced degree
    // 16 kHz synthesis queue (one hop at a time)
    this.out16 = new Float64Array(1024); this.oRd = 0; this.oWr = 0; this.oCount = 0;
    this.hist = new Float64Array(P);            // synthesis filter memory
    this.phase = 0; this.seed = 1234567;
    this.deY = 0;                               // de-emphasis state
    this.upPos = 0; this.upA = 0; this.upB = 0; // 16 kHz -> output (linear)
    // level matching
    this.inP = 1e-7; this.outP = 1e-7; this.g = 1;
    this.lvA = 1 - Math.exp(-1 / (0.2 * sr)); this.gA = 1 - Math.exp(-1 / (0.08 * sr));
    this.latencySamples = Math.round((N / 2 + H) / R * sr);
    // formant normalisation: every speaker's vocal-tract scale is mapped onto
    // one neutral target, so formant spacing no longer gives away the voice
    this.cosT = new Float64Array(K * (P + 1)); this.sinT = new Float64Array(K * (P + 1));
    for (let k = 0; k < K; k++) for (let m = 0; m <= P; m++) {
      const w = Math.PI * k / K * m;
      this.cosT[k * (P + 1) + m] = Math.cos(w); this.sinT[k * (P + 1) + m] = Math.sin(w);
    }
    this.S = new Float64Array(K); this.Sw = new Float64Array(K); this.rw = new Float64Array(P + 1);
    this.lagW2 = new Float64Array(P + 1);       // extra smoothing of the normalised envelope
    for (let i = 0; i <= P; i++) this.lagW2[i] = Math.exp(-0.5 * Math.pow(2 * Math.PI * 40 * i / R, 2));
    this.target = 1450;                          // neutral envelope centroid (Hz), between male and female
    this.cAvg = this.target; this.alpha = 1.18; this.warpOn = true;
    this.formant = 1.18;                         // fixed formant shift (adaptive centroid tracking proved unreliable)
    this.adaptive = false;
    // robotic texture: partial ring modulation
    this.ringF = 42; this.ringD = 0.15; this.ringPh = 0;
    // prime the queue so output can start
    for (let i = 0; i < H; i++) this.push16(0);
    this.setParams(opts);
  }

  setParams(p) {
    if (!p || typeof p !== 'object') return;
    if (num(p.f0) && p.f0 >= 60 && p.f0 <= 400) this.f0 = p.f0;
    if (num(p.mix)) this.mix = Math.max(0, Math.min(1, p.mix));
    if (num(p.target) && p.target > 600 && p.target < 3000) this.target = p.target;
    if (typeof p.normalize === 'boolean') this.warpOn = p.normalize;
    if (num(p.formant) && p.formant >= 0.8 && p.formant <= 1.4) this.formant = p.formant;
    if (typeof p.adaptive === 'boolean') this.adaptive = p.adaptive;
    if (num(p.ring) && p.ring >= 0 && p.ring <= 1) this.ringD = p.ring;
    if (num(p.smooth) && p.smooth >= 0 && p.smooth <= 300) for (let i = 0; i <= P; i++) this.lagW2[i] = Math.exp(-0.5 * Math.pow(2 * Math.PI * p.smooth * i / R, 2));
  }

  noise() {
    // approximately Gaussian: sum of two uniforms
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    const a = this.seed / 4294967296;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return (a + this.seed / 4294967296 - 1) * 2.449;
  }

  push16(v) {
    this.out16[this.oWr] = v; this.oWr = (this.oWr + 1) & 1023; this.oCount++;
  }

  pop16() {
    if (this.oCount <= 0) return 0;
    const v = this.out16[this.oRd]; this.oRd = (this.oRd + 1) & 1023; this.oCount--;
    return v;
  }

  // LPC of the latest window -> reflection coefficients, gain, voicing.
  analyse() {
    const fr = this.frame, ring = this.ring;
    let e0 = 0;
    for (let i = 0; i < N; i++) {
      const x = ring[(this.wr - N + i + 1024) & 1023];
      fr[i] = x;
      e0 += x * x;
    }
    // voicing: periodicity of the (raw) frame in the 60-400 Hz range + zero crossings
    let r0 = 1e-12, best = 0, zc = 0;
    for (let i = 0; i < N; i++) r0 += fr[i] * fr[i];
    for (let i = 1; i < N; i++) if ((fr[i] >= 0) !== (fr[i - 1] >= 0)) zc++;
    for (let lag = 40; lag <= 266; lag += 2) {
      let s = 0, e1 = 1e-12, e2 = 1e-12;
      for (let i = lag; i < N; i += 2) { s += fr[i] * fr[i - lag]; e1 += fr[i] * fr[i]; e2 += fr[i - lag] * fr[i - lag]; }
      const r = s / Math.sqrt(e1 * e2);
      if (r > best) best = r;
    }
    const zcr = zc / N;
    let u = best > 0.7 ? 0 : best < 0.3 ? 1 : (0.7 - best) / 0.4;
    if (zcr > 0.28) u = Math.max(u, Math.min(1, (zcr - 0.28) / 0.12));
    // windowed, pre-emphasised autocorrelation
    let prev = 0;
    for (let i = 0; i < N; i++) { const x = fr[i]; fr[i] = (x - 0.9 * prev) * this.win[i]; prev = x; }
    const ac = this.ac;
    for (let k = 0; k <= P; k++) {
      let s = 0;
      for (let i = k; i < N; i++) s += fr[i] * fr[i - k];
      ac[k] = s * this.lagW[k];
    }
    ac[0] = ac[0] * 1.0001 + 1e-9;               // white-noise correction
    const err = this.levinson(ac);
    if (this.warpOn) this.normalise(u < 0.5 && e0 > 1e-6);
    // gain: residual energy per sample of the (unwindowed) frame
    const wpow = 0.375;                           // mean of hann^2
    const g = Math.sqrt(Math.max(0, err) / (N * wpow));
    this.gPrev = this.gCur; this.uPrev = this.uCur;
    this.gCur = num(g) ? g : 0;
    this.uCur = e0 < 1e-7 ? 1 : u;
  }

  // Levinson-Durbin: autocorrelation -> reflection coefficients (kCur) and
  // direct-form A(z) in aT; returns the prediction error.
  levinson(ac) {
    const a = this.aT, t = this.tmp, k = this.kCur;
    a.fill(0); a[0] = 1;
    let err = ac[0];
    for (let i = 1; i <= P; i++) {
      let acc = ac[i];
      for (let j = 1; j < i; j++) acc += a[j] * ac[i - j];
      let ki = -acc / err;
      if (!num(ki)) ki = 0;
      ki = Math.max(-0.995, Math.min(0.995, ki));
      k[i - 1] = ki;
      for (let j = 1; j < i; j++) t[j] = a[j] + ki * a[i - j];
      for (let j = 1; j < i; j++) a[j] = t[j];
      a[i] = ki;
      err *= 1 - ki * ki;
    }
    return err;
  }

  // Move the envelope's formants by alpha so its centroid lands on the
  // neutral target (alpha follows the speaker slowly), smooth it, refit LPC.
  normalise(voiced) {
    const a = this.aT, S = this.S, Sw = this.Sw, cosT = this.cosT, sinT = this.sinT;
    let num0 = 0, den0 = 0;
    for (let k = 0; k < K; k++) {
      let re = 0, im = 0;
      const o = k * (P + 1);
      for (let m = 0; m <= P; m++) { re += a[m] * cosT[o + m]; im -= a[m] * sinT[o + m]; }
      const v = 1 / Math.max(1e-9, re * re + im * im);
      S[k] = v;
      const f = k * 8000 / K;
      if (f >= 300 && f <= 3500) { num0 += f * v; den0 += v; }
    }
    if (voiced && den0 > 0) {
      const c = num0 / den0;
      if (num(c)) this.cAvg += 0.02 * (c - this.cAvg);
    }
    const want = this.adaptive ? Math.max(0.8, Math.min(1.35, this.target / this.cAvg)) : this.formant;
    this.alpha += 0.1 * (want - this.alpha);
    const al = this.alpha;
    for (let k = 0; k < K; k++) {
      const pos = k / al, i0 = Math.floor(pos), f = pos - i0;
      Sw[k] = i0 + 1 < K ? S[i0] * (1 - f) + S[i0 + 1] * f : S[K - 1] * 0.5;
    }
    const r = this.rw;
    for (let m = 0; m <= P; m++) {
      let acc = 0.5 * Sw[0];
      for (let k = 1; k < K; k++) acc += Sw[k] * cosT[k * (P + 1) + m];
      r[m] = acc * this.lagW2[m];
    }
    r[0] = r[0] * 1.001 + 1e-12;
    this.levinson(r);
  }

  // k (reflection) -> direct form a (step-up recursion)
  kToA(kk) {
    const a = this.a, t = this.tmp;
    a.fill(0); a[0] = 1;
    for (let i = 1; i <= P; i++) {
      const ki = kk[i - 1];
      for (let j = 1; j < i; j++) t[j] = a[j] + ki * a[i - j];
      for (let j = 1; j < i; j++) a[j] = t[j];
      a[i] = ki;
    }
  }

  // Synthesize one hop at 16 kHz, interpolating from the previous frame.
  synthHop() {
    const T = R / this.f0;
    const kStart = this.kNow, kEnd = this.kCur, kInt = this.kPrev;
    for (let n = 0; n < H; n += BLK) {
      const f = (n + BLK / 2) / H;
      // reflection coefficients interpolate safely (the filter stays stable)
      for (let i = 0; i < P; i++) kInt[i] = kStart[i] + (kEnd[i] - kStart[i]) * f;
      this.kToA(kInt);
      const g = this.gPrev + (this.gCur - this.gPrev) * f;
      const u = this.uPrev + (this.uCur - this.uPrev) * f;
      const wv = Math.sqrt(1 - u), wn = Math.sqrt(u) * 0.9 + 0.08;
      for (let m = 0; m < BLK; m++) {
        // excitation: unit-power pulse train at the neutral pitch + noise
        this.phase += 1;
        let pulse = 0;
        if (this.phase >= T) { this.phase -= T; pulse = Math.sqrt(T); }
        const e = (wv * pulse + wn * this.noise()) * g;
        // all-pole synthesis 1/A(z)
        let y = e;
        const h = this.hist, a = this.a;
        for (let j = 1; j <= P; j++) y -= a[j] * h[j - 1];
        for (let j = P - 1; j > 0; j--) h[j] = h[j - 1];
        h[0] = num(y) ? y : 0;
        // de-emphasis (undo the 0.9 pre-emphasis), then a metallic robotic warble
        this.deY = h[0] + 0.9 * this.deY;
        this.ringPh += this.ringF / R;
        if (this.ringPh >= 1) this.ringPh -= 1;
        this.push16(this.deY * (1 - this.ringD + this.ringD * Math.sin(2 * Math.PI * this.ringPh)));
      }
    }
    this.kNow.set(kEnd);
  }

  process(input, output) {
    const len = output.length;
    for (let i = 0; i < len; i++) {
      let x = i < input.length ? input[i] : 0;
      if (!num(x)) x = 0;
      this.inP += this.lvA * (x * x - this.inP);
      // input -> 16 kHz
      const xl = biquads(this.dnC, this.dnS, x);
      this.dnPos += this.step;
      while (this.dnPos >= 1) {
        this.dnPos -= 1;
        const frac = 1 - this.dnPos / this.step;
        const v = this.dnPrev + (xl - this.dnPrev) * Math.max(0, Math.min(1, frac));
        this.ring[this.wr] = v; this.wr = (this.wr + 1) & 1023; this.got++;
        if (++this.sinceHop >= H) {
          this.sinceHop = 0;
          if (this.got >= N) { this.analyse(); this.synthHop(); }
          else for (let m = 0; m < H; m++) this.push16(0);
        }
      }
      this.dnPrev = xl;
      // 16 kHz -> output rate
      this.upPos += this.step;
      while (this.upPos >= 1) { this.upPos -= 1; this.upA = this.upB; this.upB = this.pop16(); }
      let y = biquads(this.upC, this.upS, this.upA + (this.upB - this.upA) * this.upPos);
      // match the input level, then a gentle limiter
      this.outP += this.lvA * (y * y - this.outP);
      const want = this.outP > 1e-12 ? Math.sqrt(this.inP / this.outP) : this.g;
      this.g += this.gA * (Math.max(0.05, Math.min(20, want)) - this.g);
      let o = y * this.g * this.mix + x * (1 - this.mix);
      o = o > 1 ? 1 : o < -1 ? -1 : o;
      output[i] = num(o) ? o : 0;
    }
    if (!num(this.g)) this.g = 1;
    for (let j = 0; j < P; j++) if (!num(this.hist[j])) this.hist.fill(0);
    if (!num(this.deY)) this.deY = 0;
  }
}

export default VoiceFx;
