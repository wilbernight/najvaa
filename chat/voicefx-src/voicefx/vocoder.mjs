// vocoder/dsp.mjs - "female voice" effect, Algorithm B: streaming STFT phase vocoder with
// spectral-envelope separation and harmonic (shape-invariant) phase locking.
//
// Per analysis frame (Hann ~42.7 ms, hop 1/4, 2x zero-padded FFT, zero-phase about the window centre):
//   1. F0 + voicing from the window-normalised autocorrelation (computed from the 0-4 kHz power spectrum),
//      with octave/continuity checks against the previous frame and the speaker's running median F0.
//   2. Spectral envelope: peak-hugging max filter over one harmonic spacing, cepstral smoothing (liftering)
//      of the log spectrum -> smooth log envelope E(f).
//   3. Harmonic path (voiced part): every harmonic region h (bins between neighbouring harmonic peaks) is
//      moved by an integer bin shift so harmonic h lands at h*F0*ratio, rotated by h*Psi (Psi = accumulated
//      phase advance of the shifted fundamental, so all harmonics keep the input's relative phases = shape
//      invariant, no phasiness) and weighted by E(f_out/formant)/E(f_in) (pitch moves, the envelope is only
//      warped by the formant ratio).
//      Noise path (unvoiced part): bins keep frequency and phase, weighted by E(f/formant)/E(f) only, so s/f/sh
//      keep their noise structure and only move spectrally.
//      The two paths are joined at a crossover frequency: Nyquist for clearly voiced frames, lower for weakly
//      voiced frames and for frames that contain a click/plosive burst (the burst then stays where it is
//      instead of being smeared by the harmonic phase rotation), 0 for unvoiced frames.
//   4. Frame energy matched to the input frame, inverse FFT, short Hann synthesis window, weighted
//      overlap-add with exact normalisation.
// Latency = M/2 + Ls/2 - 1 samples (M analysis window, Ls synthesis window) ~ 32 ms at 48 kHz.
// No allocation after construction; all state lives in typed arrays / numeric fields.

const TWO_PI = 2 * Math.PI;

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function num(v) { return typeof v === 'number' && Number.isFinite(v); }

// ---------------------------------------------------------------- FFTs
class ComplexFFT {
  // n: power of two >= 4. Bit reversal, one radix-4 pass, then radix-2 passes with per-stage twiddle tables.
  constructor(n) {
    this.n = n;
    let bits = 0; while ((1 << bits) < n) bits++;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.tc = new Float64Array(n); this.ts = new Float64Array(n);
    this.off = new Int32Array(bits + 1);
    let o = 0;
    for (let size = 8, st = 3; size <= n; size <<= 1, st++) {
      this.off[st] = o;
      const h = size >> 1;
      for (let k = 0; k < h; k++) { this.tc[o + k] = Math.cos(TWO_PI * k / size); this.ts[o + k] = -Math.sin(TWO_PI * k / size); }
      o += h;
    }
  }
  // in-place forward transform, X[k] = sum x[n] e^{-j 2 pi k n / N}
  forward(re, im) {
    const n = this.n, rev = this.rev, tc = this.tc, ts = this.ts;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let i = 0; i < n; i += 4) {
      const a0r = re[i], a0i = im[i], a1r = re[i + 1], a1i = im[i + 1], a2r = re[i + 2], a2i = im[i + 2], a3r = re[i + 3], a3i = im[i + 3];
      const s0r = a0r + a1r, s0i = a0i + a1i, d0r = a0r - a1r, d0i = a0i - a1i;
      const s1r = a2r + a3r, s1i = a2i + a3i, d1r = a2r - a3r, d1i = a2i - a3i;
      re[i] = s0r + s1r; im[i] = s0i + s1i; re[i + 2] = s0r - s1r; im[i + 2] = s0i - s1i;
      re[i + 1] = d0r + d1i; im[i + 1] = d0i - d1r; re[i + 3] = d0r - d1i; im[i + 3] = d0i + d1r;
    }
    for (let size = 8, st = 3; size <= n; size <<= 1, st++) {
      const h = size >> 1, o = this.off[st];
      for (let k = 0; k < h; k++) {
        const c = tc[o + k], si = ts[o + k];
        for (let a = k; a < n; a += size) {
          const b = a + h;
          const br = re[b], bi = im[b];
          const tr = br * c - bi * si, ti = br * si + bi * c;
          const ar = re[a], ai = im[a];
          re[b] = ar - tr; im[b] = ai - ti; re[a] = ar + tr; im[a] = ai + ti;
        }
      }
    }
  }
}

// Real FFT of size n through a complex FFT of size n/2.
class RealFFT {
  constructor(n) {
    this.n = n; const h = this.h = n >> 1;
    this.c = new ComplexFFT(h);
    this.zr = new Float64Array(h); this.zi = new Float64Array(h);
    this.wr = new Float64Array(h + 1); this.wi = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) { this.wr[k] = Math.cos(TWO_PI * k / n); this.wi[k] = Math.sin(TWO_PI * k / n); }
  }
  // x: length n (real) -> Xr, Xi: length n/2+1
  forward(x, Xr, Xi) {
    const h = this.h, zr = this.zr, zi = this.zi, wr = this.wr, wi = this.wi;
    for (let m = 0; m < h; m++) { zr[m] = x[2 * m]; zi[m] = x[2 * m + 1]; }
    this.c.forward(zr, zi);
    Xr[0] = zr[0] + zi[0]; Xi[0] = 0; Xr[h] = zr[0] - zi[0]; Xi[h] = 0;
    for (let k = 1; k < h; k++) {
      const ar = zr[k], ai = zi[k], br = zr[h - k], bi = -zi[h - k];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const or = 0.5 * (ai - bi), oi = -0.5 * (ar - br);
      const c = wr[k], s = wi[k]; // W^k = c - j s
      Xr[k] = er + or * c + oi * s;
      Xi[k] = ei + oi * c - or * s;
    }
  }
  // Xr, Xi: length n/2+1 (Hermitian half) -> x: length n (real), includes 1/n
  inverse(Xr, Xi, x) {
    const h = this.h, zr = this.zr, zi = this.zi, wr = this.wr, wi = this.wi;
    for (let k = 0; k < h; k++) {
      const ar = Xr[k], ai = Xi[k], br = Xr[h - k], bi = -Xi[h - k];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      const c = wr[k], s = wi[k]; // e^{+j 2 pi k/n} = c + j s
      const or = dr * c - di * s, oi = dr * s + di * c;
      zr[k] = er - oi; zi[k] = -(ei + or); // conjugated: inverse through the forward transform
    }
    this.c.forward(zr, zi);
    const g = 1 / h;
    for (let m = 0; m < h; m++) { x[2 * m] = zr[m] * g; x[2 * m + 1] = -zi[m] * g; }
  }
}

// ---------------------------------------------------------------- the effect
export class VoiceFx {
  constructor(sampleRate, opts = {}) {
    const sr = num(sampleRate) && sampleRate >= 8000 && sampleRate <= 384000 ? sampleRate : 48000;
    this.sr = sr;
    const M = this.M = 2 * Math.round(sr * 0.0213333);          // analysis window (2048 @ 48 kHz)
    const N = this.N = nextPow2(2 * M);                          // FFT size (2x zero padding)
    const K = this.K = (N >> 1) + 1;
    this.R = Math.round(M / 4);                                   // hop
    const Ls = this.Ls = 2 * Math.round(M / 4);                  // synthesis window (M/2)
    const ref = this.ref = M >> 1;                               // phase reference / frame centre
    this.latencySamples = (M - ref) + (Ls >> 1) - 1;
    this.binHz = sr / N;
    this.nyq = sr / 2;

    // windows
    this.wa = new Float64Array(M);
    for (let n = 0; n < M; n++) this.wa[n] = 0.5 - 0.5 * Math.cos(TWO_PI * n / M);
    this.ws = new Float64Array(Ls);
    for (let n = 0; n < Ls; n++) this.ws[n] = 0.5 - 0.5 * Math.cos(TWO_PI * n / Ls);
    this.wp = new Float64Array(Ls);                              // ws * wa at each synthesis offset
    for (let n = 0; n < Ls; n++) { const k = ref - (Ls >> 1) + n; this.wp[n] = this.ws[n] * (k >= 0 && k < M ? this.wa[k] : 0); }

    // pitch search (50..480 Hz): normalised autocorrelation of the 0-4 kHz band on a lag grid of pD samples
    // (inverse FFT of size N/pD of the band-limited power spectrum - exact, as the band ends below its Nyquist)
    let pD = 4;
    while (pD > 1 && Math.round(4000 / this.binHz) + 2 >= (N / pD) >> 1) pD >>= 1;
    this.pD = pD; this.Np = N / pD;
    this.pfft = new RealFFT(this.Np);
    this.pXr = new Float64Array((this.Np >> 1) + 1); this.pXi = new Float64Array((this.Np >> 1) + 1);
    this.pac = new Float64Array(this.Np);
    this.tMin = Math.max(2, Math.floor(sr / 480 / pD));                  // lag grid units
    this.tMax = Math.min(((M >> 1) / pD | 0) - 2, Math.ceil(sr / 50 / pD), (this.Np >> 1) - 2);
    this.wacf = new Float64Array(this.tMax + 2);
    let e0 = 0; for (let n = 0; n < M; n++) e0 += this.wa[n] * this.wa[n];
    for (let t = 0; t < this.tMax + 2; t++) {
      let acc = 0; for (let n = 0; n + t * pD < M; n++) acc += this.wa[n] * this.wa[n + t * pD];
      this.wacf[t] = Math.max(1e-6, acc / e0);
    }
    this.nr = new Float64Array(this.tMax + 2);
    this.kLP0 = Math.round(3000 / this.binHz); this.kLP = Math.round(4000 / this.binHz);
    this.cLag = 0; this.vstr = 0; this.pBest = 0; this.altLag = 0; this.altV = 0;

    // envelope grid (factor 4 decimation of the K bins) and cepstrum
    this.Ne = (K - 1) >> 2; this.Nc = 2 * this.Ne;
    this.cfft = new RealFFT(this.Nc);
    this.cepIn = new Float64Array(this.Nc); this.cepR = new Float64Array(this.Ne + 1); this.cepI = new Float64Array(this.Ne + 1);
    this.lenv = new Float64Array(this.Ne + 1);
    this.gGrid = new Float64Array(this.Ne + 2);                  // natural-log magnitude envelope on the grid
    this.lifter = new Float64Array(this.Ne + 1);
    const Q = Math.min(this.Ne - 1, Math.round(0.0045 * sr));
    for (let q = 0; q <= this.Ne; q++) this.lifter[q] = q < Q ? 0.5 + 0.5 * Math.cos(Math.PI * q / Q) : 0;
    // voiced-source tilt (natural-log gain on the envelope grid): female voices have a steeper glottal spectrum
    this.tiltL = new Float64Array(this.Ne + 1);
    const h1Db = typeof opts.h1Db === 'number' && Number.isFinite(opts.h1Db) ? opts.h1Db : 3;   // fundamental boost (H1-H2)
    this.h1Gain = Math.pow(10, h1Db / 20);
    this.tiltDb = typeof opts.tiltDb === 'number' && Number.isFinite(opts.tiltDb) ? opts.tiltDb : 2; // dB per octave above 600 Hz
    for (let i = 0; i <= this.Ne; i++) {
      const f = 4 * i * sr / N;
      const db = f > 600 ? -Math.min(6, this.tiltDb * Math.log2(f / 600)) : 0;
      this.tiltL[i] = db * Math.LN10 / 20;
    }

    // FFT work buffers
    this.rfft = new RealFFT(N);
    this.fbuf = new Float64Array(N);
    this.Xr = new Float64Array(K); this.Xi = new Float64Array(K);
    this.Yr = new Float64Array(K); this.Yi = new Float64Array(K);
    this.pw = new Float64Array(K);
    this.tr = new Float64Array(K); this.ti = new Float64Array(K);
    this.tbuf = new Float64Array(N);
    this.pk = new Float64Array(1024);
    this.pkPos = 0;

    // streaming buffers
    this.inSize = nextPow2(2 * M + 256); this.inMask = this.inSize - 1;
    this.inRing = new Float32Array(this.inSize);
    this.outSize = nextPow2(2 * (M + Ls) + 256); this.outMask = this.outSize - 1;
    this.acc = new Float64Array(this.outSize); this.nrm = new Float64Array(this.outSize);
    this.t = 0; this.hopCnt = 0;

    // transient detector: 1 ms blocks of first-difference energy
    this.blk = Math.max(8, Math.round(sr / 1000));
    this.eSize = 512; this.eMask = 511;
    this.eRing = new Float64Array(this.eSize);
    this.blkAcc = 0; this.blkCnt = 0; this.blkIdx = 0; this.prevS = 0; this.peakBlk = 0;
    this.trans = false;

    // analysis state
    this.f0Prev = 0; this.voiced = false; this.psi = 0; this.peakE = 0; this.fx = 0;
    // running median F0 of the speaker: decaying histogram of log2 F0 (1/24 octave, 50..500 Hz)
    this.hb = 80; this.hist = new Float64Array(this.hb);
    this.histDecay = Math.exp(-this.R / (sr * 8));
    // prior: ~0.2 s of voicing around 110 Hz, so the first word does not swing the auto ratio
    const b0 = Math.round(Math.log2(110 / 50) * 24);
    for (let d = -2; d <= 2; d++) this.hist[b0 + d] = 4;
    this.histTot = 20; this.medF0 = 110;
    // maximum voiced frequency: periodicity of ~1/4-octave bands from 1 kHz up
    this.bandLo = new Int32Array(40); this.nBands = 0;
    for (let f = 125; f < this.nyq - 200 && this.nBands < 38; f *= 1.2) this.bandLo[this.nBands++] = Math.round(f / this.binHz);
    this.bandLo[this.nBands] = K - 1;
    this.bandMvf0 = 0; while (this.bandMvf0 < this.nBands - 1 && this.bandLo[this.bandMvf0] * this.binHz < 990) this.bandMvf0++;
    this.cov = new Uint8Array(K);                                // output bins covered by shifted harmonic regions
    this.seed = 0x9e3779b9 | 0; this.fillBias = 1.5;
    this.bP = new Float64Array(40);                              // band power, smoothed over frames
    // background-noise floor per band: minimum statistics over 6 sub-windows of ~0.25 s (1.5 s memory)
    this.nSub = 6; this.subLen = Math.max(4, Math.round(0.25 * sr / this.R)); this.subCnt = 0; this.subIdx = 0;
    this.subMin = new Float64Array(40 * this.nSub).fill(1e30);
    this.curMin = new Float64Array(40).fill(1e30);
    this.bFloor = new Float64Array(40).fill(1e-24);
    this.bh = new Float64Array(40);                              // band level re floor
    this.frames = 0;
    this.mvf = this.nyq; this.mvfS = this.nyq; this.mvfSnr = 4;

    // parameters
    this.pManual = 1.75; this.formant = 1.17; this.auto = false; this.mix = 1;
    this.ratio = 1.75; this.fRatio = 1.17; this.mixS = 1;
    this.mixK = 1 - Math.exp(-1 / (0.02 * sr));
    this.autoK = 1 - Math.exp(-this.R / (0.25 * sr));           // auto ratio follows the median, tau 0.25 s
    this.dcX = 0; this.dcY = 0; this.dcA = 1 - TWO_PI * 30 / sr;
    this.setParams(opts);
    this.ratio = this._targetRatio(); this.fRatio = this.formant; this.mixS = this.mix;
  }

  setParams(p) {
    if (!p || typeof p !== 'object') return;
    let autoGiven = false;
    if (typeof p.auto === 'boolean') { this.auto = p.auto; autoGiven = true; }
    if (num(p.pitch) && p.pitch > 0) {
      this.pManual = Math.min(2.5, Math.max(0.5, p.pitch));
      if (!autoGiven) this.auto = false;
    } else if (p.pitch === null && !autoGiven) this.auto = true;
    if (num(p.formant) && p.formant > 0) this.formant = Math.min(1.5, Math.max(0.7, p.formant));
    if (num(p.mix)) this.mix = Math.min(1, Math.max(0, p.mix));
  }

  _targetRatio() {
    if (!this.auto) return this.pManual;
    return Math.min(2.0, Math.max(1.3, 200 / this.medF0));
  }

  process(input, output) {
    const n = Math.min(input ? input.length : 0, output ? output.length : 0);
    const inRing = this.inRing, inMask = this.inMask, acc = this.acc, nrm = this.nrm, outMask = this.outMask;
    const D = this.latencySamples;
    for (let i = 0; i < n; i++) {
      let x = input[i];
      if (!(x > -4 && x < 4)) x = x > 0 ? 4 : x < 0 ? -4 : 0; // NaN -> 0, +-Inf clamped
      // DC blocker
      let y = x - this.dcX + this.dcA * this.dcY;
      if (y < 1e-25 && y > -1e-25) y = 0;
      this.dcX = x; this.dcY = y;
      inRing[this.t & inMask] = y;
      // transient detector feed
      const d = y - this.prevS; this.prevS = y;
      this.blkAcc += d * d;
      if (++this.blkCnt >= this.blk) {
        this.eRing[this.blkIdx & this.eMask] = this.blkAcc;
        if (this.blkAcc > this.peakBlk) this.peakBlk = this.blkAcc;
        this.peakBlk *= 0.9995;
        this.blkIdx++; this.blkAcc = 0; this.blkCnt = 0;
      }
      this.t++;
      if (++this.hopCnt >= this.R) { this.hopCnt = 0; this._frame(); }
      // output sample t-1-D
      const s = this.t - 1 - D;
      let wet = 0, dry = 0;
      if (s >= 0) {
        const j = s & outMask;
        const nv = nrm[j];
        wet = nv > 1e-3 ? acc[j] / nv : 0;
        acc[j] = 0; nrm[j] = 0;
        dry = inRing[s & inMask];
      }
      this.mixS += (this.mix - this.mixS) * this.mixK;
      let o = this.mixS * wet + (1 - this.mixS) * dry;
      // soft limiter
      const a = o < 0 ? -o : o;
      if (a > 0.85) o = (o > 0 ? 1 : -1) * (0.85 + 0.15 * Math.tanh((a - 0.85) / 0.15));
      output[i] = o === o ? o : 0;
    }
  }

  // log-magnitude envelope (natural log) at a fractional full-resolution bin position
  _lenvAt(k) {
    const p = k * 0.25;
    if (p <= 0) return this.lenv[0];
    const Ne = this.Ne;
    if (p >= Ne) return this.lenv[Ne];
    const i = p | 0, f = p - i;
    return this.lenv[i] + f * (this.lenv[i + 1] - this.lenv[i]);
  }

  // ------------------------------------------------------------ pitch
  // fills this.nr (normalised ACF on the lag grid), this.cLag (best lag in samples, fractional), this.vstr, this.pBest
  _pitch() {
    const pw = this.pw, tr = this.pXr, ti = this.pXi, ac = this.pac, nr = this.nr;
    const k0 = this.kLP0, k1 = this.kLP, Kp = (this.Np >> 1) + 1;
    for (let k = 0; k < Kp; k++) {
      tr[k] = k <= k0 ? pw[k] : k < k1 ? pw[k] * (k1 - k) / (k1 - k0) : 0;
      ti[k] = 0;
    }
    tr[0] = 0;
    this.pfft.inverse(tr, ti, ac);
    this.cLag = 0; this.vstr = 0;
    const r0 = ac[0];
    if (!(r0 > 1e-30)) return false;
    const tMin = this.tMin, tMax = this.tMax, w = this.wacf;
    for (let t = tMin - 1; t <= tMax + 1; t++) nr[t] = ac[t] / (r0 * w[t]);
    let best = -1, bt = 0;
    for (let t = tMin; t <= tMax; t++) if (nr[t] > nr[t - 1] && nr[t] >= nr[t + 1] && nr[t] > best) { best = nr[t]; bt = t; }
    if (bt === 0) return false;
    let lag = this._interp(bt) * this.pD;
    // prefer the shortest lag with an (almost) equally good peak: avoids sub-octave errors
    for (let d = 4; d >= 2; d--) {
      const tc = lag / d;
      if (tc < tMin * this.pD) continue;
      if (this._bestNear(tc, 0.04) && this.altV >= 0.85 * best) { lag = this.altLag; best = this.altV; break; }
    }
    this.pBest = best;
    this.cLag = lag;
    this.vstr = best > 1 ? 1 : best;
    return true;
  }
  _interp(bt) {
    const nr = this.nr;
    const ya = nr[bt - 1], yb = nr[bt], yc = nr[bt + 1];
    const den = ya - 2 * yb + yc;
    let d = den < 0 ? 0.5 * (ya - yc) / den : 0;
    if (!(d > -1 && d < 1)) d = 0;
    return bt + d;
  }
  // best local ACF maximum within tc*(1 +- tol) (tc in samples) -> this.altLag (samples) / this.altV
  _bestNear(tc, tol) {
    const nr = this.nr, g = tc / this.pD;
    const a = Math.max(this.tMin, Math.floor(g * (1 - tol))), b = Math.min(this.tMax, Math.ceil(g * (1 + tol)));
    let lm = -1, lt = 0;
    for (let t = a; t <= b; t++) if (nr[t] > nr[t - 1] && nr[t] >= nr[t + 1] && nr[t] > lm) { lm = nr[t]; lt = t; }
    if (!lt) return false;
    this.altLag = this._interp(lt) * this.pD; this.altV = lm;
    return true;
  }

  _medianUpdate(f0) {
    const hist = this.hist, hb = this.hb, d = this.histDecay;
    let tot = 0;
    for (let b = 0; b < hb; b++) { hist[b] *= d; tot += hist[b]; }
    let bi = Math.round(Math.log2(f0 / 50) * 24);
    if (bi < 0) bi = 0; else if (bi >= hb) bi = hb - 1;
    hist[bi] += 1; tot += 1;
    this.histTot = tot;
    const half = 0.5 * tot;
    let a = 0;
    for (let b = 0; b < hb; b++) {
      const nb = a + hist[b];
      if (nb >= half) {
        const fr = hist[b] > 0 ? (half - a) / hist[b] : 0.5;
        this.medF0 = 50 * Math.pow(2, (b - 0.5 + fr) / 24);
        break;
      }
      a = nb;
    }
  }

  // ------------------------------------------------------------ envelope
  _envelope(f0) {
    const K = this.K, Ne = this.Ne, Nc = this.Nc, pw = this.pw, cin = this.cepIn, cr = this.cepR, ci = this.cepI;
    const sp = f0 > 0 ? f0 : this.medF0;
    const w = Math.max(2, Math.min(16, Math.round(0.5 * sp / this.binHz)));
    let mx = 0; for (let k = 0; k < K; k++) if (pw[k] > mx) mx = pw[k];
    const floor = mx * 1e-12 + 1e-30;
    for (let i = 0; i <= Ne; i++) {
      const c = 4 * i;
      const lo = Math.max(0, c - w - 1), hi = Math.min(K - 1, c + w + 2);
      let m = 0; for (let k = lo; k <= hi; k++) if (pw[k] > m) m = pw[k];
      const v = 0.5 * Math.log(m + floor);
      cin[i] = v; if (i > 0 && i < Ne) cin[Nc - i] = v;
    }
    this.cfft.forward(cin, cr, ci);
    const L = this.lifter, g = 1 / Nc;
    for (let q = 0; q <= Ne; q++) { const v = cr[q] * g * L[q]; cin[q] = v; if (q > 0 && q < Ne) cin[Nc - q] = v; }
    this.cfft.forward(cin, cr, ci);
    for (let i = 0; i <= Ne; i++) this.lenv[i] = cr[i];
  }

  // ------------------------------------------------------------ transients (clicks, plosive bursts)
  _transientIn(t0, t1) {
    const blk = this.blk, e = this.eRing, em = this.eMask;
    const bA = Math.floor(t0 / blk), bB = Math.floor(t1 / blk);
    const last = this.blkIdx - 1;
    const floorE = this.peakBlk * 1e-3;
    // an isolated broadband spike: much stronger than anything in the previous 20 ms (so not a glottal pulse
    // of an ongoing vowel) and not followed by similar pulses within 12 ms (so not a voicing onset)
    for (let b = bA; b <= bB; b++) {
      if (b - 20 < 0 || b + 12 > last) continue;
      const v = e[b & em];
      if (v < floorE) continue;
      let pre = 0; for (let j = b - 20; j <= b - 2; j++) if (e[j & em] > pre) pre = e[j & em];
      if (v < 8 * pre) continue;
      let post = 0; for (let j = b + 2; j <= b + 12; j++) if (e[j & em] > post) post = e[j & em];
      if (v > 3 * post) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ one STFT frame
  _frame() {
    const M = this.M, N = this.N, K = this.K, ref = this.ref, sr = this.sr;
    const fb = this.fbuf, inRing = this.inRing, inMask = this.inMask, wa = this.wa;
    const Xr = this.Xr, Xi = this.Xi, Yr = this.Yr, Yi = this.Yi, pw = this.pw;
    const start = this.t - M;
    const centre = start + ref;
    // zero-phase frame: phase reference at index 0
    fb.fill(0);
    for (let n = 0; n < M; n++) fb[(n - ref + N) & (N - 1)] = inRing[(start + n) & inMask] * wa[n];
    this.rfft.forward(fb, Xr, Xi);
    let Ein = 0;
    for (let k = 0; k < K; k++) {
      const p = Xr[k] * Xr[k] + Xi[k] * Xi[k];
      pw[k] = p; Ein += (k === 0 || k === K - 1) ? p : 2 * p;
    }
    this.lastEin = Ein;
    this._bandTrack();
    // parameter smoothing (per frame)
    const tgt = this._targetRatio();
    this.ratio += (tgt - this.ratio) * (this.auto ? this.autoK : 0.35);
    this.fRatio += (this.formant - this.fRatio) * 0.35;
    const beta = this.ratio, alpha = this.fRatio;

    // level gating
    this.peakE = Math.max(Ein, this.peakE * 0.995);
    if (!(Ein > 1e-14 * M) || Ein < this.peakE * 1e-7) { this.voiced = false; this.f0Prev = 0; this.fx = 0; this._ola(centre, false); return; }

    // pitch / voicing
    let f0 = 0;
    if (this._pitch() && Ein > this.peakE * 1e-5) {
      const f0c = this.f0c = sr / this.cLag;
      if (this.voiced && this.f0Prev > 0) {
        const jump = Math.abs(Math.log2(f0c / this.f0Prev));
        if (jump < 0.25 && this.vstr > 0.3) f0 = f0c;
        else if (this._bestNear(sr / this.f0Prev, 0.15) && this.altV > 0.3 && this.altV > 0.5 * this.pBest) { f0 = sr / this.altLag; this.vstr = this.altV; }
      } else if (this.vstr > 0.4) {
        // voicing onset: a clear periodicity anywhere in the speaker's range, or a weaker one close to the median
        // (the analysis window is then only partly filled with the new vowel)
        const m = this.medF0, rel = f0c / m;
        if (this.vstr > 0.5 ? (rel > 0.55 && rel < 2.0) : (rel > 0.7 && rel < 1.45)) f0 = f0c;
      }
    }
    const voiced = f0 > 0;
    const trans = this.trans = this._transientIn(centre - (this.Ls >> 1), centre + (this.Ls >> 1));
    // crossover between harmonic (shifted) and noise (unshifted) paths, in output Hz
    let fx = 0, F = 0;
    if (voiced) {
      F = this._refineF0(f0 / this.binHz);
      const v = this.vstr;
      fx = v >= 0.6 ? this.nyq + 1000 : 1000 * Math.pow(this.nyq / 1000, Math.max(0, (v - 0.3) / 0.3));
      const mv = this.mvf = this._mvfEstimate();
      this.mvfS = this.voiced ? Math.sqrt(this.mvfS * mv) : mv;
      if (this.mvfS < this.nyq - 100 && fx > this.mvfS) fx = this.mvfS;
      if (trans && fx > 1500) fx = 1500;
    }
    this.fx = fx;
    this._envelope(f0);

    Yr.fill(0); Yi.fill(0);
    if (voiced) {
      const f0r = F * this.binHz;
      this._medianUpdate(f0r);
      if (this.voiced && this.f0Prev > 0) {
        this.psi += (beta - 1) * TWO_PI * 0.5 * (f0r + this.f0Prev) * this.R / sr;
        this.psi -= TWO_PI * Math.round(this.psi / TWO_PI);
      }
      this._shiftHarmonics(F, beta, alpha, (fx + 300) / this.binHz);
      this._noiseFill((fx + 300) / this.binHz);
      this.f0Prev = f0r;
    } else this.f0Prev = 0;
    this.voiced = voiced;
    // noise path above the crossover (all bins when unvoiced)
    const xLo = voiced ? (fx - 300) / this.binHz : -2, xHi = voiced ? (fx + 300) / this.binHz : -1;
    const k0n = Math.max(0, Math.floor(xLo));
    if (k0n < K) {
      // envelope warp gain E(f/alpha)/E(f) on the envelope grid, interpolated per bin below
      const gg = this.gGrid, Ne = this.Ne, lenv = this.lenv;
      for (let i = k0n >> 2; i <= Ne; i++) gg[i] = Math.exp(this._lenvAt(4 * i / alpha) - lenv[i]);
      gg[Ne + 1] = gg[Ne];
    }
    for (let k = k0n; k < K; k++) {
      const p = k * 0.25, i = p | 0;
      const g = this.gGrid[i] + (p - i) * (this.gGrid[i + 1] - this.gGrid[i]);
      if (k <= xHi) {
        const a = 0.5 + 0.5 * Math.cos(Math.PI * (k - xLo) / (xHi - xLo)); // harmonic weight 1 -> 0
        const b = (1 - a) * g;
        Yr[k] = a * Yr[k] + b * Xr[k]; Yi[k] = a * Yi[k] + b * Xi[k];
      } else { Yr[k] = g * Xr[k]; Yi[k] = g * Xi[k]; }
    }
    Yi[0] = 0; Yi[K - 1] = 0;
    // energy match
    let Eout = 0;
    for (let k = 0; k < K; k++) { const p = Yr[k] * Yr[k] + Yi[k] * Yi[k]; Eout += (k === 0 || k === K - 1) ? p : 2 * p; }
    if (!(Eout > 0)) { this._ola(centre, false); return; }
    let g = Math.sqrt(Ein / Eout);
    if (g > 4) g = 4; else if (g < 0.25) g = 0.25;
    for (let k = 0; k < K; k++) { Yr[k] *= g; Yi[k] *= g; }
    this.rfft.inverse(Yr, Yi, this.tbuf);
    this._ola(centre, true);
  }

  // band powers and background-noise floors (every frame, also unvoiced/silent ones)
  _bandTrack() {
    const pw = this.pw, bl = this.bandLo, nb = this.nBands, bP = this.bP, fl = this.bFloor;
    const cm = this.curMin, sm = this.subMin, ns = this.nSub;
    let k = bl[0];
    for (let b = 0; b < nb; b++) {
      let sp = 0;
      const e = bl[b + 1];
      for (; k < e; k++) sp += pw[k];
      bP[b] = 0.5 * bP[b] + 0.5 * sp;
    }
    // the floor learns only from frames that are not voiced (pauses, fricatives): a sustained vowel must never
    // become "background"; before the first such frame the floor stays at ~0 (no noise assumed)
    if (++this.frames <= 4 || this.voiced) return;
    for (let b = 0; b < nb; b++) {
      const p = bP[b] > 1e-24 ? bP[b] : 1e-24;
      if (p < cm[b]) cm[b] = p;
      let m = cm[b];
      for (let j = 0, o = b * ns; j < ns; j++) if (sm[o + j] < m) m = sm[o + j];
      fl[b] = m;
    }
    if (++this.subCnt >= this.subLen) {
      this.subCnt = 0;
      const j = this.subIdx; this.subIdx = (j + 1) % ns;
      for (let b = 0; b < nb; b++) { sm[b * ns + j] = cm[b]; cm[b] = 1e30; }
    }
  }

  // maximum voiced frequency (Hz): upper edge of the highest band that stands clearly (> ~6 dB) above the tracked
  // background-noise floor. Above it the frame goes through the noise path, so steady background noise is never
  // turned into a harmonic comb that switches on and off with voicing.
  _mvfEstimate() {
    const bl = this.bandLo, nb = this.nBands, bP = this.bP, fl = this.bFloor, bh = this.bh, thr = this.mvfSnr;
    let top = -1;
    for (let b = 0; b < nb; b++) { bh[b] = bP[b] / fl[b]; if (bh[b] >= thr) top = b; }
    if (top < this.bandMvf0) return bl[this.bandMvf0] * this.binHz;
    return top >= nb - 1 ? this.nyq : bl[top + 1] * this.binHz;
  }

  // background noise in the gaps the harmonic path leaves between shifted harmonics (random phase, at the tracked
  // noise-floor level), so steady background noise does not duck while someone speaks; ~0 for clean input
  _noiseFill(kMax) {
    const Yr = this.Yr, Yi = this.Yi, cov = this.cov, bl = this.bandLo, nb = this.nBands, fl = this.bFloor;
    const kEnd = Math.min(this.K - 2, Math.floor(kMax));
    let b = 0, amp = Math.sqrt(3 * this.fillBias * fl[0] / Math.max(1, bl[1] - bl[0]));
    let s = this.seed;
    for (let k = 1; k <= kEnd; k++) {
      while (b < nb - 1 && k >= bl[b + 1]) { b++; amp = Math.sqrt(3 * this.fillBias * fl[b] / Math.max(1, bl[b + 1] - bl[b])); }
      if (cov[k]) continue;
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const u1 = (s & 0xffff) / 32768 - 1, u2 = ((s >>> 16) & 0xffff) / 32768 - 1;
      Yr[k] += amp * u1; Yi[k] += amp * u2;
    }
    this.seed = s;
  }

  // least-squares F0 (in bins) from the first harmonic peaks
  _refineF0(F) {
    const K = this.K, pw = this.pw;
    let sn = 0, sd = 0;
    for (let h = 1; h <= 8; h++) {
      const c = h * F;
      if (c + 0.5 * F >= K - 2) break;
      if (this._peakNear(c, 0.3 * F)) {
        const p = this.pkPos, wgt = Math.sqrt(pw[Math.round(p)]);
        sn += wgt * p * h; sd += wgt * h * h;
      }
    }
    if (sd > 0) { const Fr = sn / sd; if (Math.abs(Fr / F - 1) < 0.04) return Fr; }
    return F;
  }

  // harmonic path: region shift + harmonic phase rotation + envelope re-weighting, output bins < kMaxOut
  _shiftHarmonics(F, beta, alpha, kMaxOut) {
    const K = this.K, Xr = this.Xr, Xi = this.Xi, Yr = this.Yr, Yi = this.Yi, pk = this.pk, cov = this.cov;
    cov.fill(0);
    let nh = 0;
    for (let h = 1; nh < pk.length; h++) {
      const c = h * F;
      if (c + 0.5 * F >= K - 1 || beta * (c - 0.5 * F) >= K - 1 || beta * (c - 0.5 * F) > kMaxOut) break;
      pk[nh++] = this._peakNear(c, 0.3 * F) ? this.pkPos : c;
    }
    const psi = this.psi;
    for (let j = 0; j < nh; j++) {
      const h = j + 1;
      const bLo = j === 0 ? pk[0] - 0.5 * F : 0.5 * (pk[j - 1] + pk[j]);
      const bHi = j === nh - 1 ? pk[j] + 0.5 * F : 0.5 * (pk[j] + pk[j + 1]);
      // exact (fractional) shift: harmonic h lands on beta*h*F; the region is resampled with 4-point Lagrange
      // interpolation of the (2x oversampled, zero-phase) spectrum, so no within-frame frequency error remains
      const sh = (beta - 1) * h * F;
      const oLo = Math.max(1, Math.floor(bLo + sh) + 1), oHi = Math.min(K - 2, Math.floor(bHi + sh));
      if (oHi < oLo) continue;
      for (let o = oLo; o <= oHi; o++) cov[o] = 1;
      let G = Math.exp(this._lenvAt((pk[j] + sh) / alpha) - this._lenvAt(pk[j]) + this.tiltL[Math.min(this.Ne, Math.round(0.25 * (pk[j] + sh)))]);
      const th = h * psi;
      if (h === 1) G *= this.h1Gain;
      const gc = G * Math.cos(th), gs = G * Math.sin(th);
      const p0 = oLo - sh, i0 = Math.floor(p0), f = p0 - i0;
      const wa = -f * (f - 1) * (f - 2) / 6, wb = (f + 1) * (f - 1) * (f - 2) / 2;
      const wc = -(f + 1) * f * (f - 2) / 2, wd = (f + 1) * f * (f - 1) / 6;
      for (let o = oLo, i = i0; o <= oHi; o++, i++) {
        if (i < 1 || i + 2 > K - 1) continue;
        const xr = wa * Xr[i - 1] + wb * Xr[i] + wc * Xr[i + 1] + wd * Xr[i + 2];
        const xi = wa * Xi[i - 1] + wb * Xi[i] + wc * Xi[i + 1] + wd * Xi[i + 2];
        Yr[o] += xr * gc - xi * gs;
        Yi[o] += xr * gs + xi * gc;
      }
    }
  }

  // strongest local maximum of the power spectrum within c +- r bins -> this.pkPos (fractional)
  _peakNear(c, r) {
    const pw = this.pw, K = this.K;
    const a = Math.max(1, Math.ceil(c - r)), b = Math.min(K - 2, Math.floor(c + r));
    let best = -1, bk = -1;
    for (let k = a; k <= b; k++) if (pw[k] > best && pw[k] >= pw[k - 1] && pw[k] >= pw[k + 1]) { best = pw[k]; bk = k; }
    if (bk < 0) return false;
    const la = Math.log(pw[bk - 1] + 1e-30), lb = Math.log(pw[bk] + 1e-30), lc = Math.log(pw[bk + 1] + 1e-30);
    const den = la - 2 * lb + lc;
    let d = den < 0 ? 0.5 * (la - lc) / den : 0;
    if (!(d > -0.5 && d < 0.5)) d = 0;
    this.pkPos = bk + d;
    return true;
  }

  _ola(centre, hasFrame) {
    const Ls = this.Ls, hl = Ls >> 1, N = this.N, Nm = N - 1;
    const acc = this.acc, nrm = this.nrm, om = this.outMask, ws = this.ws, wp = this.wp, y = this.tbuf;
    const base = centre - hl;
    if (hasFrame) {
      for (let n = 0; n < Ls; n++) {
        const j = (base + n) & om;
        acc[j] += y[(n - hl + N) & Nm] * ws[n];
        nrm[j] += wp[n];
      }
    } else {
      for (let n = 0; n < Ls; n++) nrm[(base + n) & om] += wp[n];
    }
  }
}

export default VoiceFx;
