/**
 * WAV encoding. 44-byte canonical RIFF header plus interleaved PCM.
 *
 * Written by hand rather than pulled from a library, so the byte layout is
 * identical in Node and in the browser and the determinism test can compare
 * whole files rather than decoded samples.
 */

import type { Stereo } from "../core/buffer.ts";

export type BitDepth = 16 | 24;

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** Rounds to the nearest integer, ties away from zero, then clamps. */
function quantise(x: number, scale: number, max: number): number {
  let v = x * scale;
  v = v < 0 ? -Math.round(-v) : Math.round(v);
  if (v > max) v = max;
  if (v < -max - 1) v = -max - 1;
  return v;
}

export function encodeWav(buf: Stereo, bitDepth: BitDepth = 16): Uint8Array {
  const channels = 2;
  const bytesPerSample = bitDepth / 8;
  const dataBytes = buf.length * channels * bytesPerSample;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  const { L, R } = buf;
  let o = 44;
  if (bitDepth === 16) {
    for (let i = 0; i < buf.length; i++) {
      view.setInt16(o, quantise(L[i], 32767, 32767), true);
      view.setInt16(o + 2, quantise(R[i], 32767, 32767), true);
      o += 4;
    }
  } else {
    for (let i = 0; i < buf.length; i++) {
      const l = quantise(L[i], 8388607, 8388607);
      const r = quantise(R[i], 8388607, 8388607);
      out[o] = l & 0xff;
      out[o + 1] = (l >> 8) & 0xff;
      out[o + 2] = (l >> 16) & 0xff;
      out[o + 3] = r & 0xff;
      out[o + 4] = (r >> 8) & 0xff;
      out[o + 5] = (r >> 16) & 0xff;
      o += 6;
    }
  }
  return out;
}

/** Mono variant, for stems that are genuinely mono. */
export function encodeWavMono(
  data: Float32Array,
  sampleRate: number,
  bitDepth: BitDepth = 16,
): Uint8Array {
  const bytesPerSample = bitDepth / 8;
  const dataBytes = data.length * bytesPerSample;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < data.length; i++) {
    view.setInt16(o, quantise(data[i], 32767, 32767), true);
    o += 2;
  }
  return out;
}

/** Minimal parser, used by the tests to read golden files back. */
export function decodeWav(bytes: Uint8Array): Stereo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const frames = dataBytes / (channels * (bits / 8));
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    if (bits === 16) {
      L[i] = view.getInt16(o, true) / 32767;
      R[i] = channels === 2 ? view.getInt16(o + 2, true) / 32767 : L[i];
      o += channels * 2;
    } else {
      const l = (view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16));
      L[i] = l / 8388607;
      if (channels === 2) {
        const r = (view.getUint8(o + 3) | (view.getUint8(o + 4) << 8) | (view.getInt8(o + 5) << 16));
        R[i] = r / 8388607;
      } else R[i] = L[i];
      o += channels * 3;
    }
  }
  return { L, R, length: frames, sampleRate };
}
