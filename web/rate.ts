/**
 * The rating screen.
 *
 * Built for a phone, at work, in interrupted four-minute sessions. Everything
 * here follows from that:
 *
 *  - a rating is written to localStorage the instant it is tapped, and only
 *    then queued for the network. Rating must never wait on a request, because
 *    work wifi drops and lifts happen. localStorage is the queue, not storage.
 *  - the order is shuffled per session and nothing identifying is on screen,
 *    because a rater who can see a high drive value rates what they expect.
 *  - the Media Session API is wired, because the phone goes in a pocket.
 *  - position is saved on every tap, so closing the tab loses nothing.
 */

const WORKER = "https://nullsample-rate.maqsudjon-polatov.workers.dev";
const AXES_PASS1 = ["hook", "punch", "space"] as const;
const AXES_PASS2 = ["interest"] as const;
/** A track has to score at least this on the pass-1 mean to be worth pass 2. */
const PASS2_THRESHOLD = 3;

type Axis = "hook" | "punch" | "space" | "interest";

interface RateTrack {
  id: string;
  seed: string;
  excerpt: string;
  full: string;
  repeatOf?: string;
  explore: boolean;
}
interface Manifest {
  batchId: string;
  /** "drums": one short loop per entry, rated in a single pass */
  kind?: "tracks" | "drums";
  preset: string;
  rangesVersion: number;
  createdAt: string;
  tracks: RateTrack[];
}
interface Rating {
  batchId: string;
  trackId: string;
  pass: 1 | 2;
  scores: Partial<Record<Axis, number>>;
  skipped: boolean;
  session: string;
  synced: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode: the session still works, it just cannot resume */
    }
  },
};

/** Deterministic shuffle, so a session's order is stable across a reload. */
function shuffle<T>(items: readonly T[], seed: string): T[] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const next = () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// --- state -----------------------------------------------------------------

let manifest: Manifest | undefined;
let queue: { track: RateTrack; pass: 1 | 2 }[] = [];
let index = 0;
let scores: Partial<Record<Axis, number>> = {};
let sessionId = "";
let audio: HTMLAudioElement | undefined;
let preloader: HTMLAudioElement | undefined;
let syncKey = "";
/** playback position to resume at, set once from the saved position */
let resumeAt = 0;

const KEY_KEY = "ns.rate.key";
const POS_KEY = "ns.rate.pos";
const OUT_KEY = "ns.rate.out";
const SESSION_KEY = "ns.rate.session";

function outbox(): Rating[] {
  return store.get<Rating[]>(OUT_KEY, []);
}
function setOutbox(v: Rating[]): void {
  store.set(OUT_KEY, v);
  const unsent = v.filter((r) => !r.synced).length;
  const el = $("queue");
  el.hidden = unsent === 0;
  el.textContent = `${unsent} unsent`;
}

/** Writes locally first, then tries the network. Never blocks the rater. */
function record(r: Rating): void {
  const all = outbox().filter((x) => !(x.trackId === r.trackId && x.pass === r.pass));
  all.push(r);
  setOutbox(all);
  void flush();
}

let flushing = false;
async function flush(): Promise<void> {
  if (flushing || !syncKey) return;
  flushing = true;
  try {
    const all = outbox();
    for (const r of all) {
      if (r.synced) continue;
      try {
        const res = await fetch(`${WORKER}/r`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-rate-key": syncKey },
          body: JSON.stringify({
            batchId: r.batchId, trackId: r.trackId, pass: r.pass,
            scores: r.scores, skipped: r.skipped, session: r.session,
          }),
        });
        if (!res.ok) break;
        r.synced = true;
      } catch {
        break; // offline: stays queued, retried on the next tap
      }
    }
    setOutbox(all);
  } finally {
    flushing = false;
  }
}

// --- waveform --------------------------------------------------------------

function drawWave(progress: number): void {
  const c = $("wave") as unknown as HTMLCanvasElement;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth || 360;
  const h = 150;
  if (c.width !== Math.round(w * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  ctx.strokeStyle = "#2A303A";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
  const x = w * Math.min(1, Math.max(0, progress));
  ctx.strokeStyle = "#FF6A1A";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 12);
  ctx.lineTo(x, h - 12);
  ctx.stroke();
}

// --- flow ------------------------------------------------------------------

function buildQueue(m: Manifest, pass2Ids: Set<string>): void {
  const order = shuffle(m.tracks, `${m.batchId}:${sessionId}`);
  queue = order.map((t) => ({ track: t, pass: 1 as const }));
  const p2 = order.filter((t) => pass2Ids.has(t.id));
  for (const t of p2) queue.push({ track: t, pass: 2 as const });
}

/**
 * A drum loop is judged in one pass: the whole thing is the excerpt. The axis
 * keys are the track ones, so narrow and tune correlate them unchanged; only
 * the questions change, because "can you hum it" means nothing for a loop.
 */
const DRUM_AXES = ["punch", "space", "interest"] as const;
const DRUM_QUESTIONS: Record<string, string> = {
  punch: "Does it hit?",
  space: "Can you hear each drum?",
  interest: "Would you loop it?",
};
const isDrums = () => manifest?.kind === "drums";

function currentAxes(): readonly Axis[] {
  if (isDrums()) return DRUM_AXES;
  return queue[index]?.pass === 2 ? AXES_PASS2 : AXES_PASS1;
}

function renderAxes(): void {
  const form = $("axes");
  const axes = currentAxes();
  if (isDrums()) {
    for (const fs of Array.from(form.querySelectorAll("fieldset"))) {
      const axis = fs.getAttribute("data-axis") ?? "";
      const q = DRUM_QUESTIONS[axis];
      const legend = fs.querySelector("legend");
      if (q && legend && legend.textContent !== q) {
        legend.textContent = q;
        fs.querySelector(".rate-row")?.setAttribute("aria-label", q);
      }
    }
  }
  for (const fs of Array.from(form.querySelectorAll("fieldset"))) {
    const axis = fs.getAttribute("data-axis") as Axis;
    fs.hidden = !axes.includes(axis);
    const row = fs.querySelector(".rate-row") as HTMLElement;
    if (row.children.length === 0) {
      for (let n = 1; n <= 5; n++) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "rate-score";
        b.textContent = String(n);
        b.setAttribute("aria-label", `${axis} ${n} of 5`);
        b.addEventListener("click", () => setScore(axis, n));
        row.appendChild(b);
      }
    }
    for (const child of Array.from(row.children)) {
      child.classList.toggle("on", scores[axis] === Number(child.textContent));
    }
  }
}

function setScore(axis: Axis, n: number): void {
  scores[axis] = n;
  renderAxes();
  const axes = currentAxes();
  if (axes.every((a) => scores[a] !== undefined)) advance(false);
}

function meanPass1(t: RateTrack): number {
  const r = outbox().find((x) => x.trackId === t.id && x.pass === 1);
  if (!r || r.skipped) return 0;
  const vals = AXES_PASS1.map((a) => r.scores[a] ?? 0);
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function advance(skipped: boolean): void {
  const entry = queue[index];
  if (!entry || !manifest) return;
  record({
    batchId: manifest.batchId,
    trackId: entry.track.id,
    pass: entry.pass,
    scores: skipped ? {} : { ...scores },
    skipped,
    session: sessionId,
    synced: false,
  });

  // the seed appears only after every axis is in, and only briefly
  $("reveal").textContent = entry.track.seed;
  setTimeout(() => { $("reveal").textContent = ""; }, 1400);

  scores = {};
  index++;
  store.set(POS_KEY, { batchId: manifest.batchId, index, sessionId, at: 0 });

  if (index === manifest.tracks.length && !isDrums()) {
    // pass 1 is done: rebuild the tail from what scored well
    const keep = new Set(manifest.tracks.filter((t) => meanPass1(t) >= PASS2_THRESHOLD).map((t) => t.id));
    const head = queue.slice(0, index);
    buildQueue(manifest, keep);
    queue = head.concat(queue.slice(manifest.tracks.length));
  }
  play();
}

function play(): void {
  const entry = queue[index];
  if (!entry || !manifest) {
    finish();
    return;
  }
  $("progress").textContent = `${index + 1} / ${queue.length}`;
  const src = `/rate/batch/${entry.pass === 2 ? entry.track.full : entry.track.excerpt}`;
  if (!audio) audio = new Audio();
  audio.src = src;
  audio.preload = "auto";
  // Resume mid-track, not just mid-batch: a two-minute pass-2 track
  // interrupted at 1:40 should not start again from the beginning.
  if (resumeAt > 0) {
    const at = resumeAt;
    resumeAt = 0;
    const seek = () => {
      audio!.currentTime = Math.min(at, Math.max(0, (audio!.duration || at) - 1));
      audio!.removeEventListener("loadedmetadata", seek);
    };
    audio.addEventListener("loadedmetadata", seek);
  }
  audio.play().catch(() => { /* a tap will start it */ });
  renderAxes();
  $("axes").hidden = false;

  // only the next one, never the batch
  const next = queue[index + 1];
  if (next) {
    if (!preloader) preloader = new Audio();
    preloader.preload = "auto";
    preloader.src = `/rate/batch/${next.pass === 2 ? next.track.full : next.track.excerpt}`;
  }

  // Lock-screen transport. The phone goes in a pocket between tracks, and
  // without this the only way to pause is to unlock and find the tab.
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `Track ${index + 1} of ${queue.length}`,
        artist: "Nullsample",
        album: "rating",
      });
      navigator.mediaSession.setActionHandler("play", () => void audio?.play());
      navigator.mediaSession.setActionHandler("pause", () => audio?.pause());
      navigator.mediaSession.setActionHandler("nexttrack", () => advance(true));
    } catch {
      /* older WebKit: transport is a convenience, not a requirement */
    }
  }
}

function finish(): void {
  $("axes").hidden = true;
  $("done").hidden = false;
  $("done").textContent = "That is the batch. Thank you.";
  void flush();
}

let lastSaved = 0;
function tick(): void {
  if (audio && audio.duration > 0) {
    drawWave(audio.currentTime / audio.duration);
    // once a second is often enough to lose nothing worth noticing
    const now = Date.now();
    if (manifest && now - lastSaved > 1000) {
      lastSaved = now;
      store.set(POS_KEY, { batchId: manifest.batchId, index, sessionId, at: audio.currentTime });
    }
  }
  requestAnimationFrame(tick);
}

// --- start -----------------------------------------------------------------

async function main(): Promise<void> {
  syncKey = store.get<string>(KEY_KEY, "");
  if (!syncKey) $("key").hidden = false;
  $("keysave").addEventListener("click", () => {
    const v = ($("keyin") as HTMLInputElement).value.trim();
    if (!v) return;
    syncKey = v;
    store.set(KEY_KEY, v);
    $("key").hidden = true;
    void flush();
  });

  setOutbox(outbox());

  try {
    manifest = await (await fetch("/rate/batch/manifest.json", { cache: "no-cache" })).json();
  } catch {
    $("done").hidden = false;
    $("done").textContent = "No batch published yet.";
    return;
  }
  if (!manifest) return;

  const saved = store.get<{ batchId: string; index: number; sessionId: string; at?: number }>(POS_KEY, {
    batchId: "", index: 0, sessionId: "", at: 0,
  });
  const resuming = saved.batchId === manifest.batchId;
  if (resuming && typeof saved.at === "number") resumeAt = saved.at;
  sessionId = resuming && saved.sessionId
    ? saved.sessionId
    : `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  store.set(SESSION_KEY, sessionId);

  const keep = new Set(manifest.tracks.filter((t) => meanPass1(t) >= PASS2_THRESHOLD).map((t) => t.id));
  buildQueue(manifest, keep);
  index = resuming ? Math.min(saved.index, queue.length) : 0;

  $("start").addEventListener("click", () => {
    // One gesture unlocks audio for the whole session. `playback` also makes
    // audio survive the silent switch on iOS 16.4+, which matters here because
    // the phone lives on silent at work.
    if ("audioSession" in navigator) {
      (navigator as unknown as { audioSession: { type: string } }).audioSession.type = "playback";
    }
    $("gate").hidden = true;
    play();
  });
  $("skip").addEventListener("click", () => advance(true));

  document.addEventListener("keydown", (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= 5) {
      const axes = currentAxes();
      const pending = axes.find((a) => scores[a] === undefined);
      if (pending) setScore(pending, n);
    } else if (e.key === " ") {
      e.preventDefault();
      advance(true);
    }
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) void flush(); });
  window.addEventListener("online", () => void flush());
  requestAnimationFrame(tick);
}

void main();

export {};
