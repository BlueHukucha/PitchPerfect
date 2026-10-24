// Complex FFT for the two sizes the melody extractor needs:
// powers of two (radix-2) and 7680 = 15 x 512 (one Cooley-Tukey split).

export function radix2(n) {
  const levels = Math.log2(n);
  if (levels % 1) throw new Error('size must be a power of two');
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  // In-place forward transform of (re, im).
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

// Forward FFT of size n1 * n2 where n2 is a power of two and n1 is small.
// X[k1 + n1*k2] = sum_n2 W_n2^(n2 k2) W_N^(n2 k1) sum_n1 x[n2_size*n1 + n2] W_n1^(n1 k1)
export function mixed(n1, n2) {
  const n = n1 * n2;
  const fft2 = radix2(n2);
  const dc = new Float64Array(n1 * n1), ds = new Float64Array(n1 * n1);
  for (let a = 0; a < n1; a++) for (let b = 0; b < n1; b++) {
    dc[a * n1 + b] = Math.cos((2 * Math.PI * a * b) / n1);
    ds[a * n1 + b] = -Math.sin((2 * Math.PI * a * b) / n1);
  }
  const tc = new Float64Array(n), ts = new Float64Array(n);
  for (let k1 = 0; k1 < n1; k1++) for (let j = 0; j < n2; j++) {
    tc[k1 * n2 + j] = Math.cos((2 * Math.PI * j * k1) / n);
    ts[k1 * n2 + j] = -Math.sin((2 * Math.PI * j * k1) / n);
  }
  const rowRe = new Float64Array(n), rowIm = new Float64Array(n);
  const bufRe = new Float64Array(n2), bufIm = new Float64Array(n2);

  return function fft(re, im, outRe, outIm) {
    // Small DFTs over n1 for each n2, then twiddle; rows indexed by k1.
    for (let j = 0; j < n2; j++) {
      for (let k1 = 0; k1 < n1; k1++) {
        let sr = 0, si = 0;
        for (let a = 0; a < n1; a++) {
          const xr = re[n2 * a + j], xi = im[n2 * a + j];
          const c = dc[k1 * n1 + a], s = ds[k1 * n1 + a];
          sr += xr * c - xi * s;
          si += xr * s + xi * c;
        }
        const c = tc[k1 * n2 + j], s = ts[k1 * n2 + j];
        rowRe[k1 * n2 + j] = sr * c - si * s;
        rowIm[k1 * n2 + j] = sr * s + si * c;
      }
    }
    for (let k1 = 0; k1 < n1; k1++) {
      bufRe.set(rowRe.subarray(k1 * n2, (k1 + 1) * n2));
      bufIm.set(rowIm.subarray(k1 * n2, (k1 + 1) * n2));
      fft2(bufRe, bufIm);
      for (let k2 = 0; k2 < n2; k2++) {
        outRe[k1 + n1 * k2] = bufRe[k2];
        outIm[k1 + n1 * k2] = bufIm[k2];
      }
    }
  };
}
