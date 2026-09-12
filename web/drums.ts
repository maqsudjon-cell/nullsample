/**
 * /drums - loops, one-shots and MIDI from the drums bus.
 *
 * The complexity is in the engine; the page is one screenful. Tempo, length,
 * three word sliders, and a lane per voice group with the same keep and solo
 * language as /generate. Nothing else, deliberately.
 */

import type { FromDrumWorker, ToDrumWorker, DrumRequest } from "./drums-worker.ts";

type Group = "kick" | "snare" | "hats" | "perc";
const GROUPS: readonly Group[] = ["kick", "snare", "hats", "perc"];
const LABEL: Record<Group, string> = { kick: "kick", snare: "snare", hats: "hats", perc: "perc" };
const SEED_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ state -

let seed = "";
let bpm = 150;
let bars: 4 | 8 | 16 = 8;
const words = { harder: 0.3, busier: 0.5, dirtier: 0.2 };
const keepKit: Partial<Record<Group, string>> = {};
let keepPattern: string | undefined;
let gen = 0;
let hasLoop = false;

/** The full loop, and any groups auditioned alone - cached per render. */
const buffers = new Map<string, AudioBuffer>();
/**
 * Solo: which group is being auditioned, or null for the full loop.
 *
 * AUDITION ONLY. Downloads always carry the whole loop, the whole kit and the
 * whole pattern; the worker's export path does not accept `only` at all. Do not
 * wire solo into an export or a share link.
 */
let solo: Group | null = null;

let ctx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let startedAt = 0;
let raf = 0;
let worker: Worker | null = null;

// ------------------------------------------------------------------- seed -

function newSeed(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < 8; i++) s += SEED_ALPHABET[b[i] % SEED_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function normaliseSeedInput(raw: string): string {
  const c = raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
  return /^[A-Z0-9]{8}$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4)}` : c.replace(/^-+|-+$/g, "");
}

function readHash(): boolean {
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const s = h.get("s");
  const b = Number(h.get("bpm"));
  const n = Number(h.get("bars"));
  if (Number.isFinite(b) && b >= 80 && b <= 180) bpm = Math.round(b);
  if (n === 4 || n === 8 || n === 16) bars = n;
  if (s) {
    seed = normaliseSeedInput(s);
    return true;
  }
  return false;
}

function writeHash(): void {
  const h = new URLSearchParams();
  h.set("s", seed);
  h.set("bpm", String(bpm));
  h.set("bars", String(bars));
  history.replaceState(null, "", `#${h.toString()}`);
}

// ---------------------------------------------------------------- worker -

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker("/drums/drums-worker.js", { type: "module" });
    worker.onmessage = (e: MessageEvent<FromDrumWorker>) => onMessage(e.data);
  }
  return worker;
}

function request(): DrumRequest {
  return { gen, seed, bpm, bars, words: { ...words }, keepKit: { ...keepKit }, keepPattern };
}

function send(msg: ToDrumWorker): void {
  ensureWorker().postMessage(msg);
}

function onMessage(msg: FromDrumWorker): void {
  if (msg.gen !== gen) return; // a superseded render
  if (msg.type === "error") {
    $("problem").hidden = false;
    $("problemtext").textContent = msg.message;
    setLabel("");
    return;
  }
  if (msg.type === "loop") {
    const ac = audio();
    const n = msg.left.byteLength / 4;
    const buf = ac.createBuffer(2, n, msg.sampleRate);
    buf.copyToChannel(new Float32Array(msg.left) as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(new Float32Array(msg.right) as Float32Array<ArrayBuffer>, 1);
    buffers.set(msg.only ?? "full", buf);
    if (!msg.only) {
      hasLoop = true;
      firstHit = msg.firstHit ?? {};
      for (const id of ["dl-wav", "dl-kit", "dl-midi"]) ($(id) as HTMLButtonElement).disabled = false;
      ($("play") as HTMLButtonElement).disabled = false;
      $("generate").textContent = "REROLL";
      drawScope(buf);
      showHintOnce();
    }
    // play whichever buffer the audition currently wants
    const want = solo ?? "full";
    if ((msg.only ?? "full") === want) {
      setLabel("");
      play(buf);
    }
    return;
  }
  if (msg.type === "export") {
    const mime = msg.what === "wav" ? "audio/wav" : msg.what === "midi" ? "audio/midi" : "application/zip";
    const blob = new Blob([msg.bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = msg.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setLabel("");
  }
}

// ----------------------------------------------------------------- audio -

function audio(): AudioContext {
  if (!ctx) {
    const nav = navigator as unknown as { audioSession?: { type: string } };
    if (nav.audioSession) {
      try {
        nav.audioSession.type = "playback";
      } catch {
        /* unsupported value: carry on */
      }
    }
    const Ctor = window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ latencyHint: "playback" });
  }
  void ctx.resume();
  return ctx;
}

/**
 * Plays a loop with `loop = true`. Web Audio loops a buffer sample-accurately,
 * and the renderer made the buffer seamless, so there is nothing to schedule.
 * Switching buffers keeps the position within the loop, so soloing a part
 * lands on the same beat you were hearing.
 */
function play(buf: AudioBuffer): void {
  const ac = audio();
  let offset = 0;
  if (source) {
    const len = source.buffer ? source.buffer.duration : buf.duration;
    offset = len > 0 ? (ac.currentTime - startedAt) % len : 0;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
  }
  const s = ac.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.connect(ac.destination);
  s.start(0, offset);
  startedAt = ac.currentTime - offset;
  source = s;
  $("play").textContent = "▮▮";
  $("play").setAttribute("aria-label", "Pause");
  startClock();
}

function stop(): void {
  if (source) {
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source = null;
  }
  $("play").textContent = "▶";
  $("play").setAttribute("aria-label", "Play");
  cancelAnimationFrame(raf);
  drawScope(buffers.get(solo ?? "full") ?? null, -1);
}

// ------------------------------------------------------------- generate -

function generate(fresh: boolean): void {
  if (fresh) seed = newSeed();
  ($("seed") as HTMLInputElement).value = seed;
  gen++;
  buffers.clear();
  solo = null;
  $("problem").hidden = true;
  setLabel("building…");
  writeHash();
  renderLanes();
  send({ type: "loop", ...request() });
}

function setLabel(t: string): void {
  $("statelabel").textContent = t;
  $("loopinfo").textContent = `${bpm} BPM · ${bars} bars`;
}

// ----------------------------------------------------------------- lanes -

const HINT_KEY = "ns.drums.kept";

function showHintOnce(): void {
  let learned = false;
  try {
    learned = localStorage.getItem(HINT_KEY) === "1";
  } catch {
    learned = false;
  }
  $("hint").hidden = learned;
}

function renderLanes(): void {
  const rows = GROUPS.map((g) => {
    const kept = keepKit[g] !== undefined;
    const soloed = solo === g;
    const muted = solo !== null && !soloed;
    return `<div class="lane" data-group="${g}" data-keep="${kept}" data-solo="${soloed}" data-muted="${muted}">
      <button type="button" class="lane-solo" data-group="${g}" aria-pressed="${soloed}"
        aria-label="Hear ${LABEL[g]} on its own"><span class="name">${LABEL[g]}</span><span class="lanefill" aria-hidden="true"></span></button>
      <button type="button" class="lane-keep" data-group="${g}" aria-pressed="${kept}"
        aria-label="Keep the ${LABEL[g]} sound when you reroll"><span class="keepmark">${kept ? "keeping" : "keep"}</span></button>
    </div>`;
  });
  // The pattern is its own axis: keep it and reroll to change only the kit.
  const pk = keepPattern !== undefined;
  rows.push(`<div class="lane lane-pattern" data-keep="${pk}">
    <span class="lane-solo lane-static"><span class="name">pattern</span><span class="lanefill" aria-hidden="true"></span></span>
    <button type="button" class="lane-keep" data-group="pattern" aria-pressed="${pk}"
      aria-label="Keep the pattern when you reroll, and change only the sounds"><span class="keepmark">${pk ? "keeping" : "keep"}</span></button>
  </div>`);
  $("lanes").innerHTML = rows.join("");
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".lane-keep"))) {
    b.addEventListener("click", () => toggleKeep(b.dataset.group ?? ""));
  }
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button.lane-solo"))) {
    b.addEventListener("click", () => toggleSolo(b.dataset.group as Group));
  }
}

function toggleKeep(g: string): void {
  if (g === "pattern") {
    keepPattern = keepPattern === undefined ? seed : undefined;
  } else {
    const grp = g as Group;
    if (keepKit[grp] !== undefined) delete keepKit[grp];
    else keepKit[grp] = seed;
  }
  $("hint").hidden = true;
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    /* private mode */
  }
  renderLanes();
}

function toggleSolo(g: Group): void {
  if (!hasLoop) return;
  solo = solo === g ? null : g;
  renderLanes();
  const want = solo ?? "full";
  const cached = buffers.get(want);
  if (cached) {
    play(cached);
    return;
  }
  // not rendered yet: the loop is short, so a whole render is ~250-700 ms
  setLabel("building…");
  send({ type: "loop", ...request(), only: g });
}

// ------------------------------------------------------------- one-shots -

const VOICES = ["kick", "snare", "clap", "hatClosed", "hatOpen", "rim", "tom"] as const;
const VOICE_LABEL: Record<string, string> = {
  kick: "kick", snare: "snare", clap: "clap", hatClosed: "closed hat",
  hatOpen: "open hat", rim: "rim", tom: "tom",
};

/** Where each voice first hits, as a fraction of the loop. */
let firstHit: Record<string, number> = {};

/**
 * The one-shot rows come out of the loop.
 *
 * Each row starts at the point in the waveform above where that drum first
 * hits and travels to its place in the list. It makes visible the thing that
 * is actually true and that no sample library can claim: these seven files came
 * out of this render, not out of a folder.
 *
 * The offsets are real page geometry - the scope canvas's own rect - not a
 * percentage of the row, so the row genuinely starts under its hit.
 */
function renderShots(): void {
  const host = $("shots");
  const present = VOICES.filter((v) => firstHit[v] !== undefined);
  if (present.length === 0) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = present
    .map((v) =>
      `<li data-voice="${v}"><span>${VOICE_LABEL[v]}</span><b>${(firstHit[v] * 100).toFixed(0)}%</b></li>`
    )
    .join("");
  const rows = Array.from(host.querySelectorAll<HTMLElement>("li"));
  if (reducedMotion) return; // final state, drawn directly

  const scope = $("scope").getBoundingClientRect();
  const from = rows.map((li) => {
    const r = li.getBoundingClientRect();
    const at = firstHit[li.dataset.voice ?? ""] ?? 0;
    return {
      li,
      dx: scope.left + at * scope.width - (r.left + r.width / 2),
      dy: scope.top + scope.height / 2 - (r.top + r.height / 2),
    };
  });
  for (const f of from) {
    f.li.style.transform = `translate(${f.dx.toFixed(1)}px, ${f.dy.toFixed(1)}px) scale(.82)`;
    f.li.style.opacity = "0";
  }
  requestAnimationFrame(() => {
    for (const f of from) {
      f.li.style.transition = "transform 320ms cubic-bezier(.2,.7,.3,1), opacity 220ms ease-out";
      f.li.style.transform = "translate(0, 0) scale(1)";
      f.li.style.opacity = "1";
    }
  });
}

// ----------------------------------------------------------------- words -

function buildWords(): void {
  const names = ["harder", "busier", "dirtier"] as const;
  $("words").innerHTML = names
    .map((n) => `<div class="word"><label for="w-${n}">${n}</label>
      <input id="w-${n}" type="range" min="0" max="1" step="0.05" value="${words[n]}">
      <span class="value" id="v-${n}">${Math.round(words[n] * 100)}</span></div>`)
    .join("");
  for (const n of names) {
    const el = $(`w-${n}`) as HTMLInputElement;
    el.addEventListener("input", () => {
      words[n] = Number(el.value);
      $(`v-${n}`).textContent = String(Math.round(words[n] * 100));
    });
    // re-render on release rather than on every step of the drag
    el.addEventListener("change", () => {
      if (hasLoop) generate(false);
    });
  }
}

// ---------------------------------------------------------------- scope -

function drawScope(buf: AudioBuffer | null, head = -1): void {
  const c = $("scope") as unknown as HTMLCanvasElement;
  const g = c.getContext("2d");
  if (!g) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth || 360;
  const h = c.clientHeight || 160;
  if (c.width !== Math.round(w * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const mid = h / 2;
  g.fillStyle = css.getPropertyValue("--text").trim();
  if (buf) {
    const d = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(d.length / w));
    for (let x = 0; x < w; x++) {
      let pk = 0;
      const o = x * per;
      for (let i = 0; i < per; i += 8) {
        const a = Math.abs(d[o + i] ?? 0);
        if (a > pk) pk = a;
      }
      const hh = Math.max(1, pk * (h * 0.44));
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
    // bar lines, faint: a loop is read in bars
    g.fillStyle = css.getPropertyValue("--line-hi").trim();
    for (let b = 1; b < bars; b++) g.fillRect(Math.round((b / bars) * w), 0, 1, h);
  } else {
    g.fillStyle = css.getPropertyValue("--line-hi").trim();
    g.fillRect(0, mid, w, 1);
  }
  if (head >= 0) {
    g.fillStyle = css.getPropertyValue("--flare").trim();
    g.fillRect(Math.round(head * w), 8, 2, h - 16);
  }
}

function startClock(): void {
  cancelAnimationFrame(raf);
  const tick = () => {
    if (!ctx || !source || !source.buffer) return;
    const len = source.buffer.duration;
    const pos = len > 0 ? ((ctx.currentTime - startedAt) % len) / len : 0;
    drawScope(source.buffer, reducedMotion ? -1 : pos);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

// ----------------------------------------------------------------- boot --

const arrived = readHash();
if (!seed) seed = newSeed();
($("seed") as HTMLInputElement).value = seed;
($("bpm") as HTMLInputElement).value = String(bpm);
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".bars button"))) {
  b.setAttribute("aria-checked", String(Number(b.dataset.bars) === bars));
}
buildWords();
renderLanes();
setLabel("");
drawScope(null);

$("generate").addEventListener("click", () => {
  audio();
  generate(hasLoop);
});
$("play").addEventListener("click", () => {
  if (source) stop();
  else {
    const b = buffers.get(solo ?? "full");
    if (b) play(b);
  }
});
($("bpm") as HTMLInputElement).addEventListener("change", (e) => {
  const v = Math.round(Number((e.target as HTMLInputElement).value));
  bpm = Math.min(180, Math.max(80, Number.isFinite(v) ? v : 150));
  ($("bpm") as HTMLInputElement).value = String(bpm);
  if (hasLoop) generate(false);
});
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".bars button"))) {
  b.addEventListener("click", () => {
    bars = Number(b.dataset.bars) as 4 | 8 | 16;
    for (const o of Array.from(document.querySelectorAll<HTMLButtonElement>(".bars button"))) {
      o.setAttribute("aria-checked", String(o === b));
    }
    if (hasLoop) generate(false);
  });
}
($("seed") as HTMLInputElement).addEventListener("change", (e) => {
  const v = normaliseSeedInput((e.target as HTMLInputElement).value);
  if (v.length >= 3) {
    seed = v;
    audio();
    generate(false);
  }
});
for (const [id, what] of [["dl-wav", "wav"], ["dl-kit", "oneshots"], ["dl-midi", "midi"]] as const) {
  $(id).addEventListener("click", () => {
    ($("dlmenu") as HTMLDetailsElement).open = false;
    setLabel("preparing…");
    // exports never carry `only`: see the note on `solo`
    send({ type: "export", what, ...request() });
  });
}
$("share").addEventListener("click", async () => {
  const url = `${location.origin}/drums/#s=${encodeURIComponent(seed)}&bpm=${bpm}&bars=${bars}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: `Nullsample drums ${seed}`, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    $("share").textContent = "COPIED";
    setTimeout(() => { $("share").textContent = "SHARE"; }, 1600);
  } catch {
    $("share").textContent = "COPY IT";
    setTimeout(() => { $("share").textContent = "SHARE"; }, 1600);
  }
});
($("dlmenu") as HTMLDetailsElement).addEventListener("toggle", () => {
  if (($("dlmenu") as HTMLDetailsElement).open) renderShots();
});
document.addEventListener("click", (e) => {
  const m = $("dlmenu") as HTMLDetailsElement;
  if (m.open && !m.contains(e.target as Node)) m.open = false;
});
window.addEventListener("resize", () => drawScope(buffers.get(solo ?? "full") ?? null));

if (arrived) generate(false);

export {};
