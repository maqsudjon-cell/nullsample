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
/** Gap between capturing the clock anchor and the first chunk starting. */
const LEAD_IN = 0.12;
const BUS_LABELS: Record<string, string> = {
  drums: "drums",
  bass808: "808",
  lead: "lead",
  arp: "arp",
  pads: "pads",
  fx: "fx",
};

// ------------------------------------------------------------------ state -

type State = "idle" | "rendering" | "playing" | "paused" | "buffering" | "blocked" | "error";

interface Track {
  info: PlanInfo;
  left: Float32Array;
  right: Float32Array;
  /** [peak, rms] interleaved, PEAKS_PER_CHUNK buckets per bar */
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

/**
 * Scheduled playback bookkeeping.
 *
 * `anchorCtxTime` is captured ONCE, after `resume()` has resolved and the
 * context is confirmed running, and every chunk is scheduled against it.
 * Re-reading `currentTime` per chunk is the classic progressive-playback bug:
 * if the context has not started yet it reads 0, every section is scheduled in
 * the past, and the browser discards them all without an error.
 */
let sources = new Set<AudioBufferSourceNode>();
let anchorCtxTime = 0;
let anchorSample = 0;
let scheduledSamples = 0;
let raf = 0;
let pump = 0;
let masterGain: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let analyserBuf: Float32Array | null = null;
/** Set when the context stops running while we believed we were playing. */
let needsGesture = false;
/** how much of the track has been rendered, 0..1, for the assembly animation */
let assembled = 0;
let seedAnim = 0;
let spectrumRaf = 0;

/** Everything the #debug readout reports. Written where it actually happens. */
const probe = {
  lastWhen: 0,
  lastNow: 0,
  lastBufferPeak: 0,
  maxBufferPeak: 0,
  scheduledInPast: 0,
  nodesAlive: 0,
  contextRate: 0,
  requestedRate: 0,
  resumeError: "",
  unlockedInGesture: false,
  chunksScheduled: 0,
};

// ------------------------------------------------------------------- dom ---

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const elGenerate = $<HTMLButtonElement>("generate");
const elPlay = $<HTMLButtonElement>("play");
const elSeed = $<HTMLInputElement>("seed");
const elShare = $<HTMLButtonElement>("share");
const elDlMenu = $<HTMLDetailsElement>("dlmenu");
const elSpectrum = $<HTMLPreElement>("spectrum");
const elHint = $<HTMLParagraphElement>("hint");
const elRetry = $<HTMLButtonElement>("retry");
const elCanvas = $<HTMLCanvasElement>("scope");
const elRuler = $<HTMLDivElement>("ruler");
const elTime = $<HTMLSpanElement>("time");
const elDuration = $<HTMLSpanElement>("duration");
const elState = $<HTMLSpanElement>("statelabel");
const elStamp = $<HTMLParagraphElement>("stamp");
const elNow = $<HTMLSpanElement>("nowname");
const elTechList = $<HTMLDListElement>("techlist");
const elTech = $<HTMLDetailsElement>("tech");
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

/**
 * Cleans up a typed or pasted seed.
 *
 * Deliberately NOT filtered to SEED_ALPHABET. That alphabet exists to make
 * generated seeds readable aloud - no I, O, 0 or 1 - but the engine hashes
 * whatever string it is given, so filtering input to it would reject perfectly
 * valid seeds. Including this site's own demo seeds: NULL-0001 came back as
 * "NULL".
 */
function normaliseSeedInput(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
  // eight bare characters get the familiar grouping; anything else is left alone
  return /^[A-Z0-9]{8}$/.test(cleaned)
    ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
    : cleaned.replace(/^-+|-+$/g, "");
}

/**
 * The eight characters cycle and settle left to right over about 400 ms.
 *
 * It is small and it does real work: a seed that resolves in front of you reads
 * as the SOURCE of the track rather than a label attached to it afterwards.
 */
function animateSeed(target: string): void {
  // The true value goes in first, always. requestAnimationFrame is throttled
  // in a hidden or backgrounded tab, so an animation that is the only thing
  // writing the final value leaves a stale seed on screen - which is the same
  // mistake as letting rAF drive the scheduler, caught the same way.
  elSeed.value = target;
  if (reducedMotion) return;
  cancelAnimationFrame(seedAnim);
  const plain = target.replace("-", "");
  const start = performance.now();
  const DURATION = 400;
  let frame = 0;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / DURATION);
    const settled = Math.floor(t * plain.length);
    frame++;
    let out = "";
    for (let i = 0; i < plain.length; i++) {
      // Cycled by index rather than by Math.random: it looks the same at
      // fifteen frames a second, and it keeps the determinism lint meaningful
      // - a reader scanning for randomness should never have to decide which
      // occurrences are "only cosmetic".
      out += i < settled
        ? plain[i]
        : SEED_ALPHABET[(frame * 7 + i * 13) % SEED_ALPHABET.length];
    }
    elSeed.value = `${out.slice(0, 4)}-${out.slice(4)}`;
    if (t < 1) seedAnim = requestAnimationFrame(step);
    else elSeed.value = target;
  };
  seedAnim = requestAnimationFrame(step);
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
  // Keep #debug alive across rerolls. Rewriting the hash dropped it, so
  // pressing REROLL on a phone and then reloading lost the readout - which is
  // exactly the situation the readout exists for.
  if (debugEnabled()) h.set("debug", "1");
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
  // The waveform clears and redraws as the new track arrives. This is the
  // action people repeat most, so it should feel like something happening.
  track = null;
  assembled = 0;
  shownSection = "";
  elNow.textContent = "";
  scheduledSamples = 0;
  probe.maxBufferPeak = 0;
  probe.scheduledInPast = 0;
  probe.chunksScheduled = 0;
  setState("rendering");
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
    peaks: new Float32Array(chunks * PEAKS_PER_CHUNK * 2),
    filled: 0,
    complete: false,
    busPeaks: {},
  };
  renderStamp(info);
  renderRuler(info);
  // show the opening section immediately, rather than waiting for the first
  // animation frame - the name is part of the track appearing, not of playback
  highlightMark(0);
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
  track.peaks.set(new Float32Array(peaks), index * PEAKS_PER_CHUNK * 2);
  track.filled = start + count_;
  assembled = track.filled / track.info.totalSamples;
  drawScope();
  // The wait is unavoidable, so spend it showing the track being built rather
  // than on a progress bar: the waveform draws in section by section, the
  // lanes fill behind it, and the ruler ticks in as the render passes each
  // boundary. Honest progress, and the same information a bar would carry.
  for (const bus of track.info.buses) drawLane(bus, track.info);
  revealTicks();

  const buffered = track.filled / track.info.sampleRate;
  if (state === "rendering" && buffered >= PREBUFFER_SECONDS) {
    void beginPlayback(0);
  } else if (state === "playing") {
    scheduleReady();
  }
}

function onRenderComplete(): void {
  if (!track) return;
  assembled = 1;
  elWav.disabled = false;
  elStems.disabled = false;
  renderLanes(track.info);
  revealTicks();
  maybeShowHint();
  if (state === "rendering") void beginPlayback(0);
  if (state === "paused" && anchorSample === 0) drawScope(0);
  announce(`Track ready. ${clock(track.info.totalSamples / track.info.sampleRate)}.`);
  drawScope();
}

// -------------------------------------------------------------- playback ---

/**
 * Creates and unlocks the AudioContext. MUST be called synchronously from a
 * user gesture handler.
 *
 * iOS will not let a context start outside a gesture, and the gesture expires
 * long before a progressive render produces its first bar - so unlocking at
 * playback time, seconds after the press, is too late. The silent one-sample
 * buffer is the standard unlock: it gives the context something to render
 * while the gesture is still live.
 */
function unlockAudio(): AudioContext | null {
  try {
    if (!ctx) {
      // 'playback' also keeps audio alive through the iOS silent switch on
      // 16.4 and later. Set before the context exists where possible.
      setAudioSession();
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      probe.requestedRate = SAMPLE_RATE;
      try {
        ctx = new Ctor({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
      } catch {
        // older Safari rejects the sampleRate option; the buffers carry their
        // own rate and the source node resamples them
        ctx = new Ctor();
      }
      probe.contextRate = ctx.sampleRate;
      masterGain = ctx.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(ctx.destination);
      if (debugEnabled()) attachAnalyser();
      ctx.addEventListener("statechange", onContextStateChange);
    }
    setAudioSession();
    // silent tick, synchronously, while the gesture is still valid
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    s.connect(masterGain ?? ctx.destination);
    s.start();
    void ctx.resume().then(
      () => {
        probe.resumeError = "";
      },
      (err: unknown) => {
        probe.resumeError = err instanceof Error ? err.name : String(err);
      },
    );
    probe.unlockedInGesture = true;
    return ctx;
  } catch (err) {
    probe.resumeError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/**
 * Taps the signal actually reaching the destination.
 *
 * "Chunks were scheduled" and "sound is being produced" are different claims,
 * and on a phone only the second one matters. This measures the graph, so a
 * reading of zero means the engine or the scheduler is at fault, and a healthy
 * reading with no audible sound points at the device's output instead.
 */
function attachAnalyser(): void {
  if (!ctx || !masterGain || analyser) return;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyserBuf = new Float32Array(analyser.fftSize);
  masterGain.connect(analyser);
}

// -------------------------------------------------------------- spectrum ---

/**
 * A monospace character grid driven by the analyser on the playing audio.
 *
 * The one rule that matters: it must be real. A faked or looping animation
 * here would be the single lie that undercuts a product whose entire claim is
 * that the audio is computed in front of you. So it reads the graph, and when
 * the graph is silent it stops rather than idling.
 */
const SPECTRUM_COLS = 22;
const SPECTRUM_ROWS = 4;
const BLOCKS = " \u2591\u2592\u2593\u2588";
let freqBuf: Uint8Array | null = null;
const smoothed = new Float32Array(SPECTRUM_COLS);

function paintSpectrum(): void {
  if (!analyser) return;
  if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) {
    freqBuf = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteFrequencyData(freqBuf as Uint8Array<ArrayBuffer>);
  // Logarithmic column edges: linear bins would spend nineteen columns above
  // 5 kHz, where this music has almost nothing to say.
  const n = freqBuf.length;
  let out = "";
  for (let c = 0; c < SPECTRUM_COLS; c++) {
    const lo = Math.floor(Math.pow(n, c / SPECTRUM_COLS));
    const hi = Math.max(lo + 1, Math.floor(Math.pow(n, (c + 1) / SPECTRUM_COLS)));
    let sum = 0;
    for (let i = lo; i < hi && i < n; i++) sum += freqBuf[i];
    const v = sum / (hi - lo) / 255;
    smoothed[c] = smoothed[c] * 0.6 + v * 0.4;
  }
  for (let row = SPECTRUM_ROWS - 1; row >= 0; row--) {
    for (let c = 0; c < SPECTRUM_COLS; c++) {
      const level = smoothed[c] * SPECTRUM_ROWS - row;
      const idx = level <= 0 ? 0 : Math.min(4, Math.ceil(level * 4));
      out += BLOCKS[idx];
    }
    if (row > 0) out += "\n";
  }
  elSpectrum.textContent = out;
}

function clearSpectrum(): void {
  smoothed.fill(0);
  elSpectrum.textContent = "";
}

function spectrumLoop(): void {
  if (state !== "playing") {
    spectrumRaf = 0;
    clearSpectrum();
    return;
  }
  paintSpectrum();
  spectrumRaf = requestAnimationFrame(spectrumLoop);
}

function startSpectrum(): void {
  if (reducedMotion || spectrumRaf !== 0) return;
  spectrumRaf = requestAnimationFrame(spectrumLoop);
}

function outputLevelDb(): number {
  if (!analyser || !analyserBuf) return -Infinity;
  analyser.getFloatTimeDomainData(analyserBuf as Float32Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < analyserBuf.length; i++) sum += analyserBuf[i] * analyserBuf[i];
  const rms = Math.sqrt(sum / analyserBuf.length);
  return rms > 1e-7 ? 20 * Math.log10(rms) : -Infinity;
}

function setAudioSession(): void {
  const nav = navigator as unknown as { audioSession?: { type: string } };
  if (nav.audioSession) {
    try {
      nav.audioSession.type = "playback";
    } catch {
      /* not settable on this browser */
    }
  }
}

function audioSessionType(): string {
  const nav = navigator as unknown as { audioSession?: { type: string } };
  return nav.audioSession ? nav.audioSession.type : "unsupported";
}

/**
 * Safari can move a context to "interrupted" - a state no other engine has -
 * when another app takes audio focus or the phone locks. Treat anything that
 * is not "running" as not playing, and say so rather than showing a playhead
 * that is moving over silence.
 */
function onContextStateChange(): void {
  if (!ctx) return;
  if (ctx.state !== "running" && (state === "playing" || state === "buffering")) {
    stopSources();
    needsGesture = true;
    setState("blocked");
    announce("Audio was interrupted. Tap play to resume.");
  }
}

/** True only when the hardware is really running. Nothing else may claim it. */
function contextRunning(): boolean {
  return ctx !== null && ctx.state === "running";
}

async function beginPlayback(fromSample: number): Promise<void> {
  if (!track) return;
  const ac = ctx ?? unlockAudio();
  if (!ac) {
    setState("blocked");
    return;
  }
  stopSources();
  try {
    await ac.resume();
  } catch (err) {
    probe.resumeError = err instanceof Error ? err.name : String(err);
  }
  // The anchor is only meaningful once the clock is really running.
  if (ac.state !== "running") {
    needsGesture = true;
    anchorSample = fromSample;
    setState("blocked");
    announce("Audio is blocked by the browser. Tap play to start it.");
    return;
  }
  needsGesture = false;
  anchorSample = fromSample;
  anchorCtxTime = ac.currentTime + LEAD_IN;
  scheduledSamples = fromSample;
  setState("playing");
  scheduleReady();
  startClocks();
}

/** Schedules every whole chunk that exists and has not been scheduled yet. */
function scheduleReady(): void {
  if (!track || !ctx || !contextRunning()) return;
  const ac = ctx;
  const sr = track.info.sampleRate;
  const chunk = track.info.chunkSize;
  while (scheduledSamples < track.filled) {
    const count_ = Math.min(chunk, track.filled - scheduledSamples);
    // only schedule a whole chunk unless this is the tail of a finished track
    if (count_ < chunk && !track.complete) break;

    // The buffer keeps the engine's 44.1 kHz rate whatever the device runs at;
    // the source node resamples. The downloaded file must never depend on the
    // hardware, so the audio is not resampled before it is stored.
    const buf = ac.createBuffer(2, count_, sr);
    const l = track.left.subarray(scheduledSamples, scheduledSamples + count_);
    const r = track.right.subarray(scheduledSamples, scheduledSamples + count_);
    buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1);

    let peak = 0;
    for (let i = 0; i < count_; i += 17) {
      const a = l[i] < 0 ? -l[i] : l[i];
      if (a > peak) peak = a;
    }
    probe.lastBufferPeak = peak;
    if (peak > probe.maxBufferPeak) probe.maxBufferPeak = peak;

    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(masterGain ?? ac.destination);

    const when = anchorCtxTime + (scheduledSamples - anchorSample) / sr;
    probe.lastWhen = when;
    probe.lastNow = ac.currentTime;
    if (when <= ac.currentTime) {
      // Scheduling in the past means the chunk is dropped silently. It should
      // be impossible now that the anchor is captured after resume; if it ever
      // happens again the readout will say so instead of the page going quiet.
      probe.scheduledInPast++;
      console.warn(
        `nullsample: chunk scheduled in the past (when=${when.toFixed(3)} now=${ac.currentTime.toFixed(3)})`,
      );
    }
    src.start(when);
    probe.chunksScheduled++;

    // Hold the reference until the node actually ends. A source that is
    // garbage collected mid-playback stops without raising anything.
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      probe.nodesAlive = sources.size;
    };
    probe.nodesAlive = sources.size;

    scheduledSamples += count_;
  }
  if (state === "buffering" && scheduledSamples > anchorSample) setState("playing");
}

/**
 * The playhead, derived from the audio clock and nothing else.
 *
 * If the context is not running this returns the anchor, so the interface can
 * never show a playhead moving over silence.
 */
function currentSample(): number {
  if (!ctx || !track || ctx.state !== "running") return anchorSample;
  const elapsed = ctx.currentTime - anchorCtxTime;
  if (elapsed < 0) return anchorSample;
  return Math.min(
    track.info.totalSamples,
    anchorSample + Math.round(elapsed * track.info.sampleRate),
  );
}

/**
 * Two clocks, deliberately.
 *
 * The timer is a scheduler tick, not a clock: every decision it makes reads
 * ctx.currentTime. It exists because requestAnimationFrame is throttled to a
 * standstill in a background tab, and a listener who switches away mid-render
 * would otherwise return to silence with nothing having noticed. The playhead
 * and the canvas run on rAF, because they are purely visual.
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
  if (state === "playing" && !contextRunning()) {
    onContextStateChange();
    return;
  }
  const sr = track.info.sampleRate;
  const pos = currentSample();

  if (state === "playing") {
    if (track.complete && pos >= track.info.totalSamples - 1) {
      // Loop rather than stop dead. A track that ends in silence with no next
      // action loses the visitor at the exact moment they were listening.
      stopSources();
      scheduledSamples = 0;
      void beginPlayback(0);
      return;
    }
    scheduleReady();
    const aheadSeconds = (scheduledSamples - pos) / sr;
    // The render fell behind the playhead. Stop cleanly and wait for enough
    // audio rather than letting the output gap.
    if (!track.complete && aheadSeconds < UNDERRUN_MARGIN) {
      stopSources();
      anchorSample = Math.max(0, pos);
      setState("buffering");
      announce("Buffering. The render is catching up.");
    }
    return;
  }

  if (state === "buffering") {
    const ahead = (track.filled - anchorSample) / sr;
    if (ahead >= PREBUFFER_SECONDS || track.complete) {
      void beginPlayback(Math.min(anchorSample, track.filled));
    }
  }
}

function draw(): void {
  if (track) {
    const pos = state === "playing" ? currentSample() : anchorSample;
    elTime.textContent = clock(pos / track.info.sampleRate);
    highlightMark(pos);
    drawScope(pos);
  }
  raf = requestAnimationFrame(draw);
}

function stopSources(): void {
  for (const s of sources) {
    try {
      s.onended = null;
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  sources.clear();
  probe.nodesAlive = 0;
}

function stopPlayback(): void {
  stopClocks();
  stopSources();
}

/** The play/pause control. Always a gesture, so it can also unlock the context. */
function togglePlay(): void {
  if (!track) return;
  unlockAudio();
  if (state === "playing") {
    const pos = currentSample();
    stopSources();
    anchorSample = pos;
    setState("paused");
    drawScope(pos);
  } else if (state === "paused" || state === "buffering" || state === "blocked") {
    void beginPlayback(Math.min(anchorSample, track.filled));
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

  const mid = Math.round(h / 2);
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue("--line").trim() || "#1e232b";
  const dim = css.getPropertyValue("--dim").trim() || "#7a8391";
  const text = css.getPropertyValue("--text").trim() || "#e4e7eb";
  const flare = css.getPropertyValue("--flare").trim() || "#ff6a1a";
  const pad = 12;
  const height = mid - pad;
  // a gutter for the amplitude labels, only when they are shown
  const gutter = elTech.open ? 26 : 0;
  const plotW = w - gutter;

  g.font = `12px ${css.getPropertyValue("--mono").trim() || "monospace"}`;
  g.textBaseline = "middle";

  // The measurement furniture - amplitude values, time ticks, section rules -
  // only appears when someone has asked for it. A listener wants a waveform,
  // not an oscilloscope.
  const technical = elTech.open;

  if (technical) {
    const amps: [number, string][] = [[1, "1.0"], [0.5, "0.5"], [0, "0"], [-0.5, "0.5"], [-1, "1.0"]];
    g.strokeStyle = line;
    g.lineWidth = 1;
    for (const [v, label] of amps) {
      const y = Math.round(mid - v * height) + 0.5;
      g.beginPath();
      g.moveTo(gutter, y);
      g.lineTo(w, y);
      g.stroke();
      g.fillStyle = v === 0 ? dim : line;
      g.fillText(label, 2, y);
    }
  }

  if (!track) {
    // An invitation to act, not a placeholder: a flat line waiting for a
    // signal, which is exactly what the product is about to put there.
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(gutter, mid + 0.5);
    g.lineTo(w, mid + 0.5);
    g.stroke();
    return;
  }

  const total = track.info.totalSamples;
  const sr = track.info.sampleRate;
  const chunk = track.info.chunkSize;
  const buckets = Math.ceil(total / chunk) * PEAKS_PER_CHUNK;
  const filledBuckets = Math.ceil((track.filled / chunk) * PEAKS_PER_CHUNK);

  // --- time scale, technical only ---------------------------------------
  const durationSec = total / sr;
  const step = durationSec > 150 ? 30 : durationSec > 60 ? 15 : 10;
  g.strokeStyle = line;
  for (let t = step; technical && t < durationSec; t += step) {
    const x = Math.round(gutter + (t / durationSec) * plotW) + 0.5;
    g.beginPath();
    g.moveTo(x, mid - height);
    g.lineTo(x, mid - height + 6);
    g.moveTo(x, mid + height - 6);
    g.lineTo(x, mid + height);
    g.stroke();
    g.fillStyle = line;
    const label = `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;
    g.fillText(label, x + 4, mid + height - 8);
  }

  // --- section boundaries, technical only --------------------------------
  if (technical) {
    g.strokeStyle = line;
    for (const s of track.info.sections) {
      const x = Math.round(gutter + (s.startSample / total) * plotW) + 0.5;
      g.beginPath();
      g.moveTo(x, mid - height);
      g.lineTo(x, mid + height);
      g.stroke();
    }
  }

  // --- the trace ---------------------------------------------------------
  // Newly arrived bars are drawn in --flare and settle to --text, so the
  // drawing-in IS the render rather than an animation played over it. Peak is
  // faint with rms filled inside: peak alone is a solid block on a limited
  // master and the arrangement disappears.
  const freshFrom = reducedMotion ? filledBuckets : Math.max(0, filledBuckets - PEAKS_PER_CHUNK * 2);
  const bw = Math.max(1, plotW / buckets);
  const bodyW = bw > 1.2 ? bw - 0.4 : bw;
  for (let b = 0; b < filledBuckets && b < buckets; b++) {
    const x = gutter + (b / buckets) * plotW;
    const fresh = b >= freshFrom;
    const peakAmp = Math.max(0.6, track.peaks[b * 2] * height);
    g.globalAlpha = fresh ? 0.5 : 0.3;
    g.fillStyle = fresh ? flare : text;
    g.fillRect(x, mid - peakAmp, bodyW, peakAmp * 2);
    const rmsAmp = Math.max(0.6, track.peaks[b * 2 + 1] * height * 1.6);
    g.globalAlpha = 1;
    g.fillRect(x, mid - rmsAmp, bodyW, rmsAmp * 2);
  }
  g.globalAlpha = 1;

  // --- playhead ----------------------------------------------------------
  if (playhead >= 0 && total > 0) {
    const x = Math.round(gutter + (playhead / total) * plotW) + 0.5;
    g.strokeStyle = flare;
    g.beginPath();
    g.moveTo(x, mid - height);
    g.lineTo(x, mid + height);
    g.stroke();
  }
}

/**
 * The timeline ruler: ticks only.
 *
 * Every section label cannot fit, and trying is what produced "introbuild",
 * "breakdrop2" and a clipped "outro" in the live build. The ticks carry the
 * boundaries; the name of the current section is shown once, large, above.
 */
/** Ticks appear as the render reaches them, so the structure arrives with the audio. */
function revealTicks(): void {
  if (!track) return;
  const upto = reducedMotion ? track.info.totalSamples : track.filled;
  for (const t of Array.from(elRuler.querySelectorAll<HTMLElement>(".tick"))) {
    const at = Number(t.dataset.start ?? "0");
    if (at <= upto) t.dataset.shown = "true";
  }
}

function renderRuler(info: PlanInfo): void {
  const total = info.totalSamples;
  const parts: string[] = ['<div class="playhead" id="playhead" style="left:0;display:none"></div>'];
  for (const s of info.sections) {
    const pct = (s.startSample / total) * 100;
    parts.push(
      `<div class="tick" data-start="${s.startSample}" data-end="${s.endSample}"` +
        ` data-shown="${s.startSample === 0 ? "true" : "false"}" style="left:${pct}%"></div>`,
    );
  }
  elRuler.innerHTML = parts.join("");
}

let shownSection = "";

/**
 * One name at a time, swapped as the playhead crosses a boundary, so the
 * structure is something you feel rather than something you decode.
 */
function highlightMark(pos: number): void {
  const total = track ? track.info.totalSamples : 0;
  let current = "";
  for (const el of Array.from(elRuler.children) as HTMLElement[]) {
    if (el.classList.contains("playhead")) {
      if (total > 0 && state !== "idle") {
        el.style.display = "block";
        el.style.left = `${(pos / total) * 100}%`;
      }
      continue;
    }
    const from = Number(el.dataset.start);
    const to = Number(el.dataset.end);
    const live = pos >= from && pos < to;
    el.classList.toggle("live", live);
    if (live && track) {
      const sec = track.info.sections.find((x) => x.startSample === from);
      if (sec) current = sec.name;
    }
  }
  if (current && current !== shownSection) {
    shownSection = current;
    if (reducedMotion) {
      elNow.textContent = current;
    } else {
      elNow.classList.add("swap");
      window.setTimeout(() => {
        elNow.textContent = current;
        elNow.classList.remove("swap");
      }, 150);
    }
  }
}

function prettyScale(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim()
    .replace("natural minor", "min")
    .replace("harmonic minor", "harm min")
    .replace("minor pentatonic", "min pent")
    .replace("phrygian dominant", "phryg dom")
    .replace("aeolian sharp4", "aeolian #4");
}

/**
 * Tempo, key, length. Sample rate, bar count and arrangement name are engine
 * internals: someone who wants a track does not need them to get one, and
 * they go behind the technical toggle.
 */
function renderStamp(info: PlanInfo): void {
  // Tempo and length only. "E MIN PENT" means nothing to a video editor, and
  // everything it might mean to anyone else is one tap away under `details`.
  const secs = info.totalSamples / info.sampleRate;
  elStamp.textContent = [`${info.tempo.toFixed(0)} BPM`, clock(secs)].join("  \u00B7  ");
  renderTech(info);
}

function renderTech(info: PlanInfo): void {
  const rows: [string, string][] = [
    ["key", `${info.key} ${prettyScale(info.scale)}`],
    ["arrangement", info.arrangement],
    ["bars", String(info.bars)],
    ["sample rate", `${(info.sampleRate / 1000).toFixed(1)} kHz`],
    ["sections", info.sections.map((x) => x.name).join(" ")],
  ];
  if (track) {
    for (const bus of info.buses) {
      const peak = track.busPeaks[bus];
      if (peak !== undefined && peak > 0) {
        rows.push([`${BUS_LABELS[bus] ?? bus} peak`, `${(20 * Math.log10(peak)).toFixed(1)} dBFS`]);
      }
    }
  }
  elTechList.innerHTML = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
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
        // "keep" rather than "lock": lock-and-reroll is the one thing the
        // model-based competitors structurally cannot do, and it was sitting
        // on screen as six grey bars with no affordance and a word nobody
        // reaches for. A lane you tap that then reads `keeping` needs no
        // explanation at all.
        return `<button type="button" class="lane" data-bus="${bus}" data-keep="false"
            aria-pressed="false" aria-label="Keep ${label} when you reroll">
          <span class="name">${label}</span>
          <canvas data-bus="${bus}" aria-hidden="true"></canvas>
          <span class="keepmark">keeping</span>
        </button>`;
      })
      .join("");
    for (const b of Array.from(elLanes.querySelectorAll<HTMLButtonElement>(".lane"))) {
      b.addEventListener("click", () => toggleLock(b.dataset.bus ?? ""));
    }
  }
  for (const bus of info.buses) {
    drawLane(bus, info);
    const lane = elLanes.querySelector<HTMLElement>(`.lane[data-bus="${bus}"]`);
    const kept = locks[bus] !== undefined;
    if (lane) {
      lane.dataset.keep = String(kept);
      lane.setAttribute("aria-pressed", String(kept));
    }
  }
}

/**
 * The lane strip: where in the track this part actually plays.
 *
 * Real structure, not a level meter - it answers "what does the arp do?"
 * without a number, and it makes locking a part mean something you can see.
 */
function drawLane(bus: string, info: PlanInfo): void {
  const c = elLanes.querySelector<HTMLCanvasElement>(`canvas[data-bus="${bus}"]`);
  if (!c) return;
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
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue("--line").trim();
  const locked = locks[bus] !== undefined;
  const active = locked
    ? css.getPropertyValue("--flare").trim()
    : css.getPropertyValue("--line-hi").trim();
  const total = info.totalSamples;
  const y = Math.round(h / 2) - 1;
  g.fillStyle = line;
  g.fillRect(0, y, w, 2);
  // Each lane fills left to right as the render reaches it. The bar is not a
  // progress indicator standing in for the work - it IS the work, drawn where
  // that part will actually play.
  const reach = reducedMotion ? w : assembled * w;
  g.fillStyle = active;
  for (const s of info.sections) {
    if (!s.buses.includes(bus)) continue;
    const x = (s.startSample / total) * w;
    const bw = ((s.endSample - s.startSample) / total) * w;
    const drawn = Math.min(Math.max(1, bw - 1.5), reach - x);
    if (drawn <= 0) continue;
    g.fillRect(x, y - 3, drawn, 8);
  }
}

const HINT_KEY = "ns.kept";

/**
 * Teach it once, by doing.
 *
 * One line under the lanes after the first track finishes, gone for good after
 * the first successful keep. No modal, no tour, no dismissible banner - all of
 * which are ways of admitting the interface does not explain itself.
 */
function maybeShowHint(): void {
  let learned = false;
  try {
    learned = localStorage.getItem(HINT_KEY) === "1";
  } catch {
    learned = false;
  }
  elHint.hidden = learned;
}

function toggleLock(bus: string): void {
  if (!bus) return;
  if (locks[bus] !== undefined) {
    delete locks[bus];
  } else {
    locks[bus] = seed;
    count("keep");
    elHint.hidden = true;
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* private mode: the hint simply shows again next time */
    }
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

// ----------------------------------------------------------------- share ---

/**
 * A seed is eight characters that reproduce a track exactly on any machine, so
 * a shared link does not point at a file - it regenerates the music on the
 * recipient's device. That is the only organic distribution this product has.
 */
async function shareSeed(): Promise<void> {
  const url = `${location.origin}/generate/#s=${encodeURIComponent(seed)}`;
  const label = elShare.textContent ?? "SHARE";
  const done = (text: string) => {
    elShare.textContent = text;
    announce(text === "COPIED" ? "Link copied." : "Copy the link from the address bar.");
    setTimeout(() => { elShare.textContent = label; }, 1600);
  };
  if (navigator.share) {
    try {
      await navigator.share({ title: `Nullsample ${seed}`, url });
      count("share");
      return;
    } catch {
      /* dismissed, or unsupported for this payload: fall through to copy */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    done("COPIED");
    count("share");
  } catch {
    done("COPY IT");
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
  // A2: the interface may not claim to be playing while the context is not
  // running. An interface that can lie about this costs hours on every future
  // audio bug, so the lie is made impossible here rather than avoided by
  // convention at every call site.
  if (next === "playing" && !contextRunning()) next = "blocked";
  state = next;
  // No "playing" label: a moving playhead already says it, and a word that
  // only ever restates what is visible is a word in the way.
  const labels: Record<State, string> = {
    idle: "",
    rendering: "building\u2026",
    playing: "",
    paused: "paused",
    buffering: "buffering",
    blocked: "tap play to start audio",
    error: "stopped",
  };
  elState.textContent = labels[next];
  if (next === "playing") startSpectrum();
  else if (spectrumRaf === 0) clearSpectrum();
  elGenerate.textContent = track ? "REROLL" : "GENERATE";
  elGenerate.disabled = false;
  elPlay.disabled = !track;
  const showPause = next === "playing";
  elPlay.textContent = showPause ? "\u25AE\u25AE" : "\u25B6";
  elPlay.setAttribute("aria-label", showPause ? "Pause" : "Play");
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

// ----------------------------------------------------------------- debug ---

/**
 * The #debug readout.
 *
 * Ground truth from the device, because a phone cannot be attached to a
 * debugger and every theory about iOS audio is worth less than one screenshot.
 * Every value is read live from the objects that decide whether sound happens.
 */
let debugTimer = 0;

function debugEnabled(): boolean {
  return location.hash.includes("debug");
}

function buildDebug(): void {
  if (!debugEnabled() || document.getElementById("debugpanel")) return;
  const panel = document.createElement("div");
  panel.id = "debugpanel";
  panel.className = "debugpanel";
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "off");
  panel.innerHTML = '<b>audio debug</b><table id="debugrows"></table>';
  document.body.appendChild(panel);
  attachAnalyser();
  debugTimer = window.setInterval(paintDebug, 120);
  paintDebug();
}

function paintDebug(): void {
  const rows = document.getElementById("debugrows");
  if (!rows) return;
  const gain = masterGain ? masterGain.gain.value : NaN;
  const outputDb = outputLevelDb();
  const pos = track ? currentSample() : 0;
  const data: [string, string, boolean?][] = [
    ["ctx.state", ctx ? ctx.state : "no context", !ctx || ctx.state !== "running"],
    ["ctx.currentTime", ctx ? ctx.currentTime.toFixed(3) : "—", !!ctx && ctx.currentTime === 0],
    ["ctx.sampleRate", ctx ? String(ctx.sampleRate) : "—", !!ctx && ctx.sampleRate !== SAMPLE_RATE],
    ["requested rate", String(probe.requestedRate || SAMPLE_RATE)],
    ["audioSession.type", audioSessionType(), audioSessionType() !== "playback"],
    ["unlocked in gesture", String(probe.unlockedInGesture), !probe.unlockedInGesture],
    ["resume error", probe.resumeError || "none", probe.resumeError !== ""],
    ["anchor ctxTime", anchorCtxTime.toFixed(3)],
    ["last start(when)", probe.lastWhen.toFixed(3)],
    ["  ctxTime then", probe.lastNow.toFixed(3)],
    ["scheduled in past", String(probe.scheduledInPast), probe.scheduledInPast > 0],
    ["chunks scheduled", String(probe.chunksScheduled)],
    ["nodes alive", String(probe.nodesAlive)],
    ["gain at destination", Number.isFinite(gain) ? gain.toFixed(3) : "no gain node", gain !== 1],
    ["buffer peak", `${probe.lastBufferPeak.toFixed(3)} (max ${probe.maxBufferPeak.toFixed(3)})`, probe.maxBufferPeak < 0.01],
    ["output level", outputDb === -Infinity ? "SILENT" : `${outputDb.toFixed(1)} dB`, outputDb < -60],
    ["ui state", state],
    ["playhead", track ? `${(pos / track.info.sampleRate).toFixed(2)} s` : "—"],
    ["rendered", track ? `${(track.filled / track.info.sampleRate).toFixed(1)} s` : "—"],
    ["scheduled to", track ? `${(scheduledSamples / track.info.sampleRate).toFixed(1)} s` : "—"],
  ];
  rows.innerHTML = data
    .map(
      ([k, v, bad]) =>
        `<tr><td>${k}</td><td class="${bad ? "bad" : ""}">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
}

window.addEventListener("hashchange", () => {
  if (debugEnabled()) buildDebug();
  else {
    const p = document.getElementById("debugpanel");
    if (p) {
      p.remove();
      window.clearInterval(debugTimer);
    }
  }
});

// ------------------------------------------------------------------ boot ---

readHash();
// A shared link carries the whole track in eight characters, so following one
// should land on that track rather than on an empty page with the seed typed
// in. Rendering starts; playback still waits for a tap, as it must.
const arrivedWithSeed = seed !== "";
if (!seed) seed = newSeed();
elSeed.value = seed;
buildWords();
buildDebug();
setState("idle");
drawScope();
if (arrivedWithSeed) generate();

elGenerate.addEventListener("click", () => {
  // Synchronously, while the gesture is still live: iOS will not start a
  // context later, and "later" is where progressive playback lives.
  unlockAudio();
  // REROLL is now the only generate action, so it has to draw the new seed
  // that the deleted dice icon used to draw. The first press plays whatever
  // seed the URL or the boot gave us; every press after that is "another one".
  if (track) {
    seed = newSeed();
    animateSeed(seed);
  }
  generate();
});
elPlay.addEventListener("click", togglePlay);

// The seed is an input, not a readout. Typing or pasting one and pressing
// enter reproduces someone else's track exactly, which is the whole point of
// a seed and was previously only reachable by editing the URL.
elSeed.addEventListener("change", () => {
  const v = normaliseSeedInput(elSeed.value);
  if (v.length >= 3) {
    seed = v;
    elSeed.value = v;
    writeHash();
    unlockAudio();
    generate();
  } else {
    elSeed.value = seed;
  }
});
elSeed.addEventListener("focus", () => elSeed.select());

elShare.addEventListener("click", () => {
  void shareSeed();
});
elRetry.addEventListener("click", () => {
  seed = newSeed();
  animateSeed(seed);
  unlockAudio();
  generate();
});
elTech.addEventListener("toggle", () => {
  drawScope(track ? currentSample() : -1);
});
elWav.addEventListener("click", () => {
  elDlMenu.open = false;
  downloadWav();
});
elStems.addEventListener("click", () => {
  elDlMenu.open = false;
  requestStems();
});
// a menu that stays open over the thing it acted on is a menu in the way
document.addEventListener("click", (e) => {
  if (elDlMenu.open && !elDlMenu.contains(e.target as Node)) elDlMenu.open = false;
});

window.addEventListener("resize", () => {
  drawScope(track ? currentSample() : -1);
  // the lane strips are canvases too, and a zero-width first layout leaves
  // them empty until something asks them to redraw
  if (track) for (const bus of track.info.buses) drawLane(bus, track.info);
});

// A7: coming back from a lock screen or another app. Resuming may need a fresh
// gesture, in which case say so rather than pretending to play.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !ctx || !track) return;
  if (ctx.state === "running") return;
  void ctx.resume().then(
    () => {
      if (ctx && ctx.state === "running" && needsGesture && state === "blocked") {
        void beginPlayback(anchorSample);
      }
    },
    () => {
      needsGesture = true;
      setState("blocked");
    },
  );
});
window.addEventListener("hashchange", () => {
  const was = seed;
  readHash();
  elSeed.value = seed;
  // A hash change is someone arriving on a shared link while the page is
  // already open. Updating the field without rendering would leave the seed
  // and the audio disagreeing, which is the one thing a seed must never do.
  if (seed !== was) generate();
});

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    unlockAudio();
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
