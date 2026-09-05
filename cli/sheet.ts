/**
 * Contact sheet builder.
 *
 *   npm run sheet -- ./batch
 *
 * Writes sheet.html INTO the batch directory, so the audio elements resolve
 * against sibling files and the page works when opened directly from disk.
 * No server, no build step, no network request - a page that needs any of
 * those is a page that will not get used.
 *
 * Ratings autosave to localStorage as you go and are exported with one key
 * press; `narrow` reads the exported ratings.json from the same directory.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args.ts";
import type { BatchIndex } from "./batch.ts";

const args = parseArgs(process.argv.slice(2));
const dir = args.positional[0] ?? "./batch";
const index: BatchIndex = JSON.parse(readFileSync(join(dir, "batch.json"), "utf8"));

/** Parameters worth showing next to each track while rating. */
const HEADLINE = [
  "tempo",
  "lead.distDrive",
  "lead.filterHz",
  "bass.drive",
  "bass.decay",
  "duck.depth",
  "drums.rollChance",
  "master.inputDb",
];

const rows = index.records.map((r, i) => ({
  i: i + 1,
  seed: r.seed,
  file: r.file,
  key: `${r.key} ${r.scale.replace(/([A-Z])/g, " $1").toLowerCase().trim()}`,
  arrangement: r.arrangement,
  tempo: Math.round(r.tempo),
  bars: r.bars,
  dur: r.durationSeconds,
  rms: r.rmsDb,
  headline: HEADLINE.map((k) => [k, r.params[k]] as const).filter(([, v]) => v !== undefined),
}));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nullsample &mdash; ${index.preset} contact sheet</title>
<style>
  :root {
    --void: #08090C; --panel: #101317; --line: #1E232B;
    --dim: #8A939F; --text: #E4E7EB; --flare: #FF6A1A;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--void); color: var(--text);
    font: 13px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  header {
    position: sticky; top: 0; z-index: 5; background: var(--void);
    border-bottom: 1px solid var(--line); padding: 14px 20px;
    display: flex; gap: 20px; align-items: baseline; flex-wrap: wrap;
  }
  h1 { font-size: 13px; font-weight: 500; margin: 0; letter-spacing: 0.02em; }
  .dim { color: var(--dim); }
  .count { color: var(--flare); }
  button {
    font: inherit; background: var(--panel); color: var(--text);
    border: 1px solid var(--line); padding: 5px 11px; cursor: pointer;
  }
  button:hover { border-color: var(--dim); }
  button:focus-visible { outline: 2px solid var(--flare); outline-offset: 1px; }
  main { padding: 8px 20px 120px; }
  .row {
    display: grid; grid-template-columns: 44px 1fr 210px 150px;
    gap: 14px; align-items: center;
    padding: 9px 10px; border-bottom: 1px solid var(--line);
  }
  .row.cur { background: var(--panel); }
  .n { color: var(--dim); text-align: right; }
  .row.rated .n { color: var(--flare); }
  .meta { display: flex; gap: 14px; flex-wrap: wrap; align-items: baseline; }
  .meta b { font-weight: 500; }
  .params { color: var(--dim); font-size: 11px; }
  audio { width: 100%; height: 30px; }
  .rate { display: flex; gap: 4px; }
  .rate button { width: 26px; padding: 4px 0; text-align: center; }
  .rate button[aria-pressed="true"] { background: var(--flare); color: var(--void); border-color: var(--flare); }
  footer {
    position: fixed; bottom: 0; left: 0; right: 0; background: var(--panel);
    border-top: 1px solid var(--line); padding: 10px 20px;
    display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  }
  .hist { display: flex; gap: 3px; align-items: flex-end; height: 22px; }
  .hist i { display: block; width: 16px; background: var(--flare); min-height: 2px; }
  .hist span { color: var(--dim); font-size: 11px; }
  kbd { border: 1px solid var(--line); padding: 0 4px; color: var(--dim); }
</style>
</head>
<body>
<header>
  <h1>NULLSAMPLE <span class="dim">/ ${index.preset} contact sheet</span></h1>
  <span class="dim">ranges v${index.rangesVersion}</span>
  <span class="dim"><span class="count" id="done">0</span> of ${rows.length} rated</span>
  <span class="dim"><kbd>1</kbd>&ndash;<kbd>5</kbd> rate &middot; <kbd>space</kbd> play &middot; <kbd>j</kbd>/<kbd>k</kbd> move</span>
</header>
<main id="list"></main>
<footer>
  <button id="save">Save ratings.json</button>
  <button id="clear">Clear</button>
  <div class="hist" id="hist"></div>
  <span class="dim" id="status">move the downloaded file into <b>${dir}</b> then run: npm run narrow -- ${dir}</span>
</footer>
<script>
const ROWS = ${JSON.stringify(rows)};
const KEY = "nullsample:ratings:${index.preset}:${index.createdBySeedBase}";
let ratings = {};
try { ratings = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { ratings = {}; }
let cur = 0;

const list = document.getElementById("list");
list.innerHTML = ROWS.map(function (r) {
  const params = r.headline.map(function (p) {
    const v = p[1];
    return p[0].replace(/^[a-z0-9]+\\./, "") + " " + (Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(2));
  }).join("  ");
  return '<div class="row" id="row' + r.i + '" data-i="' + r.i + '">' +
    '<div class="n">' + String(r.i).padStart(3, "0") + '</div>' +
    '<div><div class="meta"><b>' + r.key + '</b><span class="dim">' + r.tempo + ' BPM</span>' +
      '<span class="dim">' + r.arrangement + '</span><span class="dim">' + r.bars + ' bars</span>' +
      '<span class="dim">' + r.dur.toFixed(0) + 's</span><span class="dim">rms ' + r.rms.toFixed(1) + '</span></div>' +
      '<div class="params">' + params + '</div></div>' +
    '<div><audio preload="none" controls src="./' + r.file + '"></audio></div>' +
    '<div class="rate" role="group" aria-label="rating for track ' + r.i + '">' +
      [1,2,3,4,5].map(function (n) {
        return '<button type="button" data-rate="' + n + '" aria-pressed="false" aria-label="rate ' + n + ' of 5">' + n + '</button>';
      }).join("") + '</div></div>';
}).join("");

function paint() {
  let done = 0;
  const counts = [0,0,0,0,0];
  ROWS.forEach(function (r) {
    const el = document.getElementById("row" + r.i);
    const v = ratings[r.seed];
    el.classList.toggle("rated", !!v);
    el.classList.toggle("cur", r.i - 1 === cur);
    el.querySelectorAll("[data-rate]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === v));
    });
    if (v) { done++; counts[v - 1]++; }
  });
  document.getElementById("done").textContent = String(done);
  const max = Math.max(1, Math.max.apply(null, counts));
  document.getElementById("hist").innerHTML = counts.map(function (c, i) {
    return '<i style="height:' + Math.round(2 + (c / max) * 20) + 'px" title="' + (i+1) + ': ' + c + '"></i>';
  }).join("") + '<span>1&ndash;5</span>';
}

function rate(i, n) {
  const r = ROWS[i];
  if (!r) return;
  if (ratings[r.seed] === n) delete ratings[r.seed]; else ratings[r.seed] = n;
  try { localStorage.setItem(KEY, JSON.stringify(ratings)); } catch (e) {}
  paint();
}

list.addEventListener("click", function (e) {
  const b = e.target.closest("[data-rate]");
  if (!b) return;
  const row = b.closest(".row");
  cur = Number(row.dataset.i) - 1;
  rate(cur, Number(b.dataset.rate));
});

document.addEventListener("keydown", function (e) {
  if (e.target.tagName === "INPUT") return;
  if (e.key >= "1" && e.key <= "5") { rate(cur, Number(e.key)); e.preventDefault(); return; }
  if (e.key === "j" || e.key === "ArrowDown") { cur = Math.min(ROWS.length - 1, cur + 1); paint(); scroll(); e.preventDefault(); }
  if (e.key === "k" || e.key === "ArrowUp") { cur = Math.max(0, cur - 1); paint(); scroll(); e.preventDefault(); }
  if (e.key === " ") {
    const a = document.getElementById("row" + (cur + 1)).querySelector("audio");
    document.querySelectorAll("audio").forEach(function (o) { if (o !== a) o.pause(); });
    if (a.paused) a.play(); else a.pause();
    e.preventDefault();
  }
});
function scroll() {
  const el = document.getElementById("row" + (cur + 1));
  if (el) el.scrollIntoView({ block: "center" });
}

document.getElementById("save").addEventListener("click", function () {
  const payload = { preset: "${index.preset}", rangesVersion: ${index.rangesVersion}, ratings: ratings };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ratings.json";
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
});
document.getElementById("clear").addEventListener("click", function () {
  if (!confirm("Clear all ratings?")) return;
  ratings = {};
  try { localStorage.removeItem(KEY); } catch (e) {}
  paint();
});
paint();
</script>
</body>
</html>`;

const outPath = join(dir, "sheet.html");
writeFileSync(outPath, html);
console.log(`${outPath}`);
console.log(`  ${rows.length} tracks, ranges v${index.rangesVersion}`);
console.log(`\nopen it directly (no server needed), rate, then Save ratings.json`);
console.log(`move that file into ${dir} and run:  npm run narrow -- ${dir}`);
