/** Test-only FFT and spectral helpers. Not part of the engine. */

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * cr - im[i + k + half] * ci;
        const vi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Magnitude spectrum in dB, Blackman-Harris windowed. */
export function spectrumDb(buf: Float32Array | Float64Array): Float64Array {
  let n = 1;
  while (n * 2 <= buf.length) n *= 2;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w =
      0.35875 -
      0.48829 * Math.cos((2 * Math.PI * i) / (n - 1)) +
      0.14128 * Math.cos((4 * Math.PI * i) / (n - 1)) -
      0.01168 * Math.cos((6 * Math.PI * i) / (n - 1));
    re[i] = buf[i] * w;
  }
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    mag[k] = 20 * Math.log10(Math.sqrt(re[k] * re[k] + im[k] * im[k]) / ((n * 0.35875) / 2) + 1e-14);
  }
  return mag;
}

/** Worst non-harmonic peak relative to the fundamental, in dB. */
export function harmonicSnr(buf: Float32Array, fundamentalHz: number, sampleRate: number): number {
  const mag = spectrumDb(buf);
  const binHz = sampleRate / (mag.length * 2);
  let fund = -200;
  let worst = -200;
  for (let k = 3; k < mag.length; k++) {
    const hz = k * binHz;
    const ratio = hz / fundamentalHz;
    const near = Math.abs(ratio - Math.round(ratio));
    if (Math.abs(hz - fundamentalHz) < 3 * binHz) fund = Math.max(fund, mag[k]);
    // a bin is "harmonic" if it is within 5 % of an integer multiple
    if (near > 0.05 && hz > 80 && mag[k] > worst) worst = mag[k];
  }
  return fund - worst;
}
