// psola/dsp.mjs - "female voice" effect, Algorithm A (time domain).
//
// Formant shift by resampling + TD-PSOLA pitch correction, streaming, mono, any block size.
//   1. Input -> 50 Hz high-pass (DC/rumble) -> ring buffer.
//   2. Analysis on a low-passed, decimated (~8 kHz) copy:
//        - YIN every 4 ms: period estimate, aperiodicity, voicing, running F0 histogram (auto mode).
//        - Epoch (pitch-mark) chain: anchored on the dominant waveform extremum at voicing onset, then
//          continued period by period with normalised cross-correlation (+ a small pull toward the
//          same-polarity extremum), sub-sample refined. A chain ends when periodicity is lost.
//   3. Synthesis (pitch-synchronous OLA in input time; output time = input time + latency):
//        - voiced: synthesis marks every T/P (P = total pitch ratio). Each grain is the 2-period
//          Hann-windowed neighbourhood of the nearest analysis epoch, read at rate alpha (formant ratio),
//          i.e. "resample by alpha, then PSOLA by P/alpha" done in one step.
//        - unvoiced: fixed-hop OLA (4x overlap), same resampling, jittered read positions, read from a
//          high-shelf-compensated copy so incoherent (noise) energy is preserved.
//        - per-sample normalisation by the summed window, so every transition is click-free.
//   4. Dry/wet mix, level compensation, soft limiter.
// Zero dependencies, no allocation in process(), no DOM/Node APIs: runs in AudioWorkletGlobalScope.

const PI = Math.PI;
const TWO_PI = 2 * Math.PI;

function nextPow2(n) { let s = 1; while (s < n) s *= 2; return s; }

// RBJ cookbook biquads, coefficients written to c[o..o+4] = b0 b1 b2 a1 a2 (a0 normalised)
function designLP(c, o, fc, fs, q) {
  const w = TWO_PI * fc / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  c[o] = (1 - cw) / 2 / a0; c[o + 1] = (1 - cw) / a0; c[o + 2] = (1 - cw) / 2 / a0;
  c[o + 3] = -2 * cw / a0; c[o + 4] = (1 - al) / a0;
}
function designHP(c, o, fc, fs, q) {
  const w = TWO_PI * fc / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  c[o] = (1 + cw) / 2 / a0; c[o + 1] = -(1 + cw) / a0; c[o + 2] = (1 + cw) / 2 / a0;
  c[o + 3] = -2 * cw / a0; c[o + 4] = (1 - al) / a0;
}
function designHighShelf(c, o, fc, fs, gainDb) {
  const A = Math.pow(10, gainDb / 40), w = TWO_PI * fc / fs, cw = Math.cos(w), sw = Math.sin(w);
  const al = sw / 2 * Math.SQRT2, sa = 2 * Math.sqrt(A) * al; // shelf slope S = 1
  const a0 = (A + 1) - (A - 1) * cw + sa;
  c[o] = A * ((A + 1) + (A - 1) * cw + sa) / a0;
  c[o + 1] = -2 * A * ((A - 1) + (A + 1) * cw) / a0;
  c[o + 2] = A * ((A + 1) + (A - 1) * cw - sa) / a0;
  c[o + 3] = 2 * ((A - 1) - (A + 1) * cw) / a0;
  c[o + 4] = ((A + 1) - (A - 1) * cw - sa) / a0;
}
// phase (radians) of a biquad cascade at frequency f
function cascadePhase(c, nSec, f, fs) {
  const w = TWO_PI * f / fs;
  let ph = 0;
  for (let s = 0; s < nSec; s++) {
    const o = s * 5;
    const nr = c[o] + c[o + 1] * Math.cos(w) + c[o + 2] * Math.cos(2 * w);
    const ni = -c[o + 1] * Math.sin(w) - c[o + 2] * Math.sin(2 * w);
    const dr = 1 + c[o + 3] * Math.cos(w) + c[o + 4] * Math.cos(2 * w);
    const di = -c[o + 3] * Math.sin(w) - c[o + 4] * Math.sin(2 * w);
    ph += Math.atan2(ni, nr) - Math.atan2(di, dr);
  }
  return ph;
}

const HANN_N = 2048;
const MARKS = 1024; // mark ring capacity (power of two)

export class VoiceFx {
  constructor(sampleRate, opts = {}) {
    const sr = (typeof sampleRate === 'number' && sampleRate >= 8000 && sampleRate <= 768000) ? sampleRate : 48000;
    this.sr = sr;
    const o = opts || {};

    // ---------------------------------------------------------------- tunables
    this.targetF0 = 200;          // auto mode lands the running median F0 here
    this.autoTauFast = 0.35; this.autoTau = 1.0; // auto ratio smoothing (s of voicing): first 2 s, then
    this.autoMin = 1.3; this.autoMax = 2.0;
    this.fMinChain = 66;          // lowest F0 handled pitch-synchronously (below: creak -> unvoiced path)
    this.fMaxChain = 420;
    this.rLo = 0.80; this.rHi = 1.22; // next-epoch search range (x period)
    this.segBack = 0.7;           // correlation segment: [c - 0.7 T, c + 0.3 T]
    this.lambdaPeak = 0.12;       // pull toward same-polarity extremum
    this.thrCont = 0.45;          // NCC needed to continue a chain
    this.yinThr = 0.15; this.yinVoiced = 0.25;
    this.gainV = 0.93; this.gainU = 1.0;
    this.kappa = 0.7;             // voiced grain half-span = kappa * period (input samples)
    this.latencyMs = 26;
    this.yinWms = 8;              // YIN integration window
    this.LguardMs = 0;            // look-back for new chains (0 = derived from the lowest F0)
    this.guardMs = 0;             // extra look-back allowed for a new chain (adds onset coverage, costs latency)
    this.margUms = 3;             // unvoiced synthesis keeps this far behind the earliest possible new epoch
    this.RuMs = 4; this.jitMs = 1.2;
    this.shelfDb = 4.26; this.shelfHz = 150; this.lpHz = 2000;
    this.backExt = 1;             // extend new chains backward toward the onset
    this.interpW = 1;             // >0: crossfade between the two neighbouring analysis grains (width as a fraction of the period)
    if (o.tune && typeof o.tune === 'object') for (const k of Object.keys(o.tune)) if (typeof o.tune[k] === 'number') this[k] = o.tune[k];

    // ---------------------------------------------------------------- derived sizes
    const dec = Math.max(1, Math.round(sr / 8000));
    this.dec = dec; this.fsD = sr / dec;
    this.Tmin = sr / this.fMaxChain;
    this.Tmax = sr / this.fMinChain;
    this.Rcap = Math.round(0.0125 * sr);       // max grain half-span in input samples
    this.Ru = Math.round(this.RuMs * 0.001 * sr); // unvoiced grain half-length (output samples)
    this.Hu = this.Ru / 2;                     // unvoiced hop -> 4x overlap
    this.jitMax = this.jitMs * 0.001 * sr;     // unvoiced read-position jitter (decorrelates grains)
    // look-back for new chains: marks of a new chain may be placed down to (newest data - Lguard)
    this.Lguard = this.LguardMs > 0 ? Math.round(this.LguardMs * 0.001 * sr) : Math.ceil(this.Tmax) + 2 * dec + 8 + Math.round(this.guardMs * 0.001 * sr);
    this.margU = this.margUms * 0.001 * sr;
    const D = Math.round(this.latencyMs * 0.001 * sr);
    this.D = D;
    this.latencySamples = D;

    // ---------------------------------------------------------------- filters
    this.hpC = new Float64Array(5); designHP(this.hpC, 0, 50, sr, Math.SQRT1_2);
    this.hpS = new Float64Array(2);
    this.lpC = new Float64Array(10);
    const fcLP = Math.min(this.lpHz, 0.42 * this.fsD);
    designLP(this.lpC, 0, fcLP, sr, 0.5411961); designLP(this.lpC, 5, fcLP, sr, 1.3065630);
    this.lpS = new Float64Array(4);
    // group delay of the low-pass at low frequency (full-rate samples)
    const f1 = 100, f2 = 300;
    this.gd = -(cascadePhase(this.lpC, 2, f2, sr) - cascadePhase(this.lpC, 2, f1, sr)) / (TWO_PI * (f2 - f1) / sr);
    this.shC = new Float64Array(5); this.shS = new Float64Array(2);
    designHighShelf(this.shC, 0, this.shelfHz, sr, this.shelfDb);

    // ---------------------------------------------------------------- buffers
    const inSize = nextPow2(D + 4 * Math.ceil(this.Tmax) + 4 * this.Ru + 2048);
    this.inBuf = new Float32Array(inSize); this.shBuf = new Float32Array(inSize); this.inMask = inSize - 1;
    this.nIn = 0;
    const yinW = Math.round(this.yinWms * 0.001 * this.fsD);
    const tauMax = Math.ceil(this.fsD / this.fMinChain) + 1;
    this.yW = yinW; this.yTauMax = tauMax; this.yTauMin = Math.max(2, Math.floor(this.fsD / 450));
    this.yHop = Math.max(1, Math.round(0.004 * this.fsD));
    const dSize = nextPow2(yinW + tauMax + 4 * Math.ceil(this.Tmax / dec) + 256);
    this.dBuf = new Float32Array(dSize); this.dMask = dSize - 1; this.nd = 0; this.decCnt = 0;
    this.yFrame = new Float64Array(yinW + tauMax + 2);
    this.yD = new Float64Array(tauMax + 2); this.yCm = new Float64Array(tauMax + 2);
    this.yHopCnt = 0;
    this.olaSize = nextPow2(D + 4 * this.Rcap + 4 * this.Ru + 4096);
    this.olaNum = new Float64Array(this.olaSize); this.olaDen = new Float64Array(this.olaSize); this.olaMask = this.olaSize - 1;
    this.hann = new Float32Array(HANN_N + 2);
    for (let i = 0; i <= HANN_N + 1; i++) this.hann[i] = i >= HANN_N ? 0 : 0.5 + 0.5 * Math.cos(PI * i / HANN_N);
    // NCC scratch
    this.nccBuf = new Float64Array(Math.ceil(this.Tmax / dec * 0.6) + 16);
    this.backPos = new Float64Array(64);
    this.srNcc = 0; // NCC of the last searchMark()
    this.srPos = 0.5; this.smM = 0.5; this.smT = 0.5; this.smDir = 1; // searchMark() in/out (double fields)
    // marks
    this.mPos = new Float64Array(MARKS); this.mPer = new Float64Array(MARKS); this.mChain = new Int32Array(MARKS); this.mNcc = new Float32Array(MARKS);
    this.mCount = 0; this.mPtr = -1; this.chainId = 0;
    this.chainActive = false; this.lastMark = 0; this.Tp = 0; this.pol = 1;
    this.U = -1e9; // no new epoch can appear before U (full-rate input position)
    // F0 histogram (quarter semitones from 50 Hz)
    this.hBins = 4 * 12 * 4; this.hist = new Float64Array(this.hBins); this.hTotal = 0;
    const prior = Math.round(4 * 12 * Math.log2(110 / 50));
    this.hist[prior] = 40; this.hTotal = 40; // prior: ~0.16 s of voicing at 110 Hz
    this.hDecay = Math.exp(-(this.yHop / this.fsD) / 6); // ~6 s memory of voiced frames
    this.medF0 = 110; this.vSec = 0;
    // YIN state
    this.yPer = 0; this.yAper = 1; this.yVoiced = false; this.yMs = 0;
    this.lvl = 0; this.lvlDecay = Math.pow(10, -(12 * this.yHop / this.fsD) / 10); // 12 dB/s
    // synthesis state
    this.sNext = 0; this.jit = 0; this.seed = 22222;
    // params
    this.pitch = 1.75; this.auto = false; this.formant = 1.17; this.mix = 1;
    this.pEff = 1.75; this.aEff = 1.17; this.mixEff = 1;
    this.pAutoLog = Math.log(this.clampAuto(this.targetF0 / this.medF0));
    this.mixK = 1 - Math.exp(-1 / (0.02 * sr));
    // debug counters (preallocated)
    this.stats = { grainsV: 0, grainsU: 0, chains: 0, marks: 0, lateSamples: 0, lateW: 0, totalW: 0, lowDen: 0, zeroDen: 0, forced: 0, forcedU: 0, forcedC: 0 };
    this.setParams(o);
    this.pEff = this.auto ? Math.exp(this.pAutoLog) : this.pitch;
    this.aEff = this.formant;
    this.mixEff = this.mix;
  }

  clampAuto(r) { return r < this.autoMin ? this.autoMin : r > this.autoMax ? this.autoMax : r; }

  setParams(p) {
    if (!p || typeof p !== 'object') return;
    if (p.auto === true) this.auto = true;
    else if (p.auto === false) this.auto = false;
    if (p.pitch === null && p.auto !== false) this.auto = true;
    else if (typeof p.pitch === 'number' && Number.isFinite(p.pitch) && p.pitch > 0) {
      this.pitch = Math.min(2.5, Math.max(0.5, p.pitch));
      if (p.auto !== true) this.auto = false;
    }
    if (typeof p.formant === 'number' && Number.isFinite(p.formant) && p.formant > 0) this.formant = Math.min(1.5, Math.max(0.75, p.formant));
    if (typeof p.mix === 'number' && Number.isFinite(p.mix)) this.mix = Math.min(1, Math.max(0, p.mix));
    if (typeof p.targetF0 === 'number' && Number.isFinite(p.targetF0) && p.targetF0 > 50) this.targetF0 = Math.min(400, p.targetF0);
  }

  // decimated <-> full-rate positions (decimated sample j was taken at full-rate j*dec+dec-1, LP delay gd)
  toDec(p) { return (p + this.gd - (this.dec - 1)) / this.dec; }
  toFull(j) { return j * this.dec + this.dec - 1 - this.gd; }

  // ------------------------------------------------------------------ analysis: YIN
  runYin() {
    const W = this.yW, tMax = this.yTauMax, F = W + tMax, nd = this.nd;
    if (nd < F) return;
    const fr = this.yFrame, db = this.dBuf, dm = this.dMask;
    let ms = 0;
    for (let j = 0; j < F; j++) { const v = db[(nd - F + j) & dm]; fr[j] = v; ms += v * v; }
    ms /= F;
    this.yMs = ms;
    this.lvl = Math.max(ms, this.lvl * this.lvlDecay);
    const gate = Math.max(this.lvl * 1e-4, 1e-7);
    const d = this.yD, cm = this.yCm;
    let voiced = false, per = 0, aper = 1;
    if (ms > gate) {
      for (let tau = 1; tau <= tMax; tau++) {
        let acc = 0;
        for (let j = 0; j < W; j++) { const v = fr[j] - fr[j + tau]; acc += v * v; }
        d[tau] = acc;
      }
      let run = 0;
      cm[0] = 1;
      for (let tau = 1; tau <= tMax; tau++) { run += d[tau]; cm[tau] = run > 1e-30 ? d[tau] * tau / run : 1; }
      let t = -1;
      for (let k = this.yTauMin; k < tMax; k++) {
        if (cm[k] < this.yinThr) { while (k + 1 < tMax && cm[k + 1] < cm[k]) k++; t = k; break; }
      }
      if (t < 0) { let b = Infinity; for (let k = this.yTauMin; k < tMax; k++) if (cm[k] < b) { b = cm[k]; t = k; } }
      const a = cm[t - 1], b = cm[t], c = cm[t + 1], den = a - 2 * b + c;
      let dl = den > 0 ? 0.5 * (a - c) / den : 0;
      if (!(dl >= -1 && dl <= 1)) dl = 0;
      per = (t + dl) * this.dec; aper = b;
      voiced = aper < this.yinVoiced && per >= this.Tmin && per <= this.Tmax;
      if (voiced && aper < 0.2 && ms > gate * 10) {
        // running F0 histogram for auto mode
        const f0 = this.sr / per;
        let bin = Math.round(48 * Math.log2(f0 / 50));
        if (bin < 0) bin = 0; else if (bin >= this.hBins) bin = this.hBins - 1;
        const h = this.hist, k = this.hDecay;
        for (let i = 0; i < this.hBins; i++) h[i] *= k;
        h[bin] += 1;
        this.hTotal = this.hTotal * k + 1;
        let acc = 0, half = 0.5 * this.hTotal, mb = 0;
        for (let i = 0; i < this.hBins; i++) { acc += h[i]; if (acc >= half) { mb = i; break; } }
        this.medF0 = 50 * Math.pow(2, mb / 48);
        const tgt = Math.log(this.clampAuto(this.targetF0 / this.medF0));
        // adapt quickly while the speaker is new (first ~2 s of voicing), then slowly
        const dt = this.yHop / this.fsD;
        this.vSec += dt;
        const tf = this.autoTauFast, ts = this.autoTau; // both loaded unconditionally (keeps JIT feedback complete)
        const tau = this.vSec < 2 ? tf : ts;
        this.pAutoLog += (tgt - this.pAutoLog) * (1 - Math.exp(-dt / tau));
      }
    }
    this.yPer = per; this.yAper = aper; this.yVoiced = voiced;
    if (voiced && !this.chainActive) this.startChain(per);
  }

  // ------------------------------------------------------------------ analysis: epoch chain
  pushMark(pos, per) {
    const i = this.mCount & (MARKS - 1);
    this.mPos[i] = pos; this.mPer[i] = per; this.mChain[i] = this.chainId; this.mNcc[i] = this.srNcc;
    this.mCount++;
    this.stats.marks++;
  }

  // Find the epoch one period after (dir=+1) or before (dir=-1) the epoch at full-rate position m,
  // given the local period Tp (m, Tp, dir are read from this.smM, this.smT, this.smDir so that no
  // doubles are boxed across the call). Returns 1 and sets this.srPos when found, -1 if not periodic
  // enough, 0 if (forward) the data needed is not there yet. Sets this.srNcc.
  searchMark() {
    const m = this.smM, Tp = this.smT, dir = this.smDir;
    const dec = this.dec, db = this.dBuf, dm = this.dMask;
    const mD = (m + this.gd - (dec - 1)) / dec, TpD = Tp / dec;
    const L = Math.max(4, Math.round(TpD));
    const aL = Math.round(this.segBack * L);
    let cLo, cHi;
    if (dir > 0) { cLo = Math.floor(mD + this.rLo * TpD); cHi = Math.ceil(mD + this.rHi * TpD); }
    else { cLo = Math.floor(mD - this.rHi * TpD); cHi = Math.ceil(mD - this.rLo * TpD); }
    if (cHi + 1 - aL + L > this.nd - 1) return 0; // not enough data yet
    if (cLo - 1 - aL < this.nd - this.dBuf.length + 4) return -1; // fell out of the buffer
    const r0 = Math.round(mD) - aL;
    let er = 0, amp = 0;
    for (let j = 0; j < L; j++) { const v = db[(r0 + j) & dm]; er += v * v; const av = v < 0 ? -v : v; if (av > amp) amp = av; }
    const gate = Math.max(this.lvl * 1e-4, 1e-7);
    this.srNcc = 0;
    if (!(er / L > gate * 0.25)) return -1;
    const nc = this.nccBuf, pol = this.pol, lam = this.lambdaPeak / (amp + 1e-12);
    const nC = cHi - cLo + 3;
    let bestS = -Infinity, bi = 1, ecBest = 0, rawBest = 0;
    for (let q = 0; q < nC; q++) {
      const c = cLo - 1 + q, s0 = c - aL;
      let xy = 0, ec = 0;
      for (let j = 0; j < L; j++) { const v = db[(s0 + j) & dm]; xy += v * db[(r0 + j) & dm]; ec += v * v; }
      const ncc = xy / Math.sqrt(er * ec + 1e-30);
      const sc = ncc + lam * pol * db[c & dm];
      nc[q] = sc;
      if (q >= 1 && q <= nC - 2 && sc > bestS) { bestS = sc; bi = q; ecBest = ec; rawBest = ncc; }
    }
    const a = nc[bi - 1], b = nc[bi], c = nc[bi + 1], den = a - 2 * b + c;
    let dl = den < 0 ? 0.5 * (a - c) / den : 0;
    if (!(dl >= -1 && dl <= 1)) dl = 0;
    const newD = cLo - 1 + bi + dl + (mD - Math.round(mD));
    const per = (newD - mD) * dec * dir;
    this.srNcc = rawBest;
    if (!(rawBest >= this.thrCont) || !(ecBest / L > gate * 0.25) || per < this.Tmin || per > this.Tmax) return -1;
    this.srPos = m + dir * per;
    return 1;
  }

  startChain(T0) {
    const dec = this.dec, db = this.dBuf, dm = this.dMask;
    const jU = Math.ceil(this.toDec(this.U));
    let jHi = this.nd - 2, jLo;
    if (this.backExt) jLo = Math.max(jU, Math.floor(jHi - T0 / dec)); // most recent full period
    else { jLo = jU; jHi = Math.min(jHi, Math.floor(this.toDec(this.U + T0))); }
    if (jHi - jLo < 0.6 * T0 / dec || jLo < 1) return;
    let best = -1, bj = jLo;
    for (let j = jLo; j <= jHi; j++) { const v = Math.abs(db[j & dm]); if (v > best) { best = v; bj = j; } }
    const pol = db[bj & dm] >= 0 ? 1 : -1;
    const a = pol * db[(bj - 1) & dm], b = pol * db[bj & dm], c = pol * db[(bj + 1) & dm], den = a - 2 * b + c;
    let dl = den < 0 ? 0.5 * (a - c) / den : 0;
    if (!(dl >= -1 && dl <= 1)) dl = 0;
    const pos = this.toFull(bj + dl);
    if (pos < this.U) return;
    this.pol = pol;
    // backward extension toward the voicing onset (never before U)
    let nb = 0, m = pos, Tp = T0;
    if (this.backExt) {
      while (nb < this.backPos.length) {
        this.smM = m; this.smT = Tp; this.smDir = -1;
        if (this.searchMark() !== 1) break;
        const r = this.srPos;
        if (!(r >= this.U)) break;
        Tp = m - r; m = r; this.backPos[nb++] = r;
      }
    }
    this.chainId++;
    this.stats.chains++;
    for (let q = nb - 1; q >= 0; q--) {
      const pq = this.backPos[q];
      const per = q === nb - 1 ? (q > 0 ? this.backPos[q - 1] : pos) - pq : pq - this.backPos[q + 1];
      this.pushMark(pq, per);
    }
    const perA = nb > 0 ? pos - this.backPos[0] : T0;
    this.pushMark(pos, perA);
    this.chainActive = true;
    this.lastMark = pos; this.Tp = perA;
    this.U = pos + this.rLo * perA;
    while (this.chainActive && this.extendChain()) { /* extend as far as data allows */ }
  }

  // returns true if a new mark was appended
  extendChain() {
    this.smM = this.lastMark; this.smT = this.Tp; this.smDir = 1;
    const st = this.searchMark();
    if (st === 0) return false;
    if (st < 0) { this.endChain(); return false; }
    const r = this.srPos;
    const per = r - this.lastMark;
    this.pushMark(r, per);
    this.lastMark = r; this.Tp = per;
    this.U = r + this.rLo * per;
    return true;
  }

  endChain() {
    this.chainActive = false;
    this.U = Math.max(this.U, this.lastMark + 0.5 * this.Tp);
  }

  onDecimated() {
    if (this.chainActive) { while (this.chainActive && this.extendChain()) { /* */ } }
    if (!this.chainActive) {
      const u = this.toFull(this.nd - 1) - this.Lguard;
      if (u > this.U) this.U = u;
    }
    if (++this.yHopCnt >= this.yHop) { this.yHopCnt = 0; this.runYin(); }
  }

  // ------------------------------------------------------------------ synthesis
  nextJitter() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this.jit = (this.seed / 4294967296 * 2 - 1) * this.jitMax;
  }

  addGrain(src, center, alpha, Rout, sOut, gain) {
    // next position to be emitted; positions < 0 are never emitted (nor cleared), so never write there
    const fo = this.nIn - 1 - this.D, firstOut = fo > 0 ? fo : 0;
    let pLo = Math.ceil(sOut - Rout); const pHi = Math.floor(sOut + Rout);
    const num = this.olaNum, den = this.olaDen, om = this.olaMask, im = this.inMask, hann = this.hann;
    const sc = HANN_N / Rout;
    if (pLo < firstOut) {
      this.stats.lateSamples += firstOut - pLo;
      for (let p = pLo; p < firstOut && p <= pHi; p++) { const x = Math.abs(p - sOut) * sc, xi = x | 0; if (xi < HANN_N) this.stats.lateW += hann[xi]; }
      pLo = firstOut;
    }
    this.stats.totalW += Rout;
    for (let p = pLo; p <= pHi; p++) {
      const u = p - sOut;
      const x = (u < 0 ? -u : u) * sc;
      const xi = x | 0;
      if (xi >= HANN_N) continue;
      const w = hann[xi] + (x - xi) * (hann[xi + 1] - hann[xi]);
      const pos = center + alpha * u;
      const i = Math.floor(pos), f = pos - i;
      const xm1 = src[(i - 1) & im], x0 = src[i & im], x1 = src[(i + 1) & im], x2 = src[(i + 2) & im];
      const v = x0 + 0.5 * f * (x1 - xm1 + f * (2 * xm1 - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm1)));
      const oi = p & om;
      num[oi] += gain * w * v; den[oi] += w;
    }
  }

  // voiced grain built from two neighbouring analysis grains (weights wA + wB = 1), same window
  addGrainPair(cA, wA, cB, wB, alpha, Rout, sOut, gain) {
    const fo = this.nIn - 1 - this.D, firstOut = fo > 0 ? fo : 0;
    let pLo = Math.ceil(sOut - Rout); const pHi = Math.floor(sOut + Rout);
    const num = this.olaNum, den = this.olaDen, om = this.olaMask, im = this.inMask, hann = this.hann, src = this.inBuf;
    const sc = HANN_N / Rout;
    if (pLo < firstOut) {
      this.stats.lateSamples += firstOut - pLo;
      for (let p = pLo; p < firstOut && p <= pHi; p++) { const x = Math.abs(p - sOut) * sc, xi = x | 0; if (xi < HANN_N) this.stats.lateW += hann[xi]; }
      pLo = firstOut;
    }
    this.stats.totalW += Rout;
    for (let p = pLo; p <= pHi; p++) {
      const u = p - sOut;
      const x = (u < 0 ? -u : u) * sc;
      const xi = x | 0;
      if (xi >= HANN_N) continue;
      const w = hann[xi] + (x - xi) * (hann[xi + 1] - hann[xi]);
      let pos = cA + alpha * u;
      let i = Math.floor(pos), f = pos - i;
      let xm1 = src[(i - 1) & im], x0 = src[i & im], x1 = src[(i + 1) & im], x2 = src[(i + 2) & im];
      const vA = x0 + 0.5 * f * (x1 - xm1 + f * (2 * xm1 - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm1)));
      pos = cB + alpha * u;
      i = Math.floor(pos); f = pos - i;
      xm1 = src[(i - 1) & im]; x0 = src[i & im]; x1 = src[(i + 1) & im]; x2 = src[(i + 2) & im];
      const vB = x0 + 0.5 * f * (x1 - xm1 + f * (2 * xm1 - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm1)));
      const oi = p & om;
      num[oi] += gain * w * (wA * vA + wB * vB); den[oi] += w;
    }
  }

  synth() {
    const MM = MARKS - 1;
    for (let guard = 0; guard < 64; guard++) {
      const s = this.sNext;
      let k = this.mPtr;
      while (k + 1 < this.mCount && this.mPos[(k + 1) & MM] <= s) k++;
      this.mPtr = k;
      const hasA = k >= 0 && k > this.mCount - MARKS;
      const hasB = k + 1 < this.mCount;
      const A = hasA ? this.mPos[k & MM] : -Infinity;
      const B = hasB ? this.mPos[(k + 1) & MM] : Infinity;
      const sameAB = hasA && hasB && this.mChain[k & MM] === this.mChain[(k + 1) & MM];
      const P = this.pEff, al = this.aEff;
      // a grain starting at or before 'due' must be added now (deadline: the output position about to be emitted)
      const due = this.nIn + 1 - this.D;
      const avail = this.nIn - 4; // last input position usable by the interpolator
      let e = -2; // -2 = wait, -1 = unvoiced, >=0 = mark index
      if (sameAB) {
        e = (s - A <= B - s) ? k : k + 1;
      } else {
        const dA = s - A;
        const perA = hasA ? this.mPer[k & MM] : 0;
        const covA = hasA && dA <= 0.5 * perA;
        if (hasB) {
          const dB = B - s;
          const covB = dB <= 0.5 * this.mPer[(k + 1) & MM];
          if (covA && covB) e = dA <= dB ? k : k + 1;
          else if (covA) e = k; else if (covB) e = k + 1; else e = -1;
        } else {
          const dF = this.U - s;
          let rv = Math.min(this.kappa * perA, this.Rcap) / al; if (rv < perA / P) rv = perA / P;
          const urgV = hasA && s - rv <= due;
          const urgU = s - this.Ru <= due;
          if (covA) { e = (dA <= dF || urgV) ? k : -2; if (e >= 0 && dA > dF) this.stats.forcedC++; }
          else if (this.chainActive) { e = urgV && dA <= perA ? k : urgU ? -1 : -2; if (e !== -2) this.stats.forcedC++; } // next epoch of the active chain should cover s
          else { e = (dF >= this.margU || urgU) ? -1 : -2; if (e === -1 && dF < this.margU) this.stats.forcedU++; }
        }
      }
      if (e === -2) return;
      const pT = this.auto ? Math.exp(this.pAutoLog) : this.pitch;
      let hop;
      if (e >= 0) {
        // pair mode: crossfade the two neighbouring analysis grains (removes the grain-repetition pattern)
        let f = -1;
        if (this.interpW > 0 && sameAB && s >= A && s <= B) {
          f = ((s - A) / (B - A) - 0.5) / this.interpW + 0.5;
          if (f <= 0.001) { f = -1; e = k; } else if (f >= 0.999) { f = -1; e = k + 1; }
        }
        let per;
        if (f > 0) per = B - A;
        else {
          const ei = e & MM;
          per = this.mPer[ei];
          if (e + 1 < this.mCount && this.mChain[(e + 1) & MM] === this.mChain[ei]) per = 0.5 * (per + this.mPer[(e + 1) & MM]);
        }
        const h = per / P;
        let Rout = Math.min(this.kappa * per, this.Rcap) / al; if (Rout < h) Rout = h;
        const g = this.gainV * Math.sqrt(Rout / h);
        const urgent = s - Rout <= due;
        if (f > 0) {
          if (B + al * Rout > avail) {
            if (!urgent || A + al * Rout > avail) return;
            this.stats.forced++;
            this.addGrain(this.inBuf, A, al, Rout, s, g); // deadline: the later grain's input is not there yet
          } else this.addGrainPair(A, 1 - f, B, f, al, Rout, s, g);
        } else {
          let ep = this.mPos[e & MM];
          if (ep + al * Rout > avail) {
            if (!(urgent && e === k + 1 && hasA && A + al * Rout <= avail)) return;
            this.stats.forced++;
            ep = A;
          }
          this.addGrain(this.inBuf, ep, al, Rout, s, g);
        }
        this.stats.grainsV++;
        hop = h;
      } else {
        const c = s + this.jit;
        if (c + al * this.Ru > avail) return;
        this.addGrain(this.shBuf, c, al, this.Ru, s, this.gainU);
        this.stats.grainsU++;
        this.nextJitter();
        hop = this.Hu;
      }
      this.sNext = s + hop;
      // smooth parameters per grain
      const kk = 1 - Math.exp(-hop / (0.04 * this.sr));
      this.pEff += (pT - this.pEff) * kk; this.aEff += (this.formant - this.aEff) * kk;
    }
  }

  // ------------------------------------------------------------------ main entry
  process(input, output) {
    const n = Math.min(input ? input.length : 0, output ? output.length : 0);
    const hc = this.hpC, hs = this.hpS, lc = this.lpC, ls = this.lpS, sc = this.shC, ss = this.shS;
    const im = this.inMask, om = this.olaMask, D = this.D;
    for (let i = 0; i < n; i++) {
      let x = input[i];
      if (!(x >= -8 && x <= 8)) x = x > 8 ? 8 : x < -8 ? -8 : 0; // NaN -> 0
      // 50 Hz high-pass (TDF-II), tiny offset keeps states out of denormals
      const yh = hc[0] * x + hs[0];
      hs[0] = hc[1] * x - hc[3] * yh + hs[1];
      hs[1] = hc[2] * x - hc[4] * yh;
      const xh = yh;
      const wi = this.nIn & im;
      this.inBuf[wi] = xh;
      // high shelf for the unvoiced path
      const ysh = sc[0] * xh + ss[0];
      ss[0] = sc[1] * xh - sc[3] * ysh + ss[1];
      ss[1] = sc[2] * xh - sc[4] * ysh;
      this.shBuf[wi] = ysh;
      // anti-alias low-pass for the analysis copy
      const y1 = lc[0] * xh + ls[0];
      ls[0] = lc[1] * xh - lc[3] * y1 + ls[1];
      ls[1] = lc[2] * xh - lc[4] * y1;
      const y2 = lc[5] * y1 + ls[2];
      ls[2] = lc[6] * y1 - lc[8] * y2 + ls[3];
      ls[3] = lc[7] * y1 - lc[9] * y2;
      this.nIn++;
      if (++this.decCnt >= this.dec) {
        this.decCnt = 0;
        this.dBuf[this.nd & this.dMask] = y2;
        this.nd++;
        this.onDecimated();
      }
      this.synth();
      // output
      const p = this.nIn - 1 - D;
      let wet = 0, dry = 0;
      if (p >= 0) {
        const oi = p & om;
        const dn = this.olaDen[oi];
        if (dn < 0.3) { this.stats.lowDen++; if (dn < 0.05) this.stats.zeroDen++; }
        wet = this.olaNum[oi] / (dn > 0.5 ? dn : 0.5);
        this.olaNum[oi] = 0; this.olaDen[oi] = 0;
        dry = this.inBuf[p & im];
      }
      this.mixEff += (this.mix - this.mixEff) * this.mixK;
      let y = this.mixEff * wet + (1 - this.mixEff) * dry;
      // soft limiter
      const ay = y < 0 ? -y : y;
      if (ay > 0.85) { const l = 0.85 + 0.15 * Math.tanh((ay - 0.85) / 0.15); y = y < 0 ? -l : l; }
      if (!(y === y)) y = 0;
      output[i] = y;
    }
    // flush filter denormals
    if (Math.abs(hs[0]) < 1e-25) hs[0] = 0; if (Math.abs(hs[1]) < 1e-25) hs[1] = 0;
    for (let j = 0; j < 4; j++) if (Math.abs(ls[j]) < 1e-25) ls[j] = 0;
    if (Math.abs(ss[0]) < 1e-25) ss[0] = 0; if (Math.abs(ss[1]) < 1e-25) ss[1] = 0;
    return true;
  }
}

export default VoiceFx;
