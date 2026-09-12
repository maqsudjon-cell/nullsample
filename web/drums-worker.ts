/**
 * The /drums worker. Renders loops, one-shots and MIDI off the main thread.
 *
 * A loop is short enough to render whole - 250 ms for four bars, 1.4 s for
 * the longest at 80 BPM on a laptop - so there is no progressive path here.
 * The finished loop plays through a looping AudioBufferSourceNode, which Web
 * Audio loops sample-accurately, and the renderer already made it seamless.
 */

import { getPreset } from "../presets/index.ts";
import {
  DRUM_VOICES, drumLoopToMidi, renderDrumLoop, renderOneShots,
  type DrumGroup, type DrumLoopOptions,
} from "../render/drumloop.ts";
import { encodeWav } from "../render/wav.ts";
import { makeZip } from "../render/zip.ts";

export interface DrumRequest {
  gen: number;
  seed: string;
  bpm: number;
  bars: 4 | 8 | 16;
  words: { harder: number; busier: number; dirtier: number };
  keepKit: Partial<Record<DrumGroup, string>>;
  keepPattern?: string;
}

export type ToDrumWorker =
  | ({ type: "loop"; only?: DrumGroup } & DrumRequest)
  | ({ type: "export"; what: "wav" | "oneshots" | "midi" } & DrumRequest);

export type FromDrumWorker =
  | {
      type: "loop"; gen: number; only?: DrumGroup;
      left: ArrayBuffer; right: ArrayBuffer; sampleRate: number; hits: number; ms: number;
      /** where each voice first lands, as a fraction of the loop */
      firstHit: Record<string, number>;
    }
  | { type: "export"; gen: number; what: "wav" | "oneshots" | "midi"; bytes: ArrayBuffer; name: string }
  | { type: "error"; gen: number; message: string };

const post = (m: FromDrumWorker, t: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(m, t);

function options(r: DrumRequest, only?: DrumGroup): DrumLoopOptions {
  const { preset, ranges } = getPreset("hyperpop");
  return {
    seed: r.seed, preset, ranges, bpm: r.bpm, bars: r.bars, words: r.words,
    keepKit: r.keepKit, keepPattern: r.keepPattern, only,
  };
}

self.onmessage = (e: MessageEvent<ToDrumWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === "loop") {
      const t0 = performance.now();
      const loop = renderDrumLoop(options(msg, msg.only));
      const left = loop.audio.L.slice().buffer as ArrayBuffer;
      const right = loop.audio.R.slice().buffer as ArrayBuffer;
      const steps = loop.bars * 16;
      const firstHit: Record<string, number> = {};
      for (const h of loop.hits) {
        if (firstHit[h.voice] === undefined) firstHit[h.voice] = h.step / steps;
      }
      post(
        {
          type: "loop", gen: msg.gen, only: msg.only, left, right,
          sampleRate: loop.audio.sampleRate, hits: loop.hits.length,
          ms: performance.now() - t0, firstHit,
        },
        [left, right],
      );
      return;
    }
    // Exports never take `only`. A download is always the whole loop, the whole
    // kit and the whole pattern - solo is an audition aid and stops at the
    // speakers.
    const base = `nullsample-drums-${msg.seed}-${msg.bpm}bpm-${msg.bars}bars`;
    if (msg.what === "wav") {
      const loop = renderDrumLoop(options(msg));
      const bytes = encodeWav(loop.audio, 16);
      post({ type: "export", gen: msg.gen, what: "wav", bytes: bytes.buffer as ArrayBuffer, name: `${base}.wav` }, [bytes.buffer as ArrayBuffer]);
    } else if (msg.what === "midi") {
      const loop = renderDrumLoop(options(msg));
      const bytes = drumLoopToMidi(loop);
      post({ type: "export", gen: msg.gen, what: "midi", bytes: bytes.buffer as ArrayBuffer, name: `${base}.mid` }, [bytes.buffer as ArrayBuffer]);
    } else {
      const shots = renderOneShots(options(msg));
      const loop = renderDrumLoop(options(msg));
      const names: Record<string, string> = {
        kick: "kick", snare: "snare", clap: "clap", hatClosed: "hat-closed",
        hatOpen: "hat-open", rim: "rim", tom: "tom",
      };
      const entries = DRUM_VOICES.map((v) => ({
        name: `${base}/one-shots/${names[v]}.wav`,
        data: encodeWav(shots[v], 16),
      }));
      entries.push({ name: `${base}/loop.wav`, data: encodeWav(loop.audio, 16) });
      entries.push({ name: `${base}/pattern.mid`, data: drumLoopToMidi(loop) });
      const zip = makeZip(entries);
      post({ type: "export", gen: msg.gen, what: "oneshots", bytes: zip.buffer as ArrayBuffer, name: `${base}.zip` }, [zip.buffer as ArrayBuffer]);
    }
  } catch (err) {
    post({ type: "error", gen: msg.gen, message: err instanceof Error ? err.message : String(err) });
  }
};

export {};
