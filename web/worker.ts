/**
 * The engine worker.
 *
 * Renders one bar at a time and posts each as it is finished, so the main
 * thread can start playing before the track is complete. It yields to the
 * event loop between bars, which is the only way a worker can notice a cancel
 * message: a synchronous render loop would never drain its own queue.
 */

import { BUS_NAMES } from "../compose/arrange.ts";
import { getPreset } from "../presets/index.ts";
import { TrackRenderer, renderStem } from "../render/track.ts";
import { encodeWav } from "../render/wav.ts";
import { PEAKS_PER_CHUNK, type FromWorker, type PlanInfo, type ToWorker } from "./protocol.ts";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let currentGen = -1;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

const yieldToQueue = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Peak AND rms envelope for one chunk.
 *
 * Peak alone draws a solid block on a track this heavily limited, which hides
 * the arrangement. Peak as an outline with rms filled inside it is the reading
 * a DAW gives you, and it makes the drops and breaks visible at a glance.
 * Interleaved as [peak, rms] per bucket.
 */
function peaksOf(L: Float32Array, R: Float32Array, count: number, buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  const step = count / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * step);
    const to = b === buckets - 1 ? count : Math.floor((b + 1) * step);
    let p = 0;
    let sum = 0;
    for (let i = from; i < to; i++) {
      const a = (L[i] + R[i]) * 0.5;
      const m = a < 0 ? -a : a;
      if (m > p) p = m;
      sum += a * a;
    }
    out[b * 2] = p;
    out[b * 2 + 1] = Math.sqrt(sum / Math.max(1, to - from));
  }
  return out;
}

async function render(msg: Extract<ToWorker, { type: "render" }>): Promise<void> {
  const { preset, ranges } = getPreset("hyperpop");
  const renderer = new TrackRenderer({
    seed: msg.seed,
    preset,
    ranges,
    sampleRate: msg.sampleRate,
    words: msg.words,
    locks: msg.locks as never,
  });
  const plan = renderer.plan;

  const info: PlanInfo = {
    seed: plan.seed,
    tempo: plan.tempo,
    key: NOTE_NAMES[plan.harmony.tonicMidi % 12],
    scale: plan.harmony.scaleName,
    arrangement: plan.arrangement.templateName,
    bars: plan.bars,
    totalSamples: renderer.totalSamples,
    sampleRate: msg.sampleRate,
    chunkSize: renderer.chunkSize,
    sections: plan.arrangement.sections.map((s) => ({
      name: s.name,
      startSample: s.startBar * plan.samplesPerBar,
      endSample: (s.startBar + s.bars) * plan.samplesPerBar,
      buses: [...s.buses],
    })),
    buses: [...preset.buses],
  };
  post({ type: "plan", gen: msg.gen, info });

  const chunk = renderer.chunkSize;
  const L = new Float32Array(chunk);
  const R = new Float32Array(chunk);
  let index = 0;

  while (!renderer.done) {
    if (currentGen !== msg.gen) return;
    const start = renderer.position;
    const count = renderer.next(L, R);
    if (count === 0) break;

    // fresh copies, because the renderer reuses its own buffers
    const left = L.slice(0, count);
    const right = R.slice(0, count);
    const peaks = peaksOf(L, R, count, PEAKS_PER_CHUNK);
    // slice() on a Float32Array always yields a plain ArrayBuffer, never a
    // SharedArrayBuffer; the cast tells the compiler what the runtime knows.
    const lb = left.buffer as ArrayBuffer;
    const rb = right.buffer as ArrayBuffer;
    const pb = peaks.buffer as ArrayBuffer;
    post(
      {
        type: "chunk",
        gen: msg.gen,
        index,
        start,
        count,
        left: lb,
        right: rb,
        peaks: pb,
      },
      [lb, rb, pb],
    );
    index++;
    await yieldToQueue();
  }

  if (currentGen !== msg.gen) return;
  post({
    type: "done",
    gen: msg.gen,
    stats: { peakDb: 0, rmsDb: 0, busPeaks: { ...renderer.busPeaks } },
  });
}

async function stems(msg: Extract<ToWorker, { type: "stems" }>): Promise<void> {
  const { preset, ranges } = getPreset("hyperpop");
  const total = BUS_NAMES.length;
  for (let i = 0; i < total; i++) {
    if (currentGen !== msg.gen) return;
    const bus = BUS_NAMES[i];
    const result = renderStem(
      {
        seed: msg.seed,
        preset,
        ranges,
        sampleRate: msg.sampleRate,
        words: msg.words,
        locks: msg.locks as never,
      },
      bus,
    );
    const wav = encodeWav(result.audio, 16);
    const buf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    post({ type: "stem", gen: msg.gen, bus, index: i, total, wav: buf }, [buf]);
    await yieldToQueue();
  }
  if (currentGen === msg.gen) post({ type: "stemsDone", gen: msg.gen });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    currentGen = msg.gen;
    return;
  }
  currentGen = msg.gen;
  const run = msg.type === "render" ? render(msg) : stems(msg);
  run.catch((err: unknown) => {
    post({
      type: "error",
      gen: msg.gen,
      message: err instanceof Error ? err.message : String(err),
    });
  });
};

post({ type: "ready" });
