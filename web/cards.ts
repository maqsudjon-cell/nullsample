/**
 * The demonstration cards.
 *
 * Every shape drawn here is real engine output, computed at build time. Canvas
 * rather than SVG: measured at 0.2 ms per frame for four cards against 0.8 ms
 * for SVG, with a worst case of 0.6 ms against 3.6 ms. On a mid-range phone
 * the SVG worst case would drop frames.
 *
 * One shared animation loop drives only the cards currently on screen. Four
 * independent loops would drain a battery and cost the performance budget.
 */

export interface Shape {
  at?: number;
  label: string;
  wave: number[];
}

export interface CardData {
  fromNothing: { file: string; duration: number; shapes: Shape[] };
  destruction: { file: string; duration: number; stageSeconds: number; shapes: Shape[] };
  bass808: {
    file: string;
    duration: number;
    dropSemitones: number;
    dropMs: number;
    pitch: number[];
    envelope: number[];
  };
  sixParts: { seed: string; duration: number; lanes: { name: string; file: string; peaks: number[] }[] };
}

interface Card {
  el: HTMLCanvasElement;
  draw: (t: number, progress: number) => void;
  visible: boolean;
  audio: HTMLAudioElement | null;
}

const cards: Card[] = [];
let raf = 0;
let reduced = false;

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Sizes the backing store and returns a context in CSS pixels. */
function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w === 0 || h === 0) return null;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}

/** A waveform as a filled shape around the centre line. */
function strokeWave(
  g: CanvasRenderingContext2D,
  wave: number[],
  w: number,
  h: number,
  colour: string,
  amp = 1,
): void {
  const mid = h / 2;
  const scale = (h / 2 - 8) * amp;
  g.strokeStyle = colour;
  g.lineWidth = 1.5;
  g.lineJoin = "round";
  g.beginPath();
  for (let i = 0; i < wave.length; i++) {
    const x = (i / (wave.length - 1)) * w;
    const y = mid - wave[i] * scale;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

function baseline(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.strokeStyle = css("--line");
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, Math.round(h / 2) + 0.5);
  g.lineTo(w, Math.round(h / 2) + 0.5);
  g.stroke();
}

function lerpWave(a: number[], b: number[], k: number): number[] {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * k;
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Nothing is painted inside a canvas but the signal.
 *
 * Text over a moving line is unreadable and it looks unfinished, so every label
 * that used to be drawn into a card now lives in the DOM around it - which also
 * means it can be selected, translated and read by a screen reader.
 */
function setLabel(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

/** Card 1 — silence becoming a sine becoming a saw becoming seven. */
function drawFromNothing(c: HTMLCanvasElement, d: CardData["fromNothing"], t: number, progress: number) {
  const g = ctx2d(c);
  if (!g) return;
  const w = c.clientWidth;
  const h = c.clientHeight;
  baseline(g, w, h);
  const cycle = d.duration;
  const time = progress > 0 ? progress * cycle : (t / 1000) % cycle;
  const shapes = d.shapes;
  let i = 0;
  for (let k = 0; k < shapes.length; k++) if (time >= (shapes[k].at ?? 0)) i = k;
  const from = shapes[i];
  const to = shapes[Math.min(shapes.length - 1, i + 1)];
  const span = (to.at ?? cycle) - (from.at ?? 0);
  const k = span > 0 ? Math.min(1, Math.max(0, (time - (from.at ?? 0)) / Math.min(span, 0.7))) : 1;
  const wave = from === to ? from.wave : lerpWave(from.wave, to.wave, k);
  strokeWave(g, wave, w, h, progress > 0 ? css("--flare") : css("--text"));
  setLabel("lab-nothing", k > 0.5 ? to.label : from.label);
}

/** The stage names, in a row beneath the canvas, one per stage column. */
function paintStageRow(d: CardData["destruction"], active: number): void {
  const host = document.getElementById("lab-dist");
  if (!host) return;
  if (host.children.length !== d.shapes.length) {
    host.innerHTML = d.shapes.map((sh) => `<span>${sh.label}</span>`).join("");
    host.style.gridTemplateColumns = `repeat(${d.shapes.length}, 1fr)`;
  }
  for (let i = 0; i < d.shapes.length; i++) {
    (host.children[i] as HTMLElement).dataset.active = String(i === active);
  }
}

/** Card 2 — one cycle flattening through the three stages. */
function drawDestruction(c: HTMLCanvasElement, d: CardData["destruction"], t: number, progress: number) {
  const g = ctx2d(c);
  if (!g) return;
  const w = c.clientWidth;
  const h = c.clientHeight;
  const n = d.shapes.length;
  const cw = w / n;
  const active = progress > 0 ? Math.min(n - 1, Math.floor((progress * d.duration) / d.stageSeconds)) : -1;
  paintStageRow(d, active);
  for (let i = 0; i < n; i++) {
    g.save();
    g.beginPath();
    g.rect(i * cw, 0, cw, h);
    g.clip();
    g.translate(i * cw, 0);
    g.strokeStyle = css("--line");
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, Math.round(h / 2) + 0.5);
    g.lineTo(cw, Math.round(h / 2) + 0.5);
    g.stroke();
    strokeWave(g, d.shapes[i].wave, cw - 14, h, i === active ? css("--flare") : css("--text"));
    g.restore();
    if (i > 0) {
      g.strokeStyle = css("--line");
      g.beginPath();
      g.moveTo(Math.round(i * cw) + 0.5, 8);
      g.lineTo(Math.round(i * cw) + 0.5, h - 8);
      g.stroke();
    }
  }
}

/** Card 3 — the pitch bending down into the note. */
function draw808(c: HTMLCanvasElement, d: CardData["bass808"], t: number, progress: number) {
  const g = ctx2d(c);
  if (!g) return;
  const w = c.clientWidth;
  const h = c.clientHeight;
  const cycle = 3.4;
  const time = progress > 0 ? progress * d.duration : ((t / 1000) % cycle) * (d.duration / cycle);
  const shown = Math.max(0.001, Math.min(1, time / d.duration));

  // envelope beneath
  const env = d.envelope;
  const mid = h * 0.66;
  g.fillStyle = css("--line-hi");
  const upto = Math.floor(env.length * shown);
  for (let i = 0; i < upto; i++) {
    const x = (i / (env.length - 1)) * w;
    const a = env[i] * (h * 0.3);
    g.fillRect(x, mid - a, Math.max(1, w / env.length - 0.5), a * 2);
  }
  // pitch curve on top
  g.strokeStyle = css("--flare");
  g.lineWidth = 2;
  g.beginPath();
  const top = h * 0.14;
  for (let i = 0; i < Math.max(2, Math.floor(d.pitch.length * shown)); i++) {
    const x = (i / (d.pitch.length - 1)) * w;
    const y = mid - (d.pitch[i] / d.dropSemitones) * (mid - top);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  setLabel("lab-b808", `+${d.dropSemitones} semitones in ${d.dropMs} ms`);
}

/** Card 4 — one waveform sliding apart into six. */
/**
 * The six lane names, beside the canvas rather than inside it, each aligned to
 * its lane by flex order. They fade in with the split so the merged state still
 * reads as one waveform.
 */
function paintLaneLabels(d: CardData["sixParts"], playing: number, hover: number, split: number): void {
  const host = document.getElementById("lab-parts");
  if (!host) return;
  if (host.children.length !== d.lanes.length) {
    host.innerHTML = d.lanes
      .map((l) => `<span>${l.name === "bass808" ? "808" : l.name}</span>`)
      .join("");
  }
  host.style.opacity = split.toFixed(2);
  for (let i = 0; i < d.lanes.length; i++) {
    const el = host.children[i] as HTMLElement;
    el.dataset.active = String(i === playing || i === hover);
  }
}

function drawSixParts(
  c: HTMLCanvasElement,
  d: CardData["sixParts"],
  t: number,
  progress: number,
  hover: number,
  playing: number,
) {
  const g = ctx2d(c);
  if (!g) return;
  const w = c.clientWidth;
  const h = c.clientHeight;
  const n = d.lanes.length;
  const laneH = h / n;
  // 0 = merged into one, 1 = fully separated
  const split = progress > 0 || hover >= 0 || playing >= 0 ? 1 : Math.min(1, Math.max(0, ((t / 1000) % 6) / 2 - 0.15));
  paintLaneLabels(d, playing, hover, split);
  for (let i = 0; i < n; i++) {
    const lane = d.lanes[i];
    const merged = h / 2;
    const target = laneH * (i + 0.5);
    const y = merged + (target - merged) * split;
    const active = i === playing || i === hover;
    g.fillStyle = active ? css("--flare") : css("--line-hi");
    const peaks = lane.peaks;
    const bw = w / peaks.length;
    for (let k = 0; k < peaks.length; k++) {
      const a = Math.max(0.6, peaks[k] * (laneH * 0.42) * (0.35 + 0.65 * split));
      g.fillRect(k * bw, y - a, Math.max(1, bw - 0.4), a * 2);
    }
  }
}

// ---------------------------------------------------------------------------

export function mountCards(root: HTMLElement, data: CardData, onPlay: (name: string) => void): void {
  reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The markup is static in the page, so the cards occupy their space from
  // first paint. Building it here shifted the layout by 0.159 CLS when the
  // dataset arrived.
  const stemAudio = data.sixParts.lanes.map((l) => {
    const a = new Audio(`/demos/${l.file}`);
    a.preload = "none";
    return a;
  });
  let hoverLane = -1;
  let playingLane = -1;

  const audioFor = (id: string) => document.getElementById(`aud-${id}`) as HTMLAudioElement | null;

  const register = (id: string, draw: (t: number, p: number) => void) => {
    const el = document.getElementById(`art-${id}`) as HTMLCanvasElement;
    const card: Card = { el, draw, visible: false, audio: audioFor(id) };
    cards.push(card);
    return card;
  };

  register("nothing", (t, p) => drawFromNothing(document.getElementById("art-nothing") as HTMLCanvasElement, data.fromNothing, t, p));
  register("dist", (t, p) => drawDestruction(document.getElementById("art-dist") as HTMLCanvasElement, data.destruction, t, p));
  register("b808", (t, p) => draw808(document.getElementById("art-b808") as HTMLCanvasElement, data.bass808, t, p));
  register("parts", (t, p) =>
    drawSixParts(document.getElementById("art-parts") as HTMLCanvasElement, data.sixParts, t, p, hoverLane, playingLane),
  );

  // Only animate what is on screen. Four always-running loops would drain a
  // phone battery for cards nobody is looking at.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const card = cards.find((c) => c.el === e.target);
        if (card) card.visible = e.isIntersecting;
      }
      if (cards.some((c) => c.visible)) start();
      else stop();
    },
    { rootMargin: "80px" },
  );
  for (const c of cards) io.observe(c.el);

  // --- audio ------------------------------------------------------------
  const stopAll = (except?: HTMLAudioElement) => {
    for (const c of cards) {
      if (c.audio && c.audio !== except) {
        c.audio.pause();
        c.audio.currentTime = 0;
      }
    }
    for (const a of stemAudio) {
      if (a !== except) {
        a.pause();
        a.currentTime = 0;
      }
    }
    if (!except) playingLane = -1;
  };
  (window as unknown as { nullsampleStopCards: () => void }).nullsampleStopCards = () => stopAll();

  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>(".cardplay"))) {
    const id = b.dataset.card ?? "";
    const a = audioFor(id);
    if (!a) continue;
    b.addEventListener("click", () => {
      if (!a.paused) {
        a.pause();
        return;
      }
      stopAll(a);
      onPlay("card sample played");
      void a.play().catch(() => undefined);
    });
    a.addEventListener("play", () => {
      b.innerHTML = "&#9646;&#9646;";
    });
    const off = () => {
      b.innerHTML = "&#9654;";
    };
    a.addEventListener("pause", off);
    a.addEventListener("ended", off);
  }

  // tap a lane to hear only that part
  const partsCanvas = document.getElementById("art-parts") as HTMLCanvasElement;
  const laneAt = (ev: MouseEvent | TouchEvent) => {
    const r = partsCanvas.getBoundingClientRect();
    const y = "touches" in ev ? ev.touches[0].clientY - r.top : (ev as MouseEvent).clientY - r.top;
    return Math.max(0, Math.min(data.sixParts.lanes.length - 1, Math.floor((y / r.height) * data.sixParts.lanes.length)));
  };
  partsCanvas.addEventListener("mousemove", (e) => {
    hoverLane = laneAt(e);
  });
  partsCanvas.addEventListener("mouseleave", () => {
    hoverLane = -1;
  });
  partsCanvas.addEventListener("click", (e) => {
    const i = laneAt(e);
    const a = stemAudio[i];
    if (!a.paused) {
      a.pause();
      playingLane = -1;
      return;
    }
    stopAll(a);
    playingLane = i;
    onPlay("stem sample played");
    void a.play().catch(() => undefined);
    a.onended = () => {
      playingLane = -1;
    };
  });
  partsCanvas.style.cursor = "pointer";

  // reduced motion: draw the finished state once, leave the buttons working
  if (reduced) {
    for (const c of cards) c.draw(9_999_999, 0);
    return;
  }
  start();
}

function frame(t: number): void {
  for (const c of cards) {
    if (!c.visible) continue;
    const a = c.audio;
    const p = a && !a.paused && a.duration ? a.currentTime / a.duration : 0;
    c.draw(t, p);
  }
  raf = requestAnimationFrame(frame);
}

function start(): void {
  if (raf || reduced) return;
  raf = requestAnimationFrame(frame);
}

function stop(): void {
  if (!raf) return;
  cancelAnimationFrame(raf);
  raf = 0;
}

export function redrawCards(): void {
  for (const c of cards) c.draw(performance.now(), 0);
}
