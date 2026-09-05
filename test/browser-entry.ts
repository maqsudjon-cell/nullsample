/**
 * Entry point for the headless-browser determinism check. Bundled by
 * test/browser-determinism.mjs and evaluated in the page.
 */

import { getPreset } from "../presets/index.ts";
import { renderTrack } from "../render/track.ts";
import { encodeWav } from "../render/wav.ts";

declare global {
  interface Window {
    nullsampleRender: (seed: string, sampleRate: number) => Promise<{
      sha256: string;
      bytes: number;
      tempo: number;
      bars: number;
      peakDb: number;
      rmsDb: number;
    }>;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

window.nullsampleRender = async (seed: string, sampleRate: number) => {
  const { preset, ranges } = getPreset("hyperpop");
  const r = renderTrack({ seed, preset, ranges, sampleRate });
  const bytes = encodeWav(r.audio, 16);
  return {
    sha256: await sha256(bytes),
    bytes: bytes.length,
    tempo: r.plan.tempo,
    bars: r.plan.bars,
    peakDb: Number(r.stats.peakDb.toFixed(4)),
    rmsDb: Number(r.stats.rmsDb.toFixed(4)),
  };
};
