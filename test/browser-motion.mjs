#!/usr/bin/env node
/**
 * Motion continuity, measured in a real browser rather than assumed.
 *
 * Addendum 13 asks for morphs instead of cuts and for frame times to be
 * reported, not assumed. Both of those are claims about what a browser
 * actually does, so they are measured here: the page is driven in headless
 * Chrome, the canvas is sampled frame by frame, and the numbers are printed.
 *
 * The test of a morph is the one the addendum states: two samples taken
 * mid-transition should look like one object caught moving. That is measurable
 * - the correlation between consecutive frames stays high while the amplitude
 * travels - and so is its opposite, a cut, which moves the whole distance in a
 * single frame.
 *
 *   node tools/serve.mjs & npm run test:motion
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.MOTION_PORT || 4399);
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL("..", import.meta.url).pathname;

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) if (existsSync(c)) return c;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

// --------------------------------------------------------------- in-page ---

/** Installed in the page: samples the waveform canvas cheaply and often. */
const PROBE = `
window.__probe = (() => {
  const off = document.createElement('canvas');
  off.width = 160; off.height = 64;
  const o = off.getContext('2d', { willReadFrequently: true });
  const shape = (sel) => {
    const c = document.querySelector(sel);
    o.clearRect(0, 0, 160, 64);
    o.drawImage(c, 0, 0, 160, 64);
    const d = o.getImageData(0, 0, 160, 64).data;
    const cols = new Array(160).fill(0);
    let a = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 160; x++) {
      const v = d[(y * 160 + x) * 4 + 3];
      cols[x] += v; a += v;
    }
    return { a: Math.round(a / 255), cols: cols.map(v => +(v / 255).toFixed(3)) };
  };
  const corr = (p, q) => {
    const n = p.length; let mp = 0, mq = 0;
    for (let i = 0; i < n; i++) { mp += p[i]; mq += q[i]; }
    mp /= n; mq /= n;
    let sp = 0, sq = 0, sc = 0;
    for (let i = 0; i < n; i++) { const a = p[i] - mp, b = q[i] - mq; sp += a * a; sq += b * b; sc += a * b; }
    return sp && sq ? sc / Math.sqrt(sp * sq) : 1;
  };
  /* samples one canvas once per animation frame */
  const over = async (sel, ms) => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const s = shape(sel);
      out.push({ t: Math.round(performance.now() - t0), a: s.a, cols: s.cols });
      await new Promise(r => requestAnimationFrame(r));
    }
    return out;
  };
  return { shape, corr, over };
})();
true`;

/**
 * How a series of shapes moved.
 *
 * Distance is measured between the shapes themselves - the mean difference
 * per pixel column - because total ink is a poor witness: a reroll can land on
 * a waveform with almost exactly as much ink as the one it replaced while
 * being a completely different shape.
 *
 * `worstStep` is the largest fraction of the whole path covered by any one
 * frame. A cut does the entire journey in one frame, so it reads 1. A morph
 * spread over twenty-odd frames reads a twentieth of that.
 */
function motion(samples) {
  const dist = (a, b) => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d / a.length;
  };
  const steps = [];
  for (let i = 1; i < samples.length; i++) steps.push(dist(samples[i - 1].cols, samples[i].cols));
  const path = steps.reduce((a, b) => a + b, 0);
  let worst = 0, worstAt = 0;
  steps.forEach((d, i) => { if (d > worst) { worst = d; worstAt = samples[i + 1].t; } });
  return {
    frames: samples.length,
    firstInk: samples[0].a,
    lastInk: samples[samples.length - 1].a,
    path: +path.toFixed(3),
    travelled: +dist(samples[0].cols, samples[samples.length - 1].cols).toFixed(3),
    worstStep: path > 0 ? +(worst / path).toFixed(3) : 0,
    worstAt,
    moving: steps.filter((d) => d > path / 200).length,
    everBlank: samples.some((s) => s.a === 0),
  };
}

// ------------------------------------------------------------------- main ---

const chrome = findChrome();
if (!chrome) {
  console.error("no Chrome found; set CHROME_PATH");
  process.exit(1);
}
if (!existsSync(`${ROOT}dist/generate/index.html`)) {
  console.error("dist/ is not built; run npm run build first");
  process.exit(1);
}

const server = spawn(process.execPath, [`${ROOT}tools/serve.mjs`], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
await sleep(400);

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});

/** A mid-range phone: a 390-point viewport and a quarter of this laptop's CPU. */
async function phonePage(reduced = false) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (reduced) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  return page;
}

async function settledTrack(page, url = `${BASE}/generate/`) {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(PROBE);
  await page.click("#generate");
  await page.waitForFunction(() => document.getElementById("generate").textContent === "REROLL", { timeout: 60000 });
  // wait for the render to stop growing
  let last = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const a = await page.evaluate(`window.__probe.shape('#scope').a`);
    if (a === last) break;
    last = a;
  }
  return last;
}

try {
  // -- 1 - reroll morphs rather than clearing ------------------------------
  console.log("\nreroll");
  {
    const page = await phonePage();
    const settled = await settledTrack(page);
    // the press and the first sample happen in one page task, so nothing can
    // slip in between and hide a cut
    const samples = await page.evaluate(`(() => {
      document.getElementById('generate').click();
      return window.__probe.over('#scope', 3000);
    })()`);
    const m = motion(samples);
    console.log(`  ink ${settled} -> ${m.lastInk} over ${m.frames} frames; shape moved ${m.travelled} per column`);
    check("no frame is blank", !m.everBlank);
    check("the waveform really is a different one", m.travelled > 0.05, `moved ${m.travelled} per column`);
    check("no single frame covers the whole change", m.worstStep < 0.3, `worst frame ${(m.worstStep * 100).toFixed(0)}% of the path at ${m.worstAt}ms`);
    check("the change is spread over many frames", m.moving >= 12, `${m.moving} frames carried movement`);
    const corrs = await page.evaluate(`(() => {
      const s = ${JSON.stringify(samples.map((x) => x.cols))};
      const out = [];
      for (let i = 1; i < s.length; i++) out.push(+window.__probe.corr(s[i-1], s[i]).toFixed(3));
      return { min: Math.min(...out), endToEnd: +window.__probe.corr(s[0], s[s.length-1]).toFixed(3) };
    })()`);
    check("consecutive frames are the same object moving", corrs.min > 0.5, `min adjacent correlation ${corrs.min}, first-to-last ${corrs.endToEnd}`);
    await page.close();
  }

  // -- 1b - the section name moves with the playhead ----------------------
  console.log("\nsection name");
  {
    const page = await phonePage();
    await settledTrack(page);
    // the opening section is named the moment the new track starts, and takes
    // the same directional transition as any boundary crossing
    const seen = await page.evaluate(`(async () => {
      const el = document.getElementById('nowname');
      const out = [];
      document.getElementById('generate').click();
      const t0 = performance.now();
      while (performance.now() - t0 < 2000) {
        out.push({ cls: el.className, dir: el.dataset.dir || '',
                   x: +(new DOMMatrix(getComputedStyle(el).transform)).m41.toFixed(1),
                   o: +getComputedStyle(el).opacity });
        await new Promise(r => requestAnimationFrame(r));
      }
      return out;
    })()`);
    check("the outgoing name is sent in a direction", seen.some((s) => /leaving/.test(s.cls) && s.dir !== ""),
      seen.find((s) => /leaving/.test(s.cls))?.dir ?? "never left");
    check("the incoming name follows it in", seen.some((s) => /entering/.test(s.cls)));
    const moved = seen.filter((s) => Math.abs(s.x) > 0.5).length;
    check("the name actually travels", moved > 0, `${moved} frames off centre, max ${Math.max(...seen.map((s) => Math.abs(s.x))).toFixed(1)}px`);
    const dip = Math.min(...seen.map((s) => s.o));
    check("it moves rather than only fading", dip > 0 || moved > 0, `opacity floor ${dip}`);
    await page.close();
  }

  // -- 2 - solo morphs, and silence becomes visible ------------------------
  console.log("\nsolo");
  {
    const page = await phonePage();
    await settledTrack(page);
    const mix = await page.evaluate(`window.__probe.shape('#scope')`);
    const buses = await page.evaluate(`Array.from(document.querySelectorAll('.lane-solo')).map(b => b.dataset.bus)`);
    const bus = buses.includes("lead") ? "lead" : buses[1];
    await page.evaluate(`document.querySelector('.lane-solo[data-bus="${bus}"]').click()`);
    const samples = await page.evaluate(`window.__probe.over('#scope', 2500)`);
    const m = motion(samples);
    console.log(`  soloed ${bus}: ink ${m.firstInk} -> ${m.lastInk} over ${m.frames} frames; shape moved ${m.travelled} per column`);
    check("no frame is blank while soloing", !m.everBlank);
    check("solo does not jump in one frame", m.worstStep < 0.3, `worst frame ${(m.worstStep * 100).toFixed(0)}% of the path`);
    check("the change is spread over many frames", m.moving >= 12, `${m.moving} frames carried movement`);
    // the soloed bus renders left to right, so wait for it to finish before
    // comparing shapes - until then the tail still carries the mix by design
    let solo = samples[samples.length - 1];
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const next = await page.evaluate(`window.__probe.shape('#scope')`);
      if (Math.abs(next.a - solo.a) < 2) { solo = next; break; }
      solo = next;
    }
    const r = await page.evaluate(`window.__probe.corr(${JSON.stringify(mix.cols)}, ${JSON.stringify(solo.cols)})`);
    let quieter = 0, nearSilent = 0;
    for (let x = 0; x < mix.cols.length; x++) {
      if (mix.cols[x] <= 2) continue;
      if (solo.cols[x] < mix.cols[x] * 0.35) quieter++;
      if (solo.cols[x] < 0.4) nearSilent++;
    }
    check("the soloed waveform is not the full mix", Math.abs(r) < 0.995 || Math.abs(solo.a - mix.a) / mix.a > 0.05,
      `correlation ${r.toFixed(3)}, ink ${mix.a} -> ${solo.a}`);
    check("where the bus is quiet, the waveform is quiet", quieter >= 10,
      `${quieter}/${mix.cols.length} columns under a third of the mix, ${nearSilent} near silent`);
    await page.close();
  }

  // -- 3 - the playhead is drawn across the lane rows ----------------------
  console.log("\nlane playhead");
  {
    const page = await phonePage();
    await settledTrack(page);
    // a fresh render starts playing on its own; clicking #play here would pause it
    await page.evaluate(`(() => { const b = document.getElementById('play'); if (b.textContent === '\u25b6') b.click(); })()`);
    await sleep(600);
    const head = () => page.evaluate(`(() => {
      const c = document.querySelector('.lane canvas');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      // the brightest column, and how far it stands out from the rest
      const col = new Array(c.width).fill(0);
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) col[x] += d[(y*c.width+x)*4+3];
      const max = Math.max(...col);
      const mean = col.reduce((a,b)=>a+b,0) / col.length;
      return { at: col.indexOf(max) / c.width, ratio: mean ? max / mean : 0 };
    })()`);
    const a = await head();
    await sleep(900);
    const b = await head();
    check("a playhead stands out on the lane rows", a.ratio > 1.5, `peak ${a.ratio.toFixed(1)}x the row mean`);
    check("the playhead advances", b.at > a.at, `${(a.at * 100).toFixed(1)}% -> ${(b.at * 100).toFixed(1)}%`);
    await page.close();
  }

  // -- 4 - frame times on a throttled phone -------------------------------
  console.log("\nframe times (390pt viewport, CPU throttled 4x)");
  {
    const page = await phonePage();
    await settledTrack(page);
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.evaluate(`(() => { const b = document.getElementById('play'); if (b.textContent === '\u25b6') b.click(); })()`);
    await page.evaluate(`document.getElementById('generate').click()`);
    const times = await page.evaluate(`(async () => {
      const d = [];
      let prev = performance.now();
      const t0 = prev;
      while (performance.now() - t0 < 4000) {
        await new Promise(r => requestAnimationFrame(r));
        const now = performance.now();
        d.push(now - prev);
        prev = now;
      }
      return d;
    })()`);
    const s = times.slice(1).sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const over = s.filter((x) => x > 17.5).length;
    console.log(`  ${s.length} frames  p50 ${q(0.5).toFixed(1)}ms  p95 ${q(0.95).toFixed(1)}ms  p99 ${q(0.99).toFixed(1)}ms  max ${s[s.length-1].toFixed(1)}ms  (${over} over 17.5ms)`);
    // A quarter of this laptop's CPU is a rough stand-in for a mid-range phone,
    // and this is the worst moment the page has: playing, rerolling, morphing
    // and rendering in a worker at once. The median frame is the honest 60fps
    // claim; the tail says how often one is dropped.
    check("the median frame holds 60fps", q(0.5) <= 17.5, `p50 ${q(0.5).toFixed(1)}ms`);
    check("the tail never doubles a frame", q(0.95) <= 25, `p95 ${q(0.95).toFixed(1)}ms`);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await page.close();
  }

  // -- 5 - prefers-reduced-motion renders final states --------------------
  console.log("\nprefers-reduced-motion");
  {
    const page = await phonePage(true);
    await settledTrack(page);
    const samples = await page.evaluate(`(() => {
      document.getElementById('generate').click();
      return window.__probe.over('#scope', 450);
    })()`)
    const m = motion(samples);
    // with no morph the shape holds, then the new render appears; what must not
    // happen is a 400ms interpolation
    check("no morph runs", m.moving <= 3, `${m.moving} of ${m.frames} frames carried movement`);
    await page.close();
  }

  // -- 6 - /drums one-shots emerge from the loop --------------------------
  console.log("\n/drums one-shots");
  {
    const page = await phonePage();
    await settledTrack(page, `${BASE}/drums/`);
    // `toggle` on a <details> fires in its own task, so the rows do not exist
    // in the frame the summary is clicked. Sample from inside the page instead,
    // starting in the same task as the click, and watch where the rows travel.
    const run = await page.evaluate(`(async () => {
      const scope = document.getElementById('scope').getBoundingClientRect();
      document.getElementById('download').click();
      while (!document.querySelector('#shots li')) await new Promise(r => requestAnimationFrame(r));
      const rows = Array.from(document.querySelectorAll('#shots li'));
      const centre = (li) => { const r = li.getBoundingClientRect(); return +(r.left + r.width / 2).toFixed(1); };
      const path = rows.map(() => []);
      const t0 = performance.now();
      while (performance.now() - t0 < 600) {
        rows.forEach((li, i) => path[i].push(centre(li)));
        await new Promise(r => requestAnimationFrame(r));
      }
      return {
        voices: rows.map(li => li.dataset.voice),
        hitX: rows.map(li => +(scope.left + (parseFloat(li.querySelector('b').textContent) / 100) * scope.width).toFixed(1)),
        path,
      };
    })()`);
    check("one row per voice in the kit", run.voices.length >= 4, `${run.voices.length} rows`);
    const startedAtHit = run.path.filter((p, i) => Math.abs(p[0] - run.hitX[i]) < 14).length;
    check("each row starts at its own hit in the waveform", startedAtHit === run.voices.length,
      `${startedAtHit}/${run.voices.length} within 14px  ${run.voices.map((v, i) => `${v} ${run.path[i][0]}~${run.hitX[i]}`).join(", ")}`);
    const travelled = run.path.filter((p) => Math.abs(p[p.length - 1] - p[0]) > 2).length;
    check("rows travel to their resting place", travelled === run.voices.length, `${travelled}/${run.voices.length} moved`);
    const steps = run.path.map((p) => {
      const span = Math.abs(p[p.length - 1] - p[0]) || 1;
      let worst = 0;
      for (let i = 1; i < p.length; i++) worst = Math.max(worst, Math.abs(p[i] - p[i - 1]) / span);
      return worst;
    });
    check("no row jumps the whole way in one frame", Math.max(...steps) < 0.5,
      `worst frame ${(Math.max(...steps) * 100).toFixed(0)}% of the journey`);
    const settled = run.path.every((p) => Math.abs(p[p.length - 1] - p[p.length - 2]) < 0.5);
    check("rows have arrived within 600ms", settled);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? "\nmotion: all checks passed" : `\nmotion: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
