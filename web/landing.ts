import { mountCards, redrawCards, type CardData } from "./cards.ts";
/**
 * The landing page.
 *
 * No engine, no worker. Everything here plays a pre-rendered file, so a cold
 * visitor hears what this sounds like on one tap instead of waiting through a
 * render to find out.
 *
 * The code-beside-sound section is the argument the whole page is making: real
 * source from /core, and the sound that arithmetic produces, with the line
 * responsible for what is currently sounding lit up.
 */

interface Stage {
  at: number;
  until: number;
  label: string;
  line: number;
}

interface Clip {
  id: string;
  file: string;
  title: string;
  blurb: string;
  source: string;
  code: string;
  stages: Stage[];
}

interface TrackInfo {
  seed: string;
  file: string;
  peaks: number[];
  fromSection: string;
  tempo: number;
  key: string;
  form: string;
  bars: number;
  lengthSeconds: number;
  excerptSeconds: number;
}

interface Manifest {
  tracks: TrackInfo[];
  clips: Clip[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One audio element plays at a time; starting another stops the first. */
let playing: HTMLAudioElement | null = null;
let raf = 0;

function playOnly(el: HTMLAudioElement): void {
  if (playing && playing !== el) {
    playing.pause();
    playing.currentTime = 0;
  }
  // only one thing on the page makes sound at a time
  const stopCards = (window as unknown as { nullsampleStopCards?: () => void }).nullsampleStopCards;
  stopCards?.();
  playing = el;
  void el.play().catch(() => {
    /* a browser that will not start it has already told the user why */
  });
}

function count(name: string): void {
  const g = (window as unknown as { goatcounter?: { count?: (o: object) => void } }).goatcounter;
  g?.count?.({ path: name, title: name, event: true });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// hero
// ---------------------------------------------------------------------------

let heroPeaks: Float32Array | null = null;
let heroSection = "";
/** 0..1 — how much of the trace has drawn in. The one orchestrated moment. */
let heroDrawn = 0;

/**
 * The hero waveform.
 *
 * Drawn from peaks shipped in the manifest, so it appears on load without
 * fetching or decoding a single byte of audio. It draws in left to right,
 * fast, once — that is the arrival moment, and it is also the only animation
 * on the page that is not a direct response to a press.
 */
function drawHero(progress = 0): void {
  const c = $<HTMLCanvasElement>("herowave");
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
  const text = css.getPropertyValue("--text").trim();
  const flare = css.getPropertyValue("--flare").trim();
  const mid = Math.round(h / 2);

  g.strokeStyle = line;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, mid + 0.5);
  g.lineTo(w, mid + 0.5);
  g.stroke();

  if (!heroPeaks) return;
  const n = heroPeaks.length;
  const bw = Math.max(1, w / n);
  const height = mid - 14;
  const drawnTo = Math.min(n, Math.ceil(n * heroDrawn));
  for (let i = 0; i < drawnTo; i++) {
    const x = (i / n) * w;
    const amp = Math.max(0.7, heroPeaks[i] * height);
    const played = i / n <= progress;
    g.fillStyle = played ? flare : text;
    g.globalAlpha = played ? 1 : 0.5;
    g.fillRect(x, mid - amp, bw > 1.2 ? bw - 0.4 : bw, amp * 2);
  }
  g.globalAlpha = 1;

  // The tick that snaps into place. Its label lives in the DOM above the
  // canvas, not on top of the waveform - the canvas draws the signal and
  // nothing else.
  if (heroDrawn >= 1 && heroSection) {
    g.strokeStyle = flare;
    g.beginPath();
    g.moveTo(0.5, 0);
    g.lineTo(0.5, h);
    g.stroke();
    const label = document.getElementById("herosection");
    if (label && label.textContent !== heroSection) label.textContent = heroSection;
  }
}

function startHeroDrawIn(): void {
  if (reducedMotion) {
    heroDrawn = 1;
    drawHero(heroProgress);
    return;
  }
  const started = performance.now();
  const step = () => {
    heroDrawn = Math.min(1, (performance.now() - started) / 420);
    drawHero(heroProgress);
    if (heroDrawn < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let heroProgress = 0;

// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const res = await fetch("/demos/demos.json");
  const manifest: Manifest = await res.json();
  const hero = manifest.tracks[0];

  // --- hero -----------------------------------------------------------
  const heroAudio = $<HTMLAudioElement>("heroaudio");
  heroAudio.src = `/demos/${hero.file}`;
  $("heroseed").textContent = hero.seed;
  // Tempo and length only. The landing page is for people who do not know what
  // pentatonic means; it is the one place the jargon helps least.
  $("herometa").textContent =
    `${hero.tempo.toFixed(0)} BPM  ·  ${hero.excerptSeconds}s excerpt`;
  const heroBtn = $<HTMLButtonElement>("heroplay");

  // Not "00:00 / 00:00" before anything has played - that reads as broken.
  // The excerpt's length is the useful thing to know before pressing play.
  $("herotime").textContent = clock(hero.excerptSeconds);

  heroPeaks = Float32Array.from(hero.peaks);
  heroSection = hero.fromSection;
  startHeroDrawIn();

  heroBtn.addEventListener("click", () => {
    if (!heroAudio.paused) {
      heroAudio.pause();
      return;
    }
    playOnly(heroAudio);
    count("demo played");
  });
  heroAudio.addEventListener("play", () => {
    heroBtn.textContent = "\u25AE\u25AE  PAUSE";
    const tick = () => {
      heroProgress = heroAudio.duration ? heroAudio.currentTime / heroAudio.duration : 0;
      $("herotime").textContent = `${clock(heroAudio.currentTime)} / ${clock(heroAudio.duration || 0)}`;
      drawHero(heroProgress);
      if (!heroAudio.paused) raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  });
  const heroStopped = () => {
    heroBtn.textContent = "\u25B6  HEAR IT";
    cancelAnimationFrame(raf);
  };
  heroAudio.addEventListener("pause", heroStopped);
  heroAudio.addEventListener("ended", () => {
    heroProgress = 0;
    heroStopped();
    drawHero(0);
    $("herotime").textContent = clock(hero.excerptSeconds);
  });
  // MAKE ONE carries no seed. It used to carry the hero's, so the button that
  // says "make one" reproduced NULL-0001 - the opposite of what it says. The
  // ticker and the demo list still carry theirs: reproducing a specific track
  // is what those are for.

  // Everything below the hero is built when the browser is idle. It is all
  // below the fold, and building it during load was the single largest task
  // on the page.
  const buildRest = () => {
  // --- the cards: the body of the page, and its explanation ------------
  void (async () => {
    try {
      const cards: CardData = await (await fetch("/demos/cards.json")).json();
      mountCards($("cards"), cards, count);
    } catch {
      // the cards explain the product; they are not the product. If they
      // cannot load, the page still works and still plays.
      $("cards").remove();
    }
  })();

  // Seed ticker: real seeds, each one a link into the generator. A ticker
  // that scrolled decoration would be motion without meaning.
  const ticker = $("tickrow");
  const pool = [...manifest.tracks, ...manifest.tracks, ...manifest.tracks, ...manifest.tracks];
  ticker.innerHTML = pool
    .map((t) => `<a href="/generate/#s=${encodeURIComponent(t.seed)}">${escapeHtml(t.seed)}</a>`)
    .join("");

  // --- code beside sound ----------------------------------------------
  $("clips").innerHTML = manifest.clips
    .map((clip) => {
      const lines = clip.code.split("\n");
      return `<article class="clip" id="clip-${clip.id}">
        <h3>${escapeHtml(clip.title)}</h3>
        <p class="blurb">${escapeHtml(clip.blurb)}</p>
        <div class="cliprow">
          <pre class="code" aria-label="Source from ${escapeHtml(clip.source)}"><code>${lines
            .map((l, i) => `<span class="cl" data-line="${i}">${escapeHtml(l) || "&nbsp;"}</span>`)
            .join("\n")}</code></pre>
          <div class="clipside">
            <button type="button" class="clipplay" data-clip="${clip.id}">&#9654;&nbsp; PLAY</button>
            <p class="stagelabel" id="stage-${clip.id}">&nbsp;</p>
            <p class="src">${escapeHtml(clip.source)}</p>
          </div>
        </div>
        <audio id="audio-${clip.id}" preload="none" src="/demos/${clip.file}"></audio>
      </article>`;
    })
    .join("");

  for (const clip of manifest.clips) {
    const el = $<HTMLAudioElement>(`audio-${clip.id}`);
    const btn = document.querySelector<HTMLButtonElement>(`.clipplay[data-clip="${clip.id}"]`);
    const root = $(`clip-${clip.id}`);
    const label = $(`stage-${clip.id}`);
    if (!btn) continue;

    const clearLines = () => {
      for (const l of Array.from(root.querySelectorAll<HTMLElement>(".cl"))) {
        l.classList.remove("live");
      }
    };

    btn.addEventListener("click", () => {
      if (!el.paused) {
        el.pause();
        return;
      }
      playOnly(el);
      count("code sample played");
    });
    el.addEventListener("play", () => {
      btn.innerHTML = "&#9646;&#9646;&nbsp; STOP";
      const tick = () => {
        const t = el.currentTime;
        const stage = clip.stages.find((s) => t >= s.at && t < s.until);
        clearLines();
        if (stage) {
          label.textContent = stage.label;
          const line = root.querySelector<HTMLElement>(`.cl[data-line="${stage.line}"]`);
          if (line) line.classList.add("live");
        }
        if (!el.paused) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const stop = () => {
      btn.innerHTML = "&#9654;&nbsp; PLAY";
      clearLines();
      label.innerHTML = "&nbsp;";
    };
    el.addEventListener("pause", stop);
    el.addEventListener("ended", stop);
  }

  // --- demo tracks ------------------------------------------------------
  $("demolist").innerHTML = manifest.tracks
    .map(
      (t) => `<li class="demo">
        <button type="button" class="demoplay" data-seed="${escapeHtml(t.seed)}"
          aria-label="Play the ${escapeHtml(t.seed)} excerpt">&#9654;</button>
        <a class="demoseed" href="/generate/#s=${encodeURIComponent(t.seed)}">${escapeHtml(t.seed)}</a>
        <span class="demometa">${t.tempo.toFixed(0)} BPM &nbsp;&middot;&nbsp; ${clock(t.lengthSeconds)}</span>
        <audio id="demo-${escapeHtml(t.seed)}" preload="none" src="/demos/${escapeHtml(t.file)}"></audio>
      </li>`,
    )
    .join("");
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>(".demoplay"))) {
    const seed = btn.dataset.seed ?? "";
    const el = document.getElementById(`demo-${seed}`) as HTMLAudioElement | null;
    if (!el) continue;
    btn.addEventListener("click", () => {
      if (!el.paused) {
        el.pause();
        return;
      }
      playOnly(el);
      count("demo played");
    });
    el.addEventListener("play", () => {
      btn.innerHTML = "&#9646;&#9646;";
    });
    const stop = () => {
      btn.innerHTML = "&#9654;";
    };
    el.addEventListener("pause", stop);
    el.addEventListener("ended", stop);
  }

  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>(".cta"))) {
    a.addEventListener("click", () => count("cta clicked"));
  }
  };

  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (idle) idle(buildRest);
  else setTimeout(buildRest, 200);
}

window.addEventListener("resize", () => {
  drawHero(heroProgress);
  redrawCards();
});
void boot();
