// Runs melody extraction off the main thread. Receives 44.1 kHz stereo PCM,
// posts progress messages and finally the melody.
import * as ort from './vendor/ort.wasm.min.mjs';
import { extractMelody } from './extract.js';

ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

const MODELS = { mdx: 'models/Kim_Vocal_2.onnx', crepe: 'models/crepe-tiny.onnx' };
const CACHE = 'pp-models-v1';

// Download a model once and keep it in the Cache API for next time.
async function loadModel(path, onProgress) {
  const url = new URL('./' + path, import.meta.url).href;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok) throw new Error('model download failed: ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  const bytes = new Uint8Array(got);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  await cache.put(url, new Response(bytes));
  return bytes;
}

// WebAssembly on the CPU, multithreaded when the page is cross-origin
// isolated. WebGPU is left for later: it hung on some machines in testing.
async function session(bytes) {
  const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  s.Tensor = ort.Tensor;
  s.backend = 'wasm';
  return s;
}

self.onmessage = async ({ data }) => {
  const post = (msg) => self.postMessage(msg);
  try {
    const mdxBytes = await loadModel(MODELS.mdx, (f) => post({ type: 'progress', stage: 'download', frac: f }));
    const crepeBytes = await loadModel(MODELS.crepe, () => {});
    post({ type: 'progress', stage: 'prepare', frac: 0 });
    const sessions = { mdx: await session(mdxBytes), crepe: await session(crepeBytes) };
    post({ type: 'backend', backend: sessions.mdx.backend, threads: ort.env.wasm.numThreads });
    const melody = await extractMelody(data.left, data.right, sessions,
      (stage, frac) => post({ type: 'progress', stage, frac }), data.key || null);
    post({ type: 'done', melody });
  } catch (err) {
    post({ type: 'error', message: String(err && err.message || err) });
  }
};
