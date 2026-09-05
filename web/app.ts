/**
 * Nullsample web app.
 *
 * Audio is rendered on this device, one bar at a time, in a worker. Playback
 * starts once a few bars are buffered and the rest renders ahead of the
 * playhead. Because the master chain streams, the audio that plays and the
 * audio in the downloaded file are the same bytes.
 *
 * Web Audio is used for exactly one job: playing back Float32Arrays the engine
 * has already produced. No node graph does any rendering - browsers implement
 * those nodes differently, and the same seed would stop meaning the same track.
 */

import { encodeWav } from "../render/wav.ts";
import { makeZip, type ZipEntry } from "../render/zip.ts";
import { PEAKS_PER_CHUNK, type FromWorker, type PlanInfo } from "./protocol.ts";

// --------------------------------------------------------------- constants -

const SAMPLE_RATE = 44100;
/** How much audio must exist before playback starts. */
const PREBUFFER_SECONDS = 3.5;
/** Below this much audio ahead of the playhead, we are underrunning. */
const UNDERRUN_MARGIN = 0.12;
const BUS_LABELS: Record<string, string> = {
  drums: "drums",
  bass808: "808",
  lead: "lead",
  arp: "arp",
  pads: "pads",
  fx: "fx",
};

// ------------------------------------------------------------------ state -

type State = "idle" | "rendering" | "playing" | "paused" | "buffering" | "error";

interface Track {
  info: PlanInfo;
  left: Float32Array;
  right: Float32Array;
  /** peak envelope, PEAKS_PER_CHUNK per bar */
  peaks: Float32Array;
  /** how many samples have been rendered so far */
  filled: number;
  complete: boolean;
  busPeaks: Record<string, number>;
}

let worker: Worker | null = null;
let ctx: AudioContext | null = null;
let gen = 0;
let state: State = "idle";
let track: Track | null = null;
let seed = "";
const words: Record<string, number> = { darker: 0, harder: 0, wider: 0 };
const locks: Record<string, string> = {};

/** Scheduled playback bookkeeping. */
let sources: AudioBufferSourceNode[] = [];
let playStartCtxTime = 0;
let playStartSample = 0;
let scheduledSamples = 0;
let raf = 0;
let pump = 0;

// ------------------------------------------------------------------- dom ---

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const elGenerate = $<HTMLButtonElement>("generate");
const elPlay = $<HTMLButtonElement>("play");
const elSeed = $<HTMLInputElement>("seed");
const elDice = $<HTMLButtonElement>("dice");
const elCanvas = $<HTMLCanvasElement>("scope");
const elMarks = $<HTMLDivElement>("marks");
const elTime = $<HTMLSpanElement>("time");
const elDuration = $<HTMLSpanElement>("duration");
const elState = $<HTMLSpanElement>("statelabel");
const elReadout = $<HTMLDListElement>("readout");
const elLanes = $<HTMLDivElement>("lanes");
const elWav = $<HTMLButtonElement>("wav");
const elStems = $<HTMLButtonElement>("stems");
const elProblem = $<HTMLDivElement>("problem");
const elProblemText = $<HTMLParagraphElement>("problemtext");
const elLive = $<HTMLDivElement>("live");
const elWords = $<HTMLDivElement>("words");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ seed ---

const SEED_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

function newSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < 8; i++) s += SEED_ALPHABET[bytes[i] % SEED_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function readHash(): void {
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const s = h.get("s");
  if (s) seed = s.toUpperCase().slice(0, 32);
  for (const name of ["darker", "harder", "wider"]) {
    const v = Number(h.get(name));
    if (Number.isFinite(v)) words[name] = Math.max(-1, Math.min(1, v));
  }
  const l = h.get("lock");
  if (l) for (const bus of l.split(",")) if (bus) locks[bus] = seed;
}

function writeHash(): void {
  const h = new URLSearchParams();
  h.set("s", seed);
  for (const name of ["darker", "harder", "wider"]) {
    if (words[name] !== 0) h.set(name, words[name].toFixed(2));
  }
  const locked = Object.keys(locks);
  if (locked.length > 0) h.set("lock", locked.join(","));
  history.replaceState(null, "", `#${h.toString()}`);
}

// ----------------------------------------------------------------- worker --

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<FromWorker>) => onWorkerMessage(e.data);
  worker.onerror = (e) => fail(`The audio engine failed to start. ${e.message ?? ""}`.trim());
  return worker;
}

function onWorkerMessage(msg: FromWorker): void {
  if ("gen" in msg && msg.gen !== gen) return; // a cancelled render still talking
  switch (msg.type) {
    case "ready":
      break;
    case "plan":
      startTrack(msg.info);
      break;
    case "chunk":
      appendChunk(msg.index, msg.start, msg.count, msg.left, msg.right, msg.peaks);
      break;
    case "done":
      if (track) {
        track.complete = true;
        track.busPeaks = msg.stats.busPeaks;
      }
      onRenderComplete();
      break;
    case "stem":
      onStem(msg.bus, msg.wav, msg.index, msg.total);
      break;
    case "stemsDone":
      finishStems();
      break;
    case "error":
      fail(msg.message);
      break;
  }
}

// ---------------------------------------------------------------- render ---

function generate(): void {
  clearProblem();
  gen++;
  stopPlayback();
  track = null;
  scheduledSamples = 0;
  setState("rendering");
  elSeed.value = seed;
  writeHash();
  drawScope();
  ensureWorker().postMessage({
    type: "render",
    gen,
    seed,
    sampleRate: SAMPLE_RATE,
    words,
    locks,
  });
  count("generate");
}

function startTrack(info: PlanInfo): void {
  const chunks = Math.ceil(info.totalSamples / info.chunkSize);
  track = {
    info,
    left: new Float32Array(info.totalSamples),
    right: new Float32Array(info.totalSamples),
    peaks: new Float32Array(chunks * PEAKS_PER_CHUNK),
    filled: 0,
    complete: false,
    busPeaks: {},
  };
  renderReadout(info);
  renderMarks(info);
  renderLanes(info);
  elDuration.textContent = clock(info.totalSamples / info.sampleRate);
}

function appendChunk(
  index: number,
  start: number,
  count_: number,
  left: ArrayBuffer,
  right: ArrayBuffer,
  peaks: ArrayBuffer,
): void {
  if (!track) return;
  const l = new Float32Array(left);
  const r = new Float32Array(right);
  track.left.set(l, start);
  track.right.set(r, start);
  track.peaks.set(new Float32Array(peaks), index * PEAKS_PER_CHUNK);
  track.filled = start + count_;
  drawScope();

  const buffered = track.filled / track.info.sampleRate;
  if (state === "rendering" && buffered >= PREBUFFER_SECONDS) {
    beginPlayback(0);
  } else if (state === "playing") {
    scheduleReady();
  }
}

function onRenderComplete(): void {
  if (!track) return;
  elWav.disabled = false;
  elStems.disabled = false;
  renderLanes(track.info);
  if (state === "rendering") beginPlayback(0);
  if (state === "paused" && playStartSample === 0) drawScope(0);
  announce(`Track ready. ${clock(track.info.totalSamples / track.info.sampleRate)}.`);
  drawScope();
}

// -------------------------------------------------------------- playback ---

function audio(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ sampleRate: SAMPLE_RATE });
  }
  return ctx;
}

function beginPlayback(fromSample: number): void {
  if (!track) return;
  const ac = audio();
  void ac.resume().then(() => {
    if (ac.state !== "running") {
      announce("Audio is blocked by the browser. Press play to start it.");
    }
  });
  stopSources();
  playStartSample = fromSample;
  playStartCtxTime = ac.currentTime + 0.08;
  scheduledSamples = fromSample;
  setState("playing");
  scheduleReady();
  startClocks();
}

/** Schedules every whole chunk that exists and has not been scheduled yet. */
function scheduleReady(): void {
  if (!track || !ctx) return;
  const ac = ctx;
  const sr = track.info.sampleRate;
  const chunk = track.info.chunkSize;
  while (scheduledSamples < track.filled) {
    const count_ = Math.min(chunk, track.filled - scheduledSamples);
    // only schedule a whole chunk unless this is the tail of a finished track
    if (count_ < chunk && !track.complete) break;
    const buf = ac.createBuffer(2, count_, sr);
    // copyToChannel's signature insists on a Float32Array over a plain
    // ArrayBuffer; a subarray of one always is, whatever the type says.
    buf.copyToChannel(
      track.left.subarray(scheduledSamples, scheduledSamples + count_) as Float32Array<ArrayBuffer>,
      0,
    );
    buf.copyToChannel(
      track.right.subarray(scheduledSamples, scheduledSamples + count_) as Float32Array<ArrayBuffer>,
      1,
    );
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    const when = playStartCtxTime + (scheduledSamples - playStartSample) / sr;
    src.start(Math.max(when, ac.currentTime));
    sources.push(src);
    scheduledSamples += count_;
  }
  // drop finished sources so the array cannot grow without bound
  sources = sources.filter((s) => s.context.currentTime < playStartCtxTime + (scheduledSamples - playStartSample) / (track?.info.sampleRate ?? SAMPLE_RATE));
  if (state === "buffering" && scheduledSamples > playStartSample) setState("playing");
}

function currentSample(): number {
  if (!ctx || !track) return 0;
  const elapsed = ctx.currentTime - playStartCtxTime;
  if (elapsed < 0) return playStartSample;
  return Math.min(track.info.totalSamples, playStartSample + Math.round(elapsed * track.info.sampleRate));
}

/**
 * Two clocks, deliberately.
 *
 * Scheduling and underrun detection run on a timer, because
 * requestAnimationFrame is throttled to a standstill in a background tab - and
 * a user who switches away mid-render would come back to silence with nothing
 * having noticed. The playhead and the canvas run on rAF, because they are
 * purely visual and should stop when nobody is looking.
 */
function startClocks(): void {
  stopClocks();
  pump = window.setInterval(pumpOnce, 100);
  raf = requestAnimationFrame(draw);
}

function stopClocks(): void {
  if (pump) window.clearInterval(pump);
  if (raf) cancelAnimationFrame(raf);
  pump = 0;
  raf = 0;
}

function pumpOnce(): void {
  if (!track || !ctx) return;
  const sr = track.info.sampleRate;
  const pos = currentSample();

  if (state === "playing") {
    if (track.complete && pos >= track.info.totalSamples - 1) {
      stopSources();
      playStartSample = 0;
      setState("paused");
      stopClocks();
      raf = requestAnimationFrame(draw);
      return;
    }
    scheduleReady();
    const aheadSeconds = (scheduledSamples - pos) / sr;
    // The render fell behind the playhead. Stop cleanly and wait for enough
    // audio rather than letting the output gap.
    if (!track.complete && aheadSeconds < UNDERRUN_MARGIN) {
      stopSources();
      playStartSample = Math.max(0, pos);
      setState("buffering");
      announce("Buffering. The render is catching up.");
    }
    return;
  }

  if (state === "buffering") {
    const ahead = (track.filled - playStartSample) / sr;
    if (ahead >= PREBUFFER_SECONDS || track.complete) {
      beginPlayback(Math.min(playStartSample, track.filled));
    }
  }
}

function draw(): void {
  if (track) {
    const pos = state === "playing" ? currentSample() : playStartSample;
    elTime.textContent = clock(pos / track.info.sampleRate);
    highlightMark(pos);
    drawScope(pos);
  }
  raf = requestAnimationFrame(draw);
}

function stopSources(): void {
  for (const s of sources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  sources = [];
}

function stopPlayback(): void {
  stopClocks();
  stopSources();
}

function togglePlay(): void {
  if (!track) return;
  if (state === "playing") {
    const pos = currentSample();
    stopSources();
    playStartSample = pos;
    setState("paused");
    drawScope(pos);
  } else if (state === "paused" || state === "buffering") {
    beginPlayback(Math.min(playStartSample, track.filled));
  }
}

// ---------------------------------------------------------------- drawing --

function drawScope(playhead = -1): void {
  const c = elCanvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w === 0 || h === 0) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const mid = h / 2;
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue("--line").trim() || "#1e232b";
  const text = css.getPropertyValue("--text").trim() || "#e4e7eb";
  const flare = css.getPropertyValue("--flare").trim() || "#ff6a1a";

  // baseline
  g.strokeStyle = line;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, Math.round(mid) + 0.5);
  g.lineTo(w, Math.round(mid) + 0.5);
  g.stroke();

  if (!track) return;
  const total = track.info.totalSamples;
  const chunk = track.info.chunkSize;
  const buckets = Math.ceil(total / chunk) * PEAKS_PER_CHUNK;
  const filledBuckets = Math.ceil((track.filled / chunk) * PEAKS_PER_CHUNK);

  // section boundaries
  g.strokeStyle = line;
  for (const s of track.info.sections) {
    const x = Math.round((s.startSample / total) * w) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }

  // the trace. Newly arrived bars are drawn in --flare and settle to --text,
  // so the drawing-in IS the render, not an animation played over it.
  const freshFrom = reducedMotion ? filledBuckets : Math.max(0, filledBuckets - PEAKS_PER_CHUNK * 2);
  for (let b = 0; b < filledBuckets && b < buckets; b++) {
    const x = (b / buckets) * w;
    const bw = Math.max(1, w / buckets);
    const p = track.peaks[b];
    const amp = Math.max(0.6, p * (mid - 6));
    g.fillStyle = b >= freshFrom ? flare : text;
    g.fillRect(x, mid - amp, bw > 1.2 ? bw - 0.4 : bw, amp * 2);
  }

  // playhead
  if (playhead >= 0 && total > 0) {
    const x = Math.round((playhead / total) * w) + 0.5;
    g.strokeStyle = flare;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
}

function renderMarks(info: PlanInfo): void {
  const total = info.totalSamples;
  elMarks.innerHTML = "";
  for (const s of info.sections) {
    const span = document.createElement("span");
    const width = ((s.endSample - s.startSample) / total) * 100;
    span.style.flexBasis = `${width}%`;
    span.textContent = s.name;
    span.dataset.start = String(s.startSample);
    span.dataset.end = String(s.endSample);
    elMarks.appendChild(span);
  }
}

function highlightMark(pos: number): void {
  for (const el of Array.from(elMarks.children) as HTMLElement[]) {
    const from = Number(el.dataset.start);
    const to = Number(el.dataset.end);
    el.classList.toggle("live", pos >= from && pos < to);
  }
}

function renderReadout(info: PlanInfo): void {
  const rows: [string, string][] = [
    ["tempo", `${info.tempo.toFixed(1)} BPM`],
    ["key", `${info.key} ${info.scale.replace(/([A-Z])/g, " $1").toLowerCase().trim()}`],
    ["form", info.arrangement],
    ["bars", String(info.bars)],
    ["rate", `${(info.sampleRate / 1000).toFixed(1)} kHz`],
  ];
  elReadout.innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join("");
}

function renderLanes(info: PlanInfo): void {
  const existing = new Map<string, HTMLElement>();
  for (const el of Array.from(elLanes.children) as HTMLElement[]) {
    existing.set(el.dataset.bus ?? "", el);
  }
  if (existing.size !== info.buses.length) {
    elLanes.innerHTML = info.buses
      .map((bus) => {
        const label = BUS_LABELS[bus] ?? bus;
        return `<div class="lane" data-bus="${bus}" data-locked="false">
          <button type="button" class="lock" data-bus="${bus}" aria-pressed="false"
            aria-label="Lock the ${label} bus, so rerolling keeps it">LOCK</button>
          <span class="name">${label}</span>
          <canvas data-bus="${bus}" aria-hidden="true"></canvas>
          <span class="db" data-bus="${bus}">&mdash;</span>
        </div>`;
      })
      .join("");
    for (const b of Array.from(elLanes.querySelectorAll<HTMLButtonElement>(".lock"))) {
      b.addEventListener("click", () => toggleLock(b.dataset.bus ?? ""));
    }
  }
  for (const bus of info.buses) {
    const peak = track?.busPeaks[bus];
    const db = elLanes.querySelector<HTMLElement>(`.db[data-bus="${bus}"]`);
    if (db) {
      db.textContent = peak !== undefined && peak > 0
        ? `${(20 * Math.log10(peak)).toFixed(1)}`
        : "—";
    }
    const lane = elLanes.querySelector<HTMLElement>(`.lane[data-bus="${bus}"]`);
    const locked = locks[bus] !== undefined;
    if (lane) lane.dataset.locked = String(locked);
    const btn = elLanes.querySelector<HTMLButtonElement>(`.lock[data-bus="${bus}"]`);
    if (btn) btn.setAttribute("aria-pressed", String(locked));
  }
}

function toggleLock(bus: string): void {
  if (!bus) return;
  if (locks[bus] !== undefined) {
    delete locks[bus];
  } else {
    locks[bus] = seed;
    count("lock");
  }
  if (track) renderLanes(track.info);
  writeHash();
}

// ----------------------------------------------------------------- words ---

/**
 * Each slider has a named opposite, so the readout is a plain adjective in
 * both directions rather than "more dark". Never a number: the brief is
 * explicit that raw DSP values do not belong in the main view, and "a little
 * harder" is a thing a person can want, where "0.35" is not.
 */
const WORD_POLES: Record<string, [string, string]> = {
  darker: ["brighter", "darker"],
  harder: ["softer", "harder"],
  wider: ["narrower", "wider"],
};
const WORD_AMOUNT = ["much ", "", "a little "];

function wordLabel(name: string, v: number): string {
  if (Math.abs(v) < 0.08) return "neutral";
  const poles = WORD_POLES[name] ?? ["less", "more"];
  const word = v < 0 ? poles[0] : poles[1];
  const mag = Math.abs(v);
  const amount = mag > 0.72 ? WORD_AMOUNT[0] : mag > 0.36 ? WORD_AMOUNT[1] : WORD_AMOUNT[2];
  return `${amount}${word}`;
}

function buildWords(): void {
  elWords.innerHTML = (["darker", "harder", "wider"] as const)
    .map(
      (name) => `<div class="word">
        <label for="w-${name}">${name}</label>
        <input type="range" id="w-${name}" data-word="${name}" min="-1" max="1" step="0.05" value="0">
        <span class="value" id="v-${name}">neutral</span>
      </div>`,
    )
    .join("");
  for (const input of Array.from(elWords.querySelectorAll<HTMLInputElement>("input"))) {
    const name = input.dataset.word ?? "";
    input.value = String(words[name] ?? 0);
    const sync = () => {
      const v = Number(input.value);
      words[name] = v;
      const label = wordLabel(name, v);
      $(`v-${name}`).textContent = label;
      input.setAttribute("aria-valuetext", label);
    };
    sync();
    input.addEventListener("input", sync);
    input.addEventListener("change", () => {
      writeHash();
      generate();
    });
  }
}

// ------------------------------------------------------------- downloads ---

function download(bytes: Uint8Array, name: string, mime: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadWav(): void {
  if (!track || !track.complete) return;
  const bytes = encodeWav(
    { L: track.left, R: track.right, length: track.info.totalSamples, sampleRate: track.info.sampleRate },
    16,
  );
  download(bytes, `nullsample-${seed}.wav`, "audio/wav");
  count("download-wav");
}

let stemEntries: ZipEntry[] = [];

function requestStems(): void {
  if (!track) return;
  stemEntries = [];
  elStems.disabled = true;
  elStems.textContent = "STEMS 0/6";
  ensureWorker().postMessage({
    type: "stems",
    gen,
    seed,
    sampleRate: SAMPLE_RATE,
    words,
    locks,
  });
  count("download-stems");
}

function onStem(bus: string, wav: ArrayBuffer, index: number, total: number): void {
  stemEntries.push({ name: `nullsample-${seed}-${bus}.wav`, data: new Uint8Array(wav) });
  elStems.textContent = `STEMS ${index + 1}/${total}`;
}

function finishStems(): void {
  download(makeZip(stemEntries), `nullsample-${seed}-stems.zip`, "application/zip");
  stemEntries = [];
  elStems.disabled = false;
  elStems.textContent = "STEMS";
}

// ------------------------------------------------------------------- ui ----

function setState(next: State): void {
  state = next;
  const labels: Record<State, string> = {
    idle: "ready",
    rendering: "rendering",
    playing: "playing",
    paused: "paused",
    buffering: "buffering",
    error: "stopped",
  };
  elState.textContent = labels[next];
  elGenerate.textContent = track ? "REROLL" : "GENERATE";
  elGenerate.disabled = false;
  elPlay.disabled = !track;
  elPlay.textContent = next === "playing" ? "▮▮" : "▶";
  elPlay.setAttribute("aria-label", next === "playing" ? "Pause" : "Play");
  if (next === "rendering") {
    elWav.disabled = true;
    elStems.disabled = true;
  }
}

function fail(message: string): void {
  setState("error");
  elProblem.hidden = false;
  elProblemText.textContent = message;
  announce(`Something went wrong. ${message}`);
}

function clearProblem(): void {
  elProblem.hidden = true;
}

function announce(text: string): void {
  elLive.textContent = text;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** GoatCounter events. No-op when the script is blocked or absent. */
function count(name: string): void {
  const g = (window as unknown as { goatcounter?: { count?: (o: object) => void } }).goatcounter;
  g?.count?.({ path: name, title: name, event: true });
}

// ------------------------------------------------------------------ boot ---

readHash();
if (!seed) seed = newSeed();
elSeed.value = seed;
buildWords();
setState("idle");
drawScope();

elGenerate.addEventListener("click", () => {
  generate();
});
elPlay.addEventListener("click", togglePlay);
elDice.addEventListener("click", () => {
  seed = newSeed();
  elSeed.value = seed;
  for (const k of Object.keys(locks)) delete locks[k];
  if (track) renderLanes(track.info);
  writeHash();
});
elSeed.addEventListener("change", () => {
  const v = elSeed.value.trim().toUpperCase();
  if (v) {
    seed = v;
    writeHash();
  } else {
    elSeed.value = seed;
  }
});
elWav.addEventListener("click", downloadWav);
elStems.addEventListener("click", requestStems);

window.addEventListener("resize", () => drawScope(track ? currentSample() : -1));
window.addEventListener("hashchange", () => {
  readHash();
  elSeed.value = seed;
});

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (track) togglePlay();
    else generate();
  }
});

/**
 * Warm the worker on the first sign of a human, not on a timer.
 *
 * Compiling the engine is the largest single task the page ever runs, and
 * doing it on an idle callback right after load puts it inside the window
 * where blocking time is measured - for a visitor who may never press
 * anything. Waiting for a pointer or a key means the cost lands while someone
 * is reaching for the button, and the press is still warm.
 */
{
  const warm = () => {
    ensureWorker();
    for (const ev of ["pointerdown", "keydown", "pointermove", "touchstart"]) {
      window.removeEventListener(ev, warm);
    }
  };
  for (const ev of ["pointerdown", "keydown", "pointermove", "touchstart"]) {
    window.addEventListener(ev, warm, { once: false, passive: true });
  }
}
