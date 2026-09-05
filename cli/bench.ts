/**
 * Performance measurement against section 9's budget.
 *
 *   npm run bench
 *   npm run bench -- --runs 5 --seed 42
 */

import { getPreset } from "../presets/index.ts";
import { renderTrack } from "../render/track.ts";
import { num, parseArgs, str } from "./args.ts";

const args = parseArgs(process.argv.slice(2));
const runs = Math.max(1, Math.round(num(args, "runs", 3)));
const seed = str(args, "seed", "42");
const { preset, ranges } = getPreset("hyperpop");

// warm the JIT so the first run does not dominate
renderTrack({ seed, preset, ranges, sampleRate: 44100 });

const times: number[] = [];
let duration = 0;
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  const r = renderTrack({ seed: `${seed}-${i}`, preset, ranges, sampleRate: 44100 });
  times.push((performance.now() - t) / 1000);
  duration = r.stats.durationSeconds;
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
const best = times[0];

console.log(`nullsample bench  ${runs} runs, ${duration.toFixed(1)} s of audio each`);
console.log(`  best   ${best.toFixed(2)} s   (${(duration / best).toFixed(1)}x realtime)`);
console.log(`  median ${median.toFixed(2)} s   (${(duration / median).toFixed(1)}x realtime)`);
console.log(`  all    ${times.map((t) => t.toFixed(2)).join("  ")}`);
console.log("");
console.log(`  section 9 budget: under 1.5 s on a laptop, under 5 s on a mid-range phone`);
const ratio = median / 1.5;
if (median <= 1.5) {
  console.log(`  WITHIN BUDGET`);
} else {
  console.log(`  OVER BUDGET by ${ratio.toFixed(1)}x on this machine`);
}
