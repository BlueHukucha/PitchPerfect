import {
  detectPitch, hzToMidi, midiToHz, noteName, centsOff, nearestOctave,
  smoothContour, dropBlips, snapContour, contourFromBuffer, targetAt, analyzeTake,
} from './pitch.js';
import { listSongs, getSong, saveSong, deleteSong } from './store.js';

const $ = (id) => document.getElementById(id);
const TOLERANCE = 25; // cents counted as "in tune" when scoring a take
const BAND = 15;      // green band drawn on the long-tone graph

// ---------- Audio ----------

let ctx = null, analyser = null, stream = null, frame = null;
const recent = [];

function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

async function ensureMic() {
  audioContext();
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const src = ctx.createMediaStreamSource(stream);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  frame = new Float32Array(analyser.fftSize);
}

// Current sung pitch as a midi float, median of the last 3 frames.
function readPitch() {
  analyser.getFloatTimeDomainData(frame);
  const hz = detectPitch(frame, ctx.sampleRate);
  recent.push(hz ? hzToMidi(hz) : null);
  if (recent.length > 3) recent.shift();
  const voiced = recent.filter((m) => m != null);
  if (hz == null || voiced.length < 2) return null;
  voiced.sort((a, b) => a - b);
  return voiced[Math.floor(voiced.length / 2)];
}

function micError(err) {
  return err && err.name === 'NotAllowedError'
    ? '마이크 권한이 꺼져 있어요. 브라우저 설정에서 이 사이트의 마이크를 허용해 주세요.'
    : '마이크를 켤 수 없어요. 다른 앱이 마이크를 쓰고 있는지 확인해 주세요.';
}

// One animation loop; each screen sets its own tick function.
let tick = null;
function loop() {
  if (tick) tick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- Drawing ----------

let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['ink', 'muted', 'line', 'good', 'warn', 'bad', 'target', 'surface']) {
    colors[k] = cs.getPropertyValue('--' + k).trim();
  }
}
readColors();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);

function prep(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  canvas.dataset.h ??= canvas.getAttribute('height');
  const h = Number(canvas.dataset.h);
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

const errColor = (c) => (Math.abs(c) <= BAND ? colors.good : Math.abs(c) <= TOLERANCE + 15 ? colors.warn : colors.bad);

function centsLabel(c) {
  const r = Math.round(c);
  if (Math.abs(r) <= 5) return '정확해요';
  return r < 0 ? `${-r} cent 낮음` : `${r} cent 높음`;
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- Tabs ----------

const views = ['tone', 'songs', 'add'];
function showView(name) {
  stopAll();
  for (const v of views) {
    $('view-' + v).hidden = v !== name;
    $('tab-' + v).setAttribute('aria-selected', String(v === name));
  }
  if (name === 'songs') renderSongList();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

function stopAll() {
  stopTone();
  if (practice.running) stopPractice(false);
  if (rec.recorder) stopRecording();
}

// ---------- Long tone ----------

const tone = { running: false, history: [], lock: null, runStart: null, firstVals: [], silentSince: null, offSince: null };

for (let m = 40; m <= 84; m++) {
  const n = noteName(m);
  const opt = new Option(`${n.ko} (${n.letter})`, m);
  if (m === 60) opt.selected = true;
  $('ref-note').add(opt);
}

$('ref-play').addEventListener('click', () => {
  const c = audioContext();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.value = midiToHz(Number($('ref-note').value));
  const t = c.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.3, t + 0.05);
  gain.gain.setValueAtTime(0.3, t + 1.6);
  gain.gain.linearRampToValueAtTime(0, t + 2);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 2.05);
});

$('tone-start').addEventListener('click', async () => {
  if (tone.running) { stopTone(); return; }
  try {
    await ensureMic();
  } catch (err) {
    $('tone-letter').textContent = micError(err);
    return;
  }
  Object.assign(tone, { running: true, history: [], lock: null, runStart: null, firstVals: [] });
  $('tone-start').textContent = '마이크 끄기';
  tick = toneTick;
});

function stopTone() {
  if (!tone.running) return;
  tone.running = false;
  tick = null;
  $('tone-start').textContent = '마이크 켜기';
}

function toneTick() {
  const now = ctx.currentTime;
  const m = readPitch();

  if (m == null) {
    if (tone.silentSince == null) tone.silentSince = now;
    if (now - tone.silentSince > 0.3) { tone.lock = null; tone.runStart = null; tone.firstVals = []; }
  } else {
    tone.silentSince = null;
    if (tone.runStart == null) tone.runStart = now;
    // Moved to another note: start over on the new one.
    if (tone.lock != null && Math.abs(m - tone.lock) > 0.7) {
      tone.offSince ??= now;
      if (now - tone.offSince > 0.2) { tone.lock = null; tone.runStart = now; tone.firstVals = []; }
    } else {
      tone.offSince = null;
    }
    // Lock onto the note the singer settles on in the first 0.35 s.
    if (tone.lock == null) {
      tone.firstVals.push(m);
      if (now - tone.runStart > 0.35) {
        const s = [...tone.firstVals].sort((a, b) => a - b);
        tone.lock = Math.round(s[Math.floor(s.length / 2)]);
      }
    }
  }

  const target = tone.lock ?? (m != null ? Math.round(m) : null);
  const c = m != null ? (m - target) * 100 : null;
  tone.history.push({ t: now, c, locked: tone.lock != null });
  while (tone.history.length && now - tone.history[0].t > 8) tone.history.shift();

  if (m != null) {
    const n = noteName(target);
    $('tone-note').textContent = n.ko;
    $('tone-letter').textContent = n.letter;
    $('tone-cents').textContent = centsLabel(c);
    $('tone-cents').className = 'cents ' + (Math.abs(c) <= BAND ? 'good' : Math.abs(c) <= 40 ? 'warn' : 'bad');
    $('tone-needle').style.left = `calc(${50 + Math.max(-50, Math.min(50, c))}% - 2px)`;
  } else {
    $('tone-cents').innerHTML = '&nbsp;';
  }

  // Compare the latest half second with the first half second of this note.
  let driftText = ' ';
  if (tone.lock != null && tone.runStart != null && now - tone.runStart > 1.5) {
    const run = tone.history.filter((p) => p.t >= tone.runStart + 0.35 && p.c != null && p.locked);
    const head = run.filter((p) => p.t < tone.runStart + 0.85);
    const tail = run.filter((p) => p.t > now - 0.5);
    if (head.length > 5 && tail.length > 5) {
      const avg = (a) => a.reduce((s, p) => s + p.c, 0) / a.length;
      const d = Math.round(avg(tail) - avg(head));
      driftText = d <= -8 ? `처음보다 ${-d} cent 처졌어요` : d >= 8 ? `처음보다 ${d} cent 올라갔어요` : '흔들림 없이 유지 중이에요';
    }
  }
  $('tone-drift').textContent = driftText;
  drawTone();
}

function drawTone() {
  const { g, w, h } = prep($('tone-canvas'));
  const range = 60;
  const y = (c) => h / 2 - (c / range) * (h / 2 - 8);
  g.fillStyle = colors.good;
  g.globalAlpha = 0.15;
  g.fillRect(0, y(BAND), w, y(-BAND) - y(BAND));
  g.globalAlpha = 1;
  g.strokeStyle = colors.line;
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  g.fillStyle = colors.muted;
  g.font = '11px ui-monospace, Menlo, monospace';
  g.fillText('+50', 4, y(50) + 4);
  g.fillText('-50', 4, y(-50) + 4);

  const now = ctx ? ctx.currentTime : 0;
  for (const p of tone.history) {
    if (p.c == null) continue;
    const x = w - ((now - p.t) / 8) * w;
    g.fillStyle = errColor(p.c);
    g.beginPath();
    g.arc(x, y(Math.max(-range, Math.min(range, p.c))), 2.2, 0, Math.PI * 2);
    g.fill();
  }
}

// ---------- Add a song ----------

const rec = { recorder: null, chunks: [], live: [], t0: 0, blob: null, contour: null, duration: 0, melody: null };

function setStatus(text) { $('add-status').textContent = text; }

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KEY_KO = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
KEY_NAMES.forEach((k, i) => $('add-key').add(new Option(`${k} (${KEY_KO[i]})`, k)));

// Extracted notes -> the point contour practice uses (one point per 20 ms).
function notesToContour(notes) {
  const pts = [];
  for (const n of notes) {
    for (let t = n.start; t < n.end; t += 0.02) pts.push({ t: +t.toFixed(2), m: n.midi });
    pts.push({ t: n.end, m: n.midi }, { t: +(n.end + 0.01).toFixed(2), m: null });
  }
  return pts;
}

// ---------- Melody from an album / live recording ----------

let extractWorker = null;
const STAGES = {
  download: ['모델 받는 중 (처음 한 번만, 약 70MB)', 0, 0.1],
  prepare: ['준비 중', 0.1, 0.12],
  separate: ['리드보컬 분리 중', 0.12, 0.85],
  resample: ['음정 분석 준비 중', 0.85, 0.87],
  pitch: ['음정 분석 중', 0.87, 1],
};

$('add-original').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || extractWorker) return;
  if (!$('add-name').value) $('add-name').value = file.name.replace(/\.[^.]+$/, '');
  resetAddPreview();
  setStatus('원곡을 여는 중…');
  let buffer;
  try {
    const off = new OfflineAudioContext(2, 44100, 44100);
    buffer = await off.decodeAudioData(await file.arrayBuffer());
  } catch {
    setStatus('이 파일은 열 수 없어요. mp3, m4a, wav 파일을 써 주세요.');
    return;
  }
  const left = buffer.getChannelData(0).slice();
  const right = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).slice();
  const started = performance.now();
  $('extract-box').hidden = false;
  $('add-original-label').classList.add('busy');
  setStatus(/iPhone|iPad|Android/.test(navigator.userAgent)
    ? '폰에서는 오래 걸리거나 멈출 수 있어요. 가능하면 PC 크롬에서 해 주세요.' : '');

  extractWorker = new Worker('extract-worker.js', { type: 'module' });
  extractWorker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      const [label, a, b] = STAGES[data.stage];
      const frac = a + (b - a) * data.frac;
      $('extract-progress').value = frac;
      $('extract-stage').textContent = `${label} ${Math.round(data.frac * 100)}%`;
      const secs = (performance.now() - started) / 1000;
      const remain = data.stage === 'separate' && data.frac > 0.05
        ? ` · 약 ${Math.max(1, Math.round(((secs / frac) * (1 - frac)) / 60))}분 남음` : '';
      $('extract-time').textContent = `${fmtTime(secs)}${remain}`;
    } else if (data.type === 'done') {
      finishExtract();
      useMelody(file, data.melody, buffer.duration);
    } else if (data.type === 'error') {
      finishExtract();
      setStatus(`멜로디를 뽑지 못했어요. (${data.message}) 새로고침 후 다시 해 보세요.`);
    }
  };
  extractWorker.postMessage({ left, right, key: $('add-key').value || null }, [left.buffer, right.buffer]);
});

function finishExtract() {
  if (extractWorker) extractWorker.terminate();
  extractWorker = null;
  $('extract-box').hidden = true;
  $('add-original-label').classList.remove('busy');
}

function useMelody(blob, melody, duration) {
  if (melody.notes.length < 5) {
    setStatus('리드보컬 멜로디를 찾지 못했어요. 보컬이 있는 원곡인지 확인해 주세요.');
    return;
  }
  rec.blob = blob;
  rec.melody = melody;
  rec.contour = notesToContour(melody.notes);
  rec.duration = duration;
  const near = melody.notes.filter((n) => Math.abs(n.sungCents) <= 20).length;
  setStatus(`키 ${melody.key}, ${melody.notes.length}개 음을 찾았어요. 원곡 가수가 부른 음의 ${Math.round((near / melody.notes.length) * 100)}%는 정확한 음에서 ±20 cent 안이었고, 나머지는 정확한 음으로 보정했어요.`);
  $('add-canvas').hidden = false;
  $('add-save').hidden = false;
  drawPreview();
}

function resetAddPreview() {
  rec.blob = rec.contour = rec.melody = null;
  $('add-canvas').hidden = $('add-snap-wrap').hidden = $('add-save').hidden = true;
}

// ---------- Song files shared through KakaoTalk etc. ----------
// Layout: "PITCHPP1" magic, uint32 header length, JSON header, audio bytes.

const MAGIC = 'PITCHPP1';

async function packSong(song) {
  const header = new TextEncoder().encode(JSON.stringify({
    name: song.name, part: song.part, key: song.key, notes: song.notes,
    duration: song.duration, audioType: song.audio.type,
  }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length);
  return new Blob([MAGIC, len, header, song.audio], { type: 'application/octet-stream' });
}

async function unpackSong(file) {
  const buf = await file.arrayBuffer();
  if (new TextDecoder().decode(buf.slice(0, 8)) !== MAGIC) throw new Error('not a song file');
  const len = new DataView(buf, 8, 4).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(buf.slice(12, 12 + len)));
  const audio = new Blob([buf.slice(12 + len)], { type: header.audioType || 'audio/mpeg' });
  return { header, audio };
}

$('add-package').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { header, audio } = await unpackSong(file);
    const song = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      name: header.name, part: header.part, key: header.key, notes: header.notes,
      createdAt: Date.now(), audio, contour: notesToContour(header.notes),
      duration: header.duration, takes: [],
    };
    await saveSong(song);
    showView('songs');
    openPractice(song.id);
  } catch {
    setStatus('곡 파일을 열 수 없어요. 리더가 보낸 .pitch 파일인지 확인해 주세요.');
  }
});

$('song-export').addEventListener('click', async () => {
  const song = practice.song;
  if (!song.notes) {
    $('song-export').textContent = '직접 녹음한 곡은 아직 공유할 수 없어요';
    return;
  }
  const url = URL.createObjectURL(await packSong(song));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${song.name}.pitch`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

$('add-record').addEventListener('click', async () => {
  if (rec.recorder) { stopRecording(); return; }
  try {
    await ensureMic();
  } catch (err) {
    setStatus(micError(err));
    return;
  }
  rec.chunks = [];
  rec.live = [];
  rec.recorder = new MediaRecorder(stream);
  rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.recorder.onstop = () => finishRecording();
  rec.recorder.start();
  rec.t0 = ctx.currentTime;
  $('add-record').textContent = '녹음 멈추기';
  $('add-record').classList.add('recording');
  tick = () => {
    const t = ctx.currentTime - rec.t0;
    rec.live.push({ t, m: readPitch() });
    setStatus(`녹음 중 ${fmtTime(t)}`);
  };
});

function stopRecording() {
  tick = null;
  if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  $('add-record').textContent = '지금 녹음하기';
  $('add-record').classList.remove('recording');
}

async function finishRecording() {
  const type = rec.recorder.mimeType || 'audio/mp4';
  rec.recorder = null;
  const blob = new Blob(rec.chunks, { type });
  let points = rec.live;
  try {
    const buffer = await audioContext().decodeAudioData(await blob.arrayBuffer());
    points = contourFromBuffer(buffer);
  } catch {
    // Some browsers cannot decode their own recordings; the live contour still works.
  }
  useReference(blob, points);
}

$('add-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('음정을 분석하는 중…');
  try {
    const buffer = await audioContext().decodeAudioData(await file.arrayBuffer());
    if (!$('add-name').value) $('add-name').value = file.name.replace(/\.[^.]+$/, '');
    useReference(file, contourFromBuffer(buffer));
  } catch {
    setStatus('이 파일은 열 수 없어요. mp3, m4a, wav 파일을 써 주세요.');
  }
  e.target.value = '';
});

function useReference(blob, points) {
  const clean = smoothContour(dropBlips(points), 3);
  const voiced = clean.filter((p) => p.m != null).length;
  if (voiced < 20) {
    setStatus('멜로디를 찾지 못했어요. 조용한 곳에서 멜로디만 또렷하게 녹음해 주세요.');
    return;
  }
  rec.blob = blob;
  rec.melody = null;
  rec.contour = clean;
  rec.duration = points.length ? points[points.length - 1].t : 0;
  setStatus(`${fmtTime(rec.duration)} 분량의 멜로디를 찾았어요. 목표선을 확인하고 저장해 주세요.`);
  $('add-canvas').hidden = false;
  $('add-snap-wrap').hidden = false;
  $('add-save').hidden = false;
  drawPreview();
}

$('add-snap').addEventListener('change', drawPreview);

const finalContour = () => ($('add-snap').checked ? snapContour(rec.contour) : rec.contour);

function drawPreview() {
  if (!rec.contour) return;
  const pts = rec.melody ? rec.contour : finalContour();
  const { g, w, h } = prep($('add-canvas'));
  const { lo, hi } = rangeOf(pts, true);
  const y = (m) => h - 10 - ((m - lo) / (hi - lo)) * (h - 20);
  const x = (t) => (t / Math.max(rec.duration, 0.1)) * w;
  g.strokeStyle = colors.target;
  g.lineWidth = 3;
  g.lineCap = 'round';
  strokeContour(g, pts, x, y);
}

// Pitch range to draw. Robust mode ignores the odd stray note.
function rangeOf(pts, robust = false) {
  const ms = pts.filter((p) => p.m != null).map((p) => p.m).sort((a, b) => a - b);
  if (!ms.length) return { lo: 55, hi: 75 };
  const lo = robust ? ms[Math.floor(ms.length * 0.03)] : ms[0];
  const hi = robust ? ms[Math.floor(ms.length * 0.97)] : ms[ms.length - 1];
  return { lo: lo - 2, hi: hi + 2 };
}

function strokeContour(g, pts, x, y, from = -Infinity, to = Infinity) {
  g.beginPath();
  let pen = false, prev = null;
  for (const p of pts) {
    if (p.t < from || p.t > to) { pen = false; continue; }
    if (p.m == null || (prev && p.t - prev.t > 0.1)) pen = false;
    if (p.m != null) {
      if (pen) g.lineTo(x(p.t), y(p.m)); else g.moveTo(x(p.t), y(p.m));
      pen = true;
    }
    prev = p;
  }
  g.stroke();
}

$('add-save').addEventListener('click', async () => {
  const name = $('add-name').value.trim();
  if (!name) { setStatus('곡 이름을 적어 주세요.'); $('add-name').focus(); return; }
  const song = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name,
    part: $('add-part').value,
    createdAt: Date.now(),
    audio: rec.blob,
    contour: rec.melody ? rec.contour : finalContour(),
    duration: rec.duration,
    takes: [],
  };
  if (rec.melody) Object.assign(song, { key: rec.melody.key, notes: rec.melody.notes });
  await saveSong(song);
  resetAddPreview();
  $('add-name').value = '';
  setStatus('');
  showView('songs');
  openPractice(song.id);
});

// ---------- Practice ----------

const practice = { song: null, buffer: null, source: null, running: false, t0: 0, samples: [], range: null, oct: 0, votes: [] };

async function renderSongList() {
  $('practice').hidden = true;
  const list = $('song-list');
  list.hidden = false;
  const songs = await listSongs();
  list.replaceChildren();
  if (!songs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '아직 곡이 없어요. "곡 추가"에서 이번 주 곡의 멜로디를 녹음하거나 파일로 불러오세요.';
    list.append(empty);
    return;
  }
  for (const s of songs) {
    const b = document.createElement('button');
    b.className = 'song';
    const left = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = s.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${s.part} · ${fmtTime(s.duration)} · 연습 ${s.takes.length}회`;
    left.append(nm, meta);
    const score = document.createElement('div');
    score.className = 'score';
    const last = s.takes[s.takes.length - 1];
    score.textContent = last ? `${Math.round(last.accuracy * 100)}%` : '–';
    b.append(left, score);
    b.addEventListener('click', () => openPractice(s.id));
    list.append(b);
  }
}

async function openPractice(id) {
  const song = await getSong(id);
  if (!song) return;
  practice.song = song;
  practice.buffer = null;
  practice.samples = [];
  practice.range = rangeOf(song.contour, true);
  practice.oct = 0;
  practice.votes = [];
  $('song-list').hidden = true;
  $('practice').hidden = false;
  $('result').hidden = true;
  $('delete-confirm').hidden = true;
  $('practice-title').textContent = song.name;
  $('practice-part').textContent = [song.part, song.key && `키 ${song.key}`, fmtTime(song.duration)].filter(Boolean).join(' · ');
  $('song-export').hidden = !song.notes;
  renderHistory();
  drawPractice(0);
  try {
    practice.buffer = await audioContext().decodeAudioData(await song.audio.arrayBuffer());
  } catch {
    practice.buffer = null; // practice still works against the target line alone
  }
}

$('practice-back').addEventListener('click', () => { stopAll(); renderSongList(); });

$('practice-start').addEventListener('click', async () => {
  if (practice.running) { stopPractice(true); return; }
  try {
    await ensureMic();
  } catch (err) {
    $('practice-cents').textContent = micError(err);
    return;
  }
  practice.samples = [];
  practice.t0 = ctx.currentTime + 0.4;
  if ($('opt-play').checked && practice.buffer) {
    const src = ctx.createBufferSource();
    src.buffer = practice.buffer;
    src.connect(ctx.destination);
    src.start(practice.t0);
    practice.source = src;
  }
  practice.running = true;
  $('result').hidden = true;
  $('practice-start').textContent = '연습 끝내기';
  tick = practiceTick;
});

function stopPractice(save) {
  tick = null;
  practice.running = false;
  if (practice.source) { try { practice.source.stop(); } catch {} practice.source = null; }
  $('practice-start').textContent = '다시 연습하기';
  if (save) showResult();
}

function practiceTick() {
  const t = ctx.currentTime - practice.t0;
  const song = practice.song;
  if (t > song.duration + 0.5) { stopPractice(true); return; }
  const fold = $('opt-fold').checked;
  const sung = t >= 0 ? readPitch() : null;

  // Allow for reaction and audio latency: accept the closest of the target
  // now or up to 0.2 s ago.
  let target = null, err = null;
  if (sung != null) {
    for (const lag of [0, 0.1, 0.2]) {
      const m = targetAt(song.contour, t - lag);
      if (m == null) continue;
      const e = centsOff(sung, m, fold);
      if (err == null || Math.abs(e) < Math.abs(err)) { err = e; target = m; }
    }
  }
  // Draw the target in the singer's octave: vote on the octave gap.
  if (fold && sung != null && target != null) {
    practice.votes.push(Math.round((sung - target) / 12));
    if (practice.votes.length > 90) practice.votes.shift();
    const counts = {};
    for (const v of practice.votes) counts[v] = (counts[v] || 0) + 1;
    practice.oct = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]);
  }
  const shown = fold && sung != null && target != null ? nearestOctave(sung, target + 12 * practice.oct) : sung;
  practice.samples.push({ t, sung: shown, target, err });

  if (sung != null) {
    $('practice-note').textContent = noteName(sung).ko;
    $('practice-cents').textContent = err != null ? centsLabel(err) : '';
    $('practice-cents').className = 'cents ' + (err == null ? '' : Math.abs(err) <= BAND ? 'good' : Math.abs(err) <= 40 ? 'warn' : 'bad');
  }
  drawPractice(t);
}

function drawPractice(t) {
  const song = practice.song;
  const { g, w, h } = prep($('practice-canvas'));
  const shift = 12 * practice.oct;
  const lo = practice.range.lo + shift, hi = practice.range.hi + shift;
  const span = 6, head = 0.35;
  const x = (s) => ((s - t) / span + head) * w;
  const y = (m) => h - 12 - ((Math.max(lo, Math.min(hi, m)) - lo) / (hi - lo)) * (h - 24);
  const yt = (m) => y(m + shift);

  // Semitone grid with note names on whole tones of C major.
  g.font = '10px ui-monospace, Menlo, monospace';
  for (let m = Math.ceil(lo); m <= hi; m++) {
    g.strokeStyle = colors.line;
    g.globalAlpha = m % 12 === 0 ? 1 : 0.5;
    g.beginPath(); g.moveTo(0, y(m)); g.lineTo(w, y(m)); g.stroke();
    g.globalAlpha = 1;
    if ([0, 2, 4, 5, 7, 9, 11].includes(((m % 12) + 12) % 12)) {
      g.fillStyle = colors.muted;
      g.fillText(noteName(m).ko, 4, y(m) - 2);
    }
  }

  g.strokeStyle = colors.target;
  g.lineWidth = 8;
  g.lineCap = 'round';
  g.globalAlpha = 0.6;
  strokeContour(g, song.contour, x, yt, t - span * head, t + span * (1 - head));
  g.globalAlpha = 1;

  g.strokeStyle = colors.ink;
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(x(t), 0); g.lineTo(x(t), h); g.stroke();

  for (const s of practice.samples) {
    if (s.sung == null || s.t < t - span * head) continue;
    g.fillStyle = s.err == null ? colors.muted : errColor(s.err);
    g.beginPath();
    g.arc(x(s.t), y(s.sung), 2.4, 0, Math.PI * 2);
    g.fill();
  }

  g.fillStyle = colors.muted;
  g.fillText(`${fmtTime(Math.max(0, t))} / ${fmtTime(song.duration)}`, w - 74, 14);
}

async function showResult() {
  const r = analyzeTake(practice.samples, TOLERANCE);
  const box = $('result');
  box.hidden = false;
  box.replaceChildren();
  if (!r) {
    box.textContent = '부른 소리가 거의 잡히지 않았어요. 마이크 가까이에서 다시 불러 보세요.';
    return;
  }
  const stats = document.createElement('div');
  stats.className = 'stats';
  const stat = (v, k, cls) => {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `<div class="v ${cls}"></div><div class="k"></div>`;
    d.firstChild.textContent = v;
    d.lastChild.textContent = k;
    stats.append(d);
  };
  const acc = Math.round(r.accuracy * 100);
  stat(`${acc}%`, `±${TOLERANCE} cent 안`, acc >= 80 ? 'good' : acc >= 60 ? 'warn' : 'bad');
  stat(r.mean == null ? '–' : `${r.mean > 0 ? '+' : ''}${Math.round(r.mean)}`, '평균 cent', r.mean == null ? '' : Math.abs(r.mean) <= 10 ? 'good' : 'warn');
  stat(r.avgDrift == null ? '–' : `${r.avgDrift > 0 ? '+' : ''}${Math.round(r.avgDrift)}`, '긴 음 처짐 cent', r.avgDrift == null || r.avgDrift > -8 ? 'good' : 'bad');
  box.append(stats);

  const tips = [];
  if (r.avgDrift != null && r.avgDrift <= -8) {
    tips.push(`긴 음을 끌 때 평균 ${-Math.round(r.avgDrift)} cent씩 처져요. 음 끝까지 호흡으로 받쳐 주고, 음이 끝날 때 살짝 위를 생각하며 불러 보세요.`);
  }
  if (r.mean <= -10) tips.push('전체적으로 조금 낮게 부르고 있어요. 음을 시작할 때 위에서 내려앉는 느낌으로 잡아 보세요.');
  if (r.mean >= 10) tips.push('전체적으로 조금 높게 부르고 있어요. 힘을 빼고 불러 보세요.');
  for (const d of r.worst) {
    tips.push(`${fmtTime(d.start)} "${noteName(d.target).ko}" 음에서 ${-Math.round(d.change)} cent 처졌어요.`);
  }
  if (r.wrongNotes > 0.3) tips.unshift(`${Math.round(r.wrongNotes * 100)}% 구간에서 다른 음을 불렀어요. 기준 녹음을 들으며 멜로디부터 익혀 보세요.`);
  if (!tips.length && acc >= 80) tips.push('음정이 안정적이에요. 다음에는 기준 녹음을 끄고 불러 보세요.');
  if (!tips.length) tips.push('목표선에 맞는 구간을 조금씩 늘려 보세요. 어려운 부분은 롱톤으로 한 음씩 연습해도 좋아요.');
  const ul = document.createElement('ul');
  ul.className = 'advice';
  for (const tip of tips) {
    const li = document.createElement('li');
    li.textContent = tip;
    ul.append(li);
  }
  box.append(ul);

  const song = practice.song;
  song.takes.push({ at: Date.now(), accuracy: r.accuracy, mean: r.mean, drift: r.avgDrift });
  await saveSong(song);
  renderHistory();
}

function renderHistory() {
  const ol = $('history');
  ol.replaceChildren();
  const takes = [...practice.song.takes].reverse().slice(0, 10);
  if (!takes.length) {
    const li = document.createElement('li');
    li.textContent = '아직 기록이 없어요.';
    ol.append(li);
    return;
  }
  for (const k of takes) {
    const li = document.createElement('li');
    const d = new Date(k.at);
    const drift = k.drift == null ? '' : ` · 처짐 ${Math.round(k.drift)}`;
    li.textContent = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} · ${Math.round(k.accuracy * 100)}%${drift}`;
    ol.append(li);
  }
}

$('song-delete').addEventListener('click', () => { $('delete-confirm').hidden = false; });
$('delete-no').addEventListener('click', () => { $('delete-confirm').hidden = true; });
$('delete-yes').addEventListener('click', async () => {
  stopAll();
  await deleteSong(practice.song.id);
  renderSongList();
});

window.addEventListener('resize', () => {
  if (!$('practice').hidden && practice.song) drawPractice(practice.running ? ctx.currentTime - practice.t0 : 0);
  drawPreview();
});

// The service worker also adds the headers that let melody extraction use
// several CPU threads. Reload once when it first takes over.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js');
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    try {
      if (!crossOriginIsolated && !sessionStorage.getItem('pp-reloaded')) {
        sessionStorage.setItem('pp-reloaded', '1');
        location.reload();
      }
    } catch {}
  });
}
drawTone();
