// YIN pitch detection and helpers for MIDI / cents math.

const NOTE_NAMES = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
const NOTE_LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const MIN_HZ = 70;   // below low E2 (bass)
export const MAX_HZ = 1100; // above C6 (soprano)

// Returns frequency in Hz, or null when the frame is silent or unvoiced.
export function detectPitch(buf, sampleRate, threshold = 0.12) {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.01) return null;

  const tauMin = Math.floor(sampleRate / MAX_HZ);
  const tauMax = Math.min(Math.floor(sampleRate / MIN_HZ), Math.floor(buf.length / 2));
  const w = buf.length - tauMax;
  const d = new Float32Array(tauMax + 1);

  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < w; i++) {
      const diff = buf[i] - buf[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // Cumulative mean normalized difference.
  let running = 0;
  d[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    d[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
  }

  let tau = -1;
  for (let t = Math.max(2, tauMin); t < tauMax; t++) {
    if (d[t] < threshold) {
      while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau === -1) return null;

  // Parabolic interpolation around the minimum.
  const s0 = d[tau - 1], s1 = d[tau], s2 = d[tau + 1];
  const denom = s0 + s2 - 2 * s1;
  const better = denom !== 0 ? tau + (s0 - s2) / (2 * denom) : tau;
  const hz = sampleRate / better;
  return hz >= MIN_HZ && hz <= MAX_HZ ? hz : null;
}

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function noteName(midi) {
  const n = Math.round(midi);
  const pc = ((n % 12) + 12) % 12;
  const octave = Math.floor(n / 12) - 1;
  return { ko: NOTE_NAMES[pc], letter: NOTE_LETTERS[pc] + octave };
}

// Signed difference sung - target in cents. With fold, octave errors are
// ignored so any voice part can follow any reference.
export function centsOff(sung, target, fold) {
  let diff = (sung - target) * 100;
  if (fold) diff = ((((diff + 600) % 1200) + 1200) % 1200) - 600;
  return diff;
}

// Shift a sung midi value by whole octaves to sit nearest the target.
export function nearestOctave(sung, target) {
  return sung - 12 * Math.round((sung - target) / 12);
}

// Median filter over a contour of {t, m} points (m may be null).
export function smoothContour(points, radius = 2) {
  return points.map((p, i) => {
    if (p.m == null) return p;
    const win = [];
    for (let j = i - radius; j <= i + radius; j++) {
      if (j >= 0 && j < points.length && points[j].m != null) win.push(points[j].m);
    }
    win.sort((a, b) => a - b);
    return { t: p.t, m: win[Math.floor(win.length / 2)] };
  });
}

// Drop isolated blips: voiced runs shorter than minRun points become null.
export function dropBlips(points, minRun = 4) {
  const out = points.map((p) => ({ ...p }));
  let start = -1;
  for (let i = 0; i <= out.length; i++) {
    const voiced = i < out.length && out[i].m != null;
    if (voiced && start === -1) start = i;
    if (!voiced && start !== -1) {
      if (i - start < minRun) for (let j = start; j < i; j++) out[j].m = null;
      start = -1;
    }
  }
  return out;
}

// Snap a contour to the nearest semitones, keeping glides short.
export function snapContour(points) {
  return points.map((p) => (p.m == null ? p : { t: p.t, m: Math.round(p.m) }));
}

// Run pitch detection over a whole decoded AudioBuffer.
export function contourFromBuffer(audioBuffer, hop = 512, size = 2048) {
  const sr = audioBuffer.sampleRate;
  const ch = audioBuffer.getChannelData(0);
  const frame = new Float32Array(size);
  const points = [];
  for (let start = 0; start + size <= ch.length; start += hop) {
    frame.set(ch.subarray(start, start + size));
    const hz = detectPitch(frame, sr);
    points.push({ t: (start + size / 2) / sr, m: hz ? hzToMidi(hz) : null });
  }
  return points;
}

// Look up the target midi at time t (nearest point within maxGap seconds).
export function targetAt(points, t, maxGap = 0.08) {
  let lo = 0, hi = points.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  let best = null, bestDt = Infinity;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= points.length) continue;
    const dt = Math.abs(points[i].t - t);
    if (dt < bestDt) { bestDt = dt; best = points[i]; }
  }
  return best && bestDt <= maxGap ? best.m : null;
}

const WRONG_NOTE = 80; // cents; beyond this the singer is on another note

// Summarize a practice take. samples: [{t, sung, target}] with cents already
// computed as err. Returns accuracy, mean offset, and drift on held notes.
export function analyzeTake(samples, tolerance = 25) {
  const voiced = samples.filter((s) => s.err != null);
  if (voiced.length < 10) return null;
  const inTune = voiced.filter((s) => Math.abs(s.err) <= tolerance).length;
  // A whole wrong note is not intonation; keep it out of offset and drift.
  const near = voiced.filter((s) => Math.abs(s.err) <= WRONG_NOTE);
  const mean = near.length ? near.reduce((a, s) => a + s.err, 0) / near.length : null;

  // Held notes: runs where the target stays on one pitch for >= 0.6 s.
  const drifts = [];
  let run = [];
  const flush = () => {
    if (run.length > 1 && run[run.length - 1].t - run[0].t >= 0.6) {
      const n = run.length;
      const mt = run.reduce((a, s) => a + s.t, 0) / n;
      const me = run.reduce((a, s) => a + s.err, 0) / n;
      let num = 0, den = 0;
      for (const s of run) { num += (s.t - mt) * (s.err - me); den += (s.t - mt) ** 2; }
      const slope = den ? num / den : 0;
      drifts.push({ start: run[0].t, change: slope * (run[n - 1].t - run[0].t), target: run[0].target });
    }
    run = [];
  };
  for (const s of near) {
    const prev = run[run.length - 1];
    if (prev && (Math.abs(s.target - prev.target) > 0.5 || s.t - prev.t > 0.25)) flush();
    run.push(s);
  }
  flush();

  const avgDrift = drifts.length ? drifts.reduce((a, d) => a + d.change, 0) / drifts.length : null;
  const worst = [...drifts].sort((a, b) => a.change - b.change).slice(0, 3).filter((d) => d.change < -10);
  return { accuracy: inTune / voiced.length, wrongNotes: 1 - near.length / voiced.length, mean, avgDrift, heldNotes: drifts.length, worst };
}
