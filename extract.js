// Album/live recording -> lead vocal melody as exact notes, in the browser.
// Port of tools/extract_melody.py: MDX-Net vocal separation, CREPE tiny pitch
// tracking, note splitting, band tuning, key detection and snapping to the key.
// Input audio must be 44.1 kHz stereo.

import { mixed } from './fft.js';

const SR = 44100;
const N_FFT = 7680, HOP = 1024, DIM_F = 3072, DIM_T = 256;
const N_BINS = N_FFT / 2 + 1;
const CHUNK = HOP * (DIM_T - 1);
const TRIM = N_FFT / 2;
const GEN = CHUNK - 2 * TRIM;
const COMPENSATE = 1.009;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

const WINDOW = new Float64Array(N_FFT);
for (let i = 0; i < N_FFT; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

// ---------- Vocal separation ----------

// Separates vocals chunk by chunk. Also collects instrumental spectral peaks
// for the tuning estimate. Returns { left, right, tuningCents }.
export async function separateVocals(left, right, session, onProgress = () => {}) {
  const fft = mixed(15, 512);
  const n = left.length;
  const pad = GEN - (n % GEN);
  const total = TRIM + n + pad + TRIM;
  const pl = new Float32Array(total), pr = new Float32Array(total);
  pl.set(left, TRIM); pr.set(right, TRIM);

  const outL = new Float32Array(n), outR = new Float32Array(n);
  const tuningHist = new Float64Array(100);
  const zr = new Float64Array(N_FFT), zi = new Float64Array(N_FFT);
  const Zr = new Float64Array(N_FFT), Zi = new Float64Array(N_FFT);
  // Mix spectra kept for the instrumental tuning estimate (every 8th frame).
  const mixSpec = new Float32Array(4 * DIM_F * DIM_T);
  const input = new Float32Array(4 * DIM_F * DIM_T);

  // Window-squared envelope for overlap-add is the same for every chunk.
  const olaLen = CHUNK + N_FFT;
  const env = new Float64Array(olaLen);
  for (let t = 0; t < DIM_T; t++) for (let i = 0; i < N_FFT; i++) env[t * HOP + i] += WINDOW[i] * WINDOW[i];

  const chunks = Math.ceil((n + pad) / GEN);
  for (let c = 0; c < chunks; c++) {
    const off = c * GEN;
    // STFT with reflect padding (torch.stft center=True); L and R share one
    // complex FFT as real and imaginary parts.
    for (let t = 0; t < DIM_T; t++) {
      for (let i = 0; i < N_FFT; i++) {
        let p = t * HOP + i - TRIM; // index inside the chunk
        if (p < 0) p = -p;
        else if (p >= CHUNK) p = 2 * CHUNK - 2 - p;
        zr[i] = pl[off + p] * WINDOW[i];
        zi[i] = pr[off + p] * WINDOW[i];
      }
      fft(zr, zi, Zr, Zi);
      for (let k = 0; k < DIM_F; k++) {
        const m = k === 0 ? 0 : N_FFT - k;
        const lr = (Zr[k] + Zr[m]) / 2, li = (Zi[k] - Zi[m]) / 2;
        const rr = (Zi[k] + Zi[m]) / 2, ri = (Zr[m] - Zr[k]) / 2;
        input[(0 * DIM_F + k) * DIM_T + t] = lr;
        input[(1 * DIM_F + k) * DIM_T + t] = li;
        input[(2 * DIM_F + k) * DIM_T + t] = rr;
        input[(3 * DIM_F + k) * DIM_T + t] = ri;
      }
    }
    mixSpec.set(input);

    const result = await session.run({ input: new session.Tensor('float32', input, [1, 4, DIM_F, DIM_T]) });
    const pred = result.output.data;

    // Instrumental = mix - vocals, sampled every 8th frame for tuning.
    for (let t = 4; t < DIM_T - 4; t += 8) collectTuning(mixSpec, pred, t, tuningHist);

    // ISTFT: rebuild Hermitian spectra for L and R into one complex IFFT.
    const ola = new Float64Array(olaLen * 2);
    for (let t = 0; t < DIM_T; t++) {
      zr.fill(0); zi.fill(0);
      for (let k = 0; k < DIM_F; k++) {
        const lr = pred[(0 * DIM_F + k) * DIM_T + t], rr = pred[(2 * DIM_F + k) * DIM_T + t];
        // irfft ignores the imaginary part of the DC bin.
        const li = k ? pred[(1 * DIM_F + k) * DIM_T + t] : 0, ri = k ? pred[(3 * DIM_F + k) * DIM_T + t] : 0;
        // Z = L + iR; inverse via forward FFT of the conjugate.
        zr[k] = lr - ri; zi[k] = -(li + rr);
        if (k > 0) { zr[N_FFT - k] = lr + ri; zi[N_FFT - k] = li - rr; }
      }
      fft(zr, zi, Zr, Zi);
      const base = t * HOP;
      for (let i = 0; i < N_FFT; i++) {
        ola[base + i] += (Zr[i] / N_FFT) * WINDOW[i];
        ola[olaLen + base + i] += (-Zi[i] / N_FFT) * WINDOW[i];
      }
    }
    // Drop torch's center pad, then the chunk's own trim on both sides.
    for (let i = TRIM; i < CHUNK - TRIM; i++) {
      const dst = off + i - TRIM;
      if (dst >= n) break;
      const j = i + N_FFT / 2;
      const e = env[j] > 1e-11 ? env[j] : 1;
      outL[dst] = (ola[j] / e) * COMPENSATE;
      outR[dst] = (ola[olaLen + j] / e) * COMPENSATE;
    }
    onProgress((c + 1) / chunks);
  }
  return { left: outL, right: outR, tuningCents: tuningFromHist(tuningHist) };
}

// Peaks of the instrumental magnitude spectrum vote for their offset from
// equal temperament, in cents.
function collectTuning(mix, voc, t, hist) {
  const binHz = SR / N_FFT;
  const lo = Math.ceil(80 / binHz), hi = Math.floor(2000 / binHz);
  const mag = new Float64Array(hi + 2);
  let max = 0;
  for (let k = lo - 1; k <= hi + 1; k++) {
    let s = 0;
    for (const ch of [0, 2]) {
      const r = mix[(ch * DIM_F + k) * DIM_T + t] - voc[(ch * DIM_F + k) * DIM_T + t];
      const i = mix[((ch + 1) * DIM_F + k) * DIM_T + t] - voc[((ch + 1) * DIM_F + k) * DIM_T + t];
      s += Math.hypot(r, i);
    }
    mag[k] = s;
    if (s > max) max = s;
  }
  if (max === 0) return;
  for (let k = lo; k <= hi; k++) {
    const m = mag[k];
    if (m < max * 0.1 || m <= mag[k - 1] || m < mag[k + 1]) continue;
    const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m), c = Math.log(mag[k + 1] + 1e-12);
    const d = a - 2 * b + c;
    const shift = d ? (0.5 * (a - c)) / d : 0;
    const hz = (k + shift) * binHz;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const cents = Math.round((midi - Math.round(midi)) * 100); // -50..50
    hist[(cents + 100) % 100] += m;
  }
}

function tuningFromHist(hist) {
  let best = 0, bestVal = -1;
  for (let i = 0; i < 100; i++) {
    let s = 0;
    for (let d = -3; d <= 3; d++) s += hist[(i + d + 100) % 100] * (4 - Math.abs(d));
    if (s > bestVal) { bestVal = s; best = i; }
  }
  return best >= 50 ? best - 100 : best;
}

// ---------- Pitch tracking (CREPE tiny) ----------

// Windowed-sinc resampler from 44.1 kHz to 16 kHz.
export function resampleTo16k(x) {
  const ratio = SR / 16000;
  const out = new Float32Array(Math.floor(x.length / ratio));
  const half = 16, cutoff = 16000 / SR * 0.95;
  for (let n = 0; n < out.length; n++) {
    const center = n * ratio;
    const i0 = Math.floor(center);
    let s = 0, wsum = 0;
    for (let i = i0 - half * 3; i <= i0 + half * 3; i++) {
      if (i < 0 || i >= x.length) continue;
      const d = i - center;
      const arg = Math.PI * d * cutoff;
      const sinc = d === 0 ? 1 : Math.sin(arg) / arg;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / (half * 3 + 1));
      s += x[i] * sinc * w;
      wsum += sinc * w;
    }
    out[n] = wsum ? s / wsum : 0;
  }
  return out;
}

const CREPE_HOP = 160, CREPE_WIN = 1024, CREPE_BINS = 360;
const binToCents = (b) => 20 * b + 1997.3794084376191;
const centsToMidi = (c) => 69 + 12 * Math.log2((10 * Math.pow(2, c / 1200)) / 440);

// Returns { times, midi } with NaN where unvoiced (10 ms hops).
export async function trackPitch(mono16k, session, onProgress = () => {}) {
  const frames = 1 + Math.floor(mono16k.length / CREPE_HOP);
  const padded = new Float32Array(mono16k.length + CREPE_WIN);
  padded.set(mono16k, CREPE_WIN / 2);
  const probs = new Float32Array(frames * CREPE_BINS);
  const batch = 512;
  for (let start = 0; start < frames; start += batch) {
    const count = Math.min(batch, frames - start);
    const buf = new Float32Array(count * CREPE_WIN);
    for (let f = 0; f < count; f++) {
      const off = (start + f) * CREPE_HOP;
      let mean = 0;
      for (let i = 0; i < CREPE_WIN; i++) mean += padded[off + i];
      mean /= CREPE_WIN;
      let v = 0;
      for (let i = 0; i < CREPE_WIN; i++) v += (padded[off + i] - mean) ** 2;
      const std = Math.max(Math.sqrt(v / (CREPE_WIN - 1)), 1e-10);
      for (let i = 0; i < CREPE_WIN; i++) buf[f * CREPE_WIN + i] = (padded[off + i] - mean) / std;
    }
    const res = await session.run({ frames: new session.Tensor('float32', buf, [count, CREPE_WIN]) });
    probs.set(res.probs.data, start * CREPE_BINS);
    onProgress(Math.min(1, (start + count) / frames));
  }

  const path = viterbi(probs, frames);
  const periodicity = new Float32Array(frames);
  const midi = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const b = path[f];
    periodicity[f] = probs[f * CREPE_BINS + b];
    // Refine within +-4 bins, weighted by activation.
    let s = 0, w = 0;
    for (let k = Math.max(0, b - 4); k <= Math.min(CREPE_BINS - 1, b + 4); k++) {
      const p = probs[f * CREPE_BINS + k];
      s += p * binToCents(k); w += p;
    }
    midi[f] = centsToMidi(w ? s / w : binToCents(b));
  }

  // Voicing: median-filtered periodicity and loudness.
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    times[f] = f * 0.01;
    const a = periodicity[Math.max(0, f - 1)], b = periodicity[f], c = periodicity[Math.min(frames - 1, f + 1)];
    const med = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    let e = 0;
    const off = f * CREPE_HOP;
    for (let i = 0; i < CREPE_WIN; i++) e += padded[off + i] ** 2;
    const rms = Math.sqrt(e / CREPE_WIN);
    const hz = 440 * Math.pow(2, (midi[f] - 69) / 12);
    if (med <= 0.45 || rms <= 0.01 || hz < 65 || hz > 1100) midi[f] = NaN;
  }
  return { times, midi };
}

// torchcrepe's Viterbi decoding: softmax per frame, triangular transitions
// up to 12 bins (240 cents) per 10 ms.
function viterbi(probs, frames) {
  const B = CREPE_BINS, W = 12;
  const logTrans = new Float64Array(2 * W + 1);
  let norm = 0;
  for (let d = -W; d <= W; d++) norm += W - Math.abs(d);
  for (let d = -W; d <= W; d++) logTrans[d + W] = Math.log(Math.max(W - Math.abs(d), 1e-12) / norm);
  // Rows near the edges have fewer neighbours; torchcrepe normalizes each row.
  const rowNorm = new Float64Array(B);
  for (let i = 0; i < B; i++) {
    let s = 0;
    for (let d = -W; d <= W; d++) if (i + d >= 0 && i + d < B) s += W - Math.abs(d);
    rowNorm[i] = Math.log(norm / s);
  }
  const back = new Uint16Array(frames * B);
  let score = new Float64Array(B), next = new Float64Array(B);
  const emit = (f, out) => {
    let max = -Infinity;
    for (let k = 0; k < B; k++) max = Math.max(max, probs[f * B + k]);
    let s = 0;
    for (let k = 0; k < B; k++) s += Math.exp(probs[f * B + k] - max);
    for (let k = 0; k < B; k++) out[k] = probs[f * B + k] - max - Math.log(s);
  };
  const e = new Float64Array(B);
  emit(0, e);
  for (let k = 0; k < B; k++) score[k] = e[k] - Math.log(B);
  for (let f = 1; f < frames; f++) {
    emit(f, e);
    for (let j = 0; j < B; j++) {
      let best = -Infinity, arg = 0;
      for (let d = -W + 1; d <= W - 1; d++) {
        const i = j - d;
        if (i < 0 || i >= B) continue;
        const v = score[i] + logTrans[d + W] + rowNorm[i];
        if (v > best) { best = v; arg = i; }
      }
      next[j] = best + e[j];
      back[f * B + j] = arg;
    }
    [score, next] = [next, score];
  }
  const path = new Uint16Array(frames);
  let bestK = 0;
  for (let k = 1; k < B; k++) if (score[k] > score[bestK]) bestK = k;
  path[frames - 1] = bestK;
  for (let f = frames - 1; f > 0; f--) path[f - 1] = back[f * B + path[f]];
  return path;
}

// ---------- Notes ----------

const median = (arr) => {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function splitNotes(times, midi, jump = 0.6, hold = 6, minLen = 0.08) {
  const notes = [];
  let cur = [], away = 0;
  const close = () => {
    if (cur.length && times[cur[cur.length - 1]] - times[cur[0]] >= minLen) {
      const k = cur.length;
      const a = Math.floor(k * 0.2), b = Math.max(Math.floor(k * 0.8), a + 1);
      const core = cur.slice(a, b).map((i) => midi[i]);
      notes.push({ start: times[cur[0]], end: times[cur[k - 1]] + 0.01, pitch: median(core) });
    }
  };
  for (let i = 0; i < midi.length; i++) {
    const m = midi[i];
    if (Number.isNaN(m)) { close(); cur = []; away = 0; continue; }
    if (cur.length && Math.abs(m - median(cur.slice(-15).map((j) => midi[j]))) > jump) {
      away++;
      if (away >= hold) {
        const start = away > 1 ? cur.slice(cur.length - (away - 1)) : [];
        cur = cur.slice(0, cur.length - (away - 1));
        close();
        cur = start; away = 0;
      }
    } else {
      away = 0;
    }
    cur.push(i);
  }
  close();
  return notes;
}

export function detectKey(notes) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((Math.round(n.pitch) % 12) + 12) % 12] += n.end - n.start;
  const corr = (a, b) => {
    const ma = a.reduce((s, x) => s + x, 0) / 12, mb = b.reduce((s, x) => s + x, 0) / 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / Math.sqrt(da * db || 1);
  };
  let best = 0, bestScore = -Infinity;
  for (let k = 0; k < 12; k++) {
    const prof = MAJOR_PROFILE.map((_, i) => MAJOR_PROFILE[(i - k + 12) % 12]);
    const s = corr(prof, hist);
    if (s > bestScore) { bestScore = s; best = k; }
  }
  return best;
}

export function snapToKey(pitch, tonic) {
  let best = null;
  for (let s = Math.floor(pitch) - 2; s <= Math.floor(pitch) + 3; s++) {
    if (!MAJOR_STEPS.includes((((s - tonic) % 12) + 12) % 12)) continue;
    if (best == null || Math.abs(s - pitch) < Math.abs(best - pitch)) best = s;
  }
  return Math.abs(best - pitch) <= 0.8 ? best : Math.round(pitch);
}

// A note an octave away from everything around it is almost always a pitch
// tracking octave error; move it back next to its neighbours.
export function fixOctaves(notes) {
  return notes.map((n, i) => {
    const around = notes.slice(Math.max(0, i - 4), i).concat(notes.slice(i + 1, i + 5)).map((x) => x.midi);
    if (around.length < 3) return n;
    const med = median(around);
    if (Math.abs(n.midi - med) < 9) return n;
    for (const d of [-12, 12]) if (Math.abs(n.midi + d - med) <= 6) return { ...n, midi: n.midi + d };
    return n;
  });
}

export function buildMelody(times, midi, tuningCents, keyName) {
  const shifted = midi.map((m) => m - tuningCents / 100);
  const notes = splitNotes(times, shifted);
  const tonic = keyName ? NAMES.indexOf(keyName) : detectKey(notes);
  const snapped = fixOctaves(notes.map((n) => ({ ...n, midi: snapToKey(n.pitch, tonic) })));
  const out = [];
  for (const n of snapped) {
    const cents = Math.round((n.pitch - n.midi) * 100);
    const note = { start: +n.start.toFixed(2), end: +n.end.toFixed(2), midi: n.midi, sungCents: ((cents + 600) % 1200 + 1200) % 1200 - 600 };
    const prev = out[out.length - 1];
    if (prev && prev.midi === note.midi && note.start - prev.end < 0.06) prev.end = note.end;
    else out.push(note);
  }
  return { version: 1, key: NAMES[tonic], tuningCents: Math.round(tuningCents), notes: out };
}

// Whole pipeline. sessions: { mdx, crepe } created by the caller; each has
// a Tensor constructor attached as session.Tensor.
export async function extractMelody(left, right, sessions, onProgress = () => {}, keyName = null) {
  const vocals = await separateVocals(left, right, sessions.mdx, (f) => onProgress('separate', f));
  const mono = new Float32Array(vocals.left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (vocals.left[i] + vocals.right[i]) / 2;
  onProgress('resample', 0);
  const m16 = resampleTo16k(mono);
  const { times, midi } = await trackPitch(m16, sessions.crepe, (f) => onProgress('pitch', f));
  return buildMelody(times, midi, vocals.tuningCents, keyName);
}

export { NAMES };
