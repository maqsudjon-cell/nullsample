#!/usr/bin/env node
/**
 * Cross-host determinism: the same seeds, rendered in headless Chrome,
 * compared against the same golden hashes Node produces.
 *
 * This is the test that justifies core/dmath.ts. If the engine called
 * Math.sin, Math.exp or Math.pow, this is where it would fail - those are
 * "implementation-approximated" in the ECMAScript spec and V8 does not agree
 * with every other engine in the last ulp.
 *
 *   npm run test:browser
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const ROOT = new URL("..", import.meta.url).pathname;

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const p = execFileSync("which", ["google-chrome"], { encoding: "utf8" }).trim();
    if (p && existsSync(p)) return p;
  } catch {}
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error("No Chrome or Chromium found.");
  console.error("Set CHROME_PATH to a Chrome binary and re-run. This test cannot be");
  console.error("skipped silently: cross-browser determinism is non-negotiable #1.");
  process.exit(1);
}

const golden = JSON.parse(readFileSync(join(ROOT, "test/golden/hashes.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "nullsample-browser-"));

console.log(`building engine bundle...`);
await build({
  entryPoints: [join(ROOT, "test/browser-entry.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(dir, "engine.js"),
  loader: { ".json": "json" },
  logLevel: "warning",
});

writeFileSync(
  join(dir, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>determinism</title></head>` +
    `<body><script type="module" src="./engine.js"></script></body></html>`,
);

console.log(`launching ${chrome}`);
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
});

let failures = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    console.error("page error:", e.message);
    failures++;
  });
  await page.goto(`file://${join(dir, "index.html")}`, { waitUntil: "networkidle0" });
  await page.waitForFunction("typeof window.nullsampleRender === 'function'", { timeout: 20000 });

  const ua = await page.evaluate(() => navigator.userAgent);
  console.log(`  ${ua}\n`);

  for (const seed of Object.keys(golden.tracks)) {
    const want = golden.tracks[seed];
    const got = await page.evaluate(
      (s, sr) => window.nullsampleRender(s, sr),
      seed,
      golden.sampleRate,
    );
    const ok = got.sha256 === want.sha256 && got.bytes === want.bytes;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  seed ${seed.padEnd(8)} ${got.sha256.slice(0, 16)}...`);
    if (!ok) {
      console.log(`        node   ${want.sha256}  ${want.bytes} bytes  ${want.tempo} BPM  peak ${want.peakDb}`);
      console.log(`        chrome ${got.sha256}  ${got.bytes} bytes  ${got.tempo} BPM  peak ${got.peakDb}`);
    }
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\ncross-host determinism FAILED (${failures})`);
  process.exit(1);
}
console.log(`\ncross-host determinism: Node and headless Chrome agree byte for byte`);
