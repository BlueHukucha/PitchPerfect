"""Prototype: album/live recording -> lead vocal melody as exact notes.

Steps: separate vocals (MDX-Net Kim_Vocal_2, ONNX) -> pitch track (CREPE)
-> split into notes -> correct the band's tuning -> snap each note to the
song's key. Output is the melody JSON the app imports.

Usage: python extract_melody.py song.mp3 out.json [--key G] [--save-vocals v.wav]
"""
import argparse, json, subprocess
import numpy as np
import onnxruntime as ort
import torch, torchcrepe, librosa

MODEL = __file__.rsplit('/', 1)[0] + '/models/Kim_Vocal_2.onnx'
SR = 44100
N_FFT, HOP, DIM_F, DIM_T = 7680, 1024, 3072, 256
COMPENSATE = 1.009

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy()


def separate_vocals(mix):
    """MDX-Net inference over overlapping chunks; returns stereo vocals."""
    chunk = HOP * (DIM_T - 1)
    trim = N_FFT // 2
    gen = chunk - 2 * trim
    n_bins = N_FFT // 2 + 1
    window = torch.hann_window(N_FFT, periodic=True)
    sess = ort.InferenceSession(MODEL, providers=['CPUExecutionProvider'])

    n = mix.shape[1]
    pad = gen - n % gen
    padded = np.concatenate([np.zeros((2, trim)), mix, np.zeros((2, pad)), np.zeros((2, trim))], 1)
    out = []
    for i in range(0, n + pad, gen):
        x = torch.tensor(padded[:, i:i + chunk], dtype=torch.float32)
        spec = torch.stft(x, N_FFT, HOP, window=window, center=True, return_complex=True)
        spec = torch.view_as_real(spec).permute(0, 3, 1, 2).reshape(1, 4, n_bins, DIM_T)[:, :, :DIM_F]
        pred = sess.run(None, {'input': spec.numpy()})[0]
        pred = torch.cat([torch.tensor(pred), torch.zeros(1, 4, n_bins - DIM_F, DIM_T)], 2)
        pred = pred.reshape(2, 2, n_bins, DIM_T).permute(0, 2, 3, 1).contiguous()
        wave = torch.istft(torch.view_as_complex(pred), N_FFT, HOP, window=window, center=True, length=chunk)
        out.append(wave[:, trim:-trim].numpy())
    return np.concatenate(out, 1)[:, :n] * COMPENSATE


def track_pitch(vocals):
    """CREPE at 10 ms hops. Returns times, midi (nan when unvoiced)."""
    mono = librosa.resample(vocals.mean(0), orig_sr=SR, target_sr=16000)
    audio = torch.tensor(mono, dtype=torch.float32)[None]
    f0, per = torchcrepe.predict(audio, 16000, 160, 65, 1100, 'full', batch_size=512,
                                 return_periodicity=True, decoder=torchcrepe.decode.viterbi)
    per = torchcrepe.filter.median(per, 3)
    f0 = f0[0].numpy(); per = per[0].numpy()
    rms = librosa.feature.rms(y=mono, frame_length=1024, hop_length=160, center=True)[0][:len(f0)]
    voiced = (per > 0.45) & (rms > 0.01)
    midi = np.where(voiced, 69 + 12 * np.log2(np.maximum(f0, 1) / 440), np.nan)
    return np.arange(len(midi)) * 0.01, midi


def split_notes(times, midi, jump=0.6, hold=6, min_len=0.08):
    """Cut the contour where it leaves the current note for 60 ms or goes silent."""
    notes, cur, away = [], [], 0
    def close():
        if cur and times[cur[-1]] - times[cur[0]] >= min_len:
            vals = midi[cur]
            k = len(vals)
            core = vals[int(k * 0.2):max(int(k * 0.8), int(k * 0.2) + 1)]
            notes.append(dict(start=float(times[cur[0]]), end=float(times[cur[-1]] + 0.01),
                              pitch=float(np.median(core))))
    for i, m in enumerate(midi):
        if np.isnan(m):
            close(); cur, away = [], 0; continue
        if cur and abs(m - np.median(midi[cur[-15:]])) > jump:
            away += 1
            if away >= hold:
                start = cur[-away + 1:] if away > 1 else []
                cur = cur[:len(cur) - (away - 1)]
                close(); cur, away = start, 0
        else:
            away = 0
        cur.append(i)
    close()
    return notes


def band_tuning(mix, vocals):
    """Tuning of the accompaniment in cents (bands are steadier than live singers)."""
    inst = (mix - vocals).mean(0)
    return 100 * float(librosa.estimate_tuning(y=inst, sr=SR, bins_per_octave=12))


def detect_key(notes):
    hist = np.zeros(12)
    for n in notes:
        hist[int(round(n['pitch'])) % 12] += n['end'] - n['start']
    scores = [np.corrcoef(np.roll(MAJOR_PROFILE, k), hist)[0, 1] for k in range(12)]
    return int(np.argmax(scores))


def snap(pitch, tonic):
    """Nearest note of the major key within 80 cents, else nearest semitone."""
    scale = [s for s in range(int(pitch) - 2, int(pitch) + 3) if (s - tonic) % 12 in MAJOR_STEPS]
    best = min(scale, key=lambda s: abs(s - pitch))
    return best if abs(best - pitch) <= 0.8 else int(round(pitch))


def extract(path, key=None, save_vocals=None):
    mix = load(path)
    vocals = separate_vocals(mix)
    if save_vocals:
        import soundfile as sf
        sf.write(save_vocals, vocals.T, SR)
    times, midi = track_pitch(vocals)
    tuning = band_tuning(mix, vocals)
    midi = midi - tuning / 100
    notes = split_notes(times, midi)
    tonic = NAMES.index(key) if key else detect_key(notes)
    out = []
    for n in notes:
        target = snap(n['pitch'], tonic)
        out.append(dict(start=round(n['start'], 2), end=round(n['end'], 2), midi=target,
                        sungCents=round((n['pitch'] - target) * 100)))
    # Merge neighbours that snapped to the same note with a tiny gap (vibrato cuts).
    merged = []
    for n in out:
        if merged and merged[-1]['midi'] == n['midi'] and n['start'] - merged[-1]['end'] < 0.06:
            merged[-1]['end'] = n['end']
        else:
            merged.append(n)
    contour = [[round(float(t), 2), None if np.isnan(m) else round(float(m), 2)] for t, m in zip(times[::2], midi[::2])]
    return dict(version=1, key=NAMES[tonic], tuningCents=round(tuning), notes=merged, sungContour=contour)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('input'); ap.add_argument('output')
    ap.add_argument('--key', choices=NAMES)
    ap.add_argument('--save-vocals')
    a = ap.parse_args()
    res = extract(a.input, a.key, a.save_vocals)
    json.dump(res, open(a.output, 'w'), ensure_ascii=False)
    print(f"key {res['key']}, band tuning {res['tuningCents']:+d} cents, {len(res['notes'])} notes")
