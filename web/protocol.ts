/**
 * Worker protocol.
 *
 * Audio crosses the boundary as transferable ArrayBuffers, one bar at a time.
 * SharedArrayBuffer would need COOP and COEP response headers, which GitHub
 * Pages cannot set, so the design assumes transfer from the start rather than
 * discovering it late.
 */

export interface PlanInfo {
  seed: string;
  tempo: number;
  key: string;
  scale: string;
  arrangement: string;
  bars: number;
  totalSamples: number;
  sampleRate: number;
  chunkSize: number;
  sections: { name: string; startSample: number; endSample: number }[];
  buses: string[];
}

export interface RenderStatsInfo {
  peakDb: number;
  rmsDb: number;
  busPeaks: Record<string, number>;
}

export type ToWorker =
  | {
      type: "render";
      gen: number;
      seed: string;
      sampleRate: number;
      words: Record<string, number>;
      locks: Record<string, string>;
    }
  | {
      type: "stems";
      gen: number;
      seed: string;
      sampleRate: number;
      words: Record<string, number>;
      locks: Record<string, string>;
    }
  | { type: "cancel"; gen: number };

export type FromWorker =
  | { type: "ready" }
  | { type: "plan"; gen: number; info: PlanInfo }
  | {
      type: "chunk";
      gen: number;
      index: number;
      start: number;
      count: number;
      left: ArrayBuffer;
      right: ArrayBuffer;
      peaks: ArrayBuffer;
    }
  | { type: "done"; gen: number; stats: RenderStatsInfo }
  | { type: "stem"; gen: number; bus: string; index: number; total: number; wav: ArrayBuffer }
  | { type: "stemsDone"; gen: number }
  | { type: "error"; gen: number; message: string };

/** Peak buckets drawn per bar of the waveform. */
export const PEAKS_PER_CHUNK = 16;
