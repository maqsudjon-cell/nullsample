#!/usr/bin/env node
/**
 * Builds the static site into dist/.
 *
 * The engine is bundled only into the worker, so the page reaches first paint
 * without it. app.js is small and loads the worker after paint.
 */

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "dist");
const DOMAIN = "https://nullsample.maqsudjon.com";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const bundle = (entry, out) =>
  build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: false,
    outfile: join(OUT, out),
    loader: { ".json": "json" },
    logLevel: "warning",
  });

// The engine only exists under /generate. The landing page must reach first
// paint without any of it, which is also what keeps its budget trivially met.
mkdirSync(join(OUT, "generate"), { recursive: true });
await bundle("web/app.ts", "generate/app.js");
await bundle("web/worker.ts", "generate/worker.js");
await bundle("web/landing.ts", "landing.js");
// private tooling, noindex, out of the sitemap
mkdirSync(join(OUT, "rate"), { recursive: true });
await bundle("web/rate.ts", "rate/rate.js");
await bundle("web/rate-progress.ts", "rate/progress.js");

/**
 * Minifies CSS and inlines it into every page.
 *
 * The stylesheet is small enough that a separate request costs more than the
 * bytes save: inlining removes the only render-blocking request on the page,
 * which is what gets first paint under a fifth of a second.
 */
function minifyCss(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .replace(/\s+/g, " ")
    .trim();
}

const css = minifyCss(readFileSync(join(ROOT, "web/styles.css"), "utf8"));

function page(srcPath, outPath) {
  let html = readFileSync(srcPath, "utf8");
  html = html.replace(
    /<link rel="stylesheet" href="\/styles\.css">/,
    `<style>${css}</style>`,
  );
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, html);
}

// static files
page(join(ROOT, "web/index.html"), join(OUT, "index.html"));
page(join(ROOT, "web/generate/index.html"), join(OUT, "generate", "index.html"));
writeFileSync(join(OUT, "styles.css"), css);
try {
  cpSync(join(ROOT, "web/demos"), join(OUT, "demos"), { recursive: true });
} catch {
  console.warn("  demo audio missing - run npm run demos");
}
cpSync(join(ROOT, "web/fonts"), join(OUT, "fonts"), { recursive: true });
page(join(ROOT, "web/rate/index.html"), join(OUT, "rate", "index.html"));
page(join(ROOT, "web/rate/progress/index.html"), join(OUT, "rate", "progress", "index.html"));
try {
  cpSync(join(ROOT, "web/rate/batch"), join(OUT, "rate", "batch"), { recursive: true });
} catch {
  console.warn("  no rating batch published - run npm run batch -- --publish");
}
// Always publish a tuning file, even before the first cycle. Letting the
// progress page fetch a 404 and catch it worked, but a failed request is
// logged by the browser whatever the page does with it - and a console error
// on a page whose whole job is to report health reads badly.
try {
  cpSync(join(ROOT, "web/rate/tuning.json"), join(OUT, "rate", "tuning.json"));
} catch {
  writeFileSync(
    join(OUT, "rate", "tuning.json"),
    JSON.stringify({ cycles: [], paused: false }, null, 2),
  );
}

for (const name of ["how-it-works", "tracks"]) {
  try {
    page(join(ROOT, "web", name, "index.html"), join(OUT, name, "index.html"));
  } catch {
    console.warn(`  /${name} not built yet`);
  }
}
try {
  cpSync(join(ROOT, "brand/out"), OUT, { recursive: true });
} catch {
  console.warn("  brand assets missing - run npm run brand");
}

// CNAME must land in the PUBLISHED output, not just the source tree
writeFileSync(join(OUT, "CNAME"), "nullsample.maqsudjon.com\n");

writeFileSync(
  join(OUT, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /rate/\n\nSitemap: ${DOMAIN}/sitemap.xml\n`,
);

const today = new Date().toISOString().slice(0, 10);
const pages = [
  { loc: "/", priority: "1.0", changefreq: "weekly" },
  { loc: "/generate/", priority: "0.9", changefreq: "weekly" },
  { loc: "/how-it-works/", priority: "0.7", changefreq: "monthly" },
  { loc: "/tracks/", priority: "0.6", changefreq: "monthly" },
];
writeFileSync(
  join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    pages
      .map(
        (p) =>
          `  <url>\n    <loc>${DOMAIN}${p.loc}</loc>\n    <lastmod>${today}</lastmod>\n` +
          `    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`,
      )
      .join("\n") +
    `\n</urlset>\n`,
);

function walk(dir, base = "") {
  let total = 0;
  const rows = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      const sub = walk(p, `${base}${e}/`);
      total += sub.total;
      rows.push(...sub.rows);
    } else {
      total += st.size;
      rows.push([`${base}${e}`, st.size]);
    }
  }
  return { total, rows };
}
const { total, rows } = walk(OUT);
rows.sort((a, b) => b[1] - a[1]);
console.log(`dist/  ${(total / 1024).toFixed(0)} KB total`);
for (const [name, size] of rows.slice(0, 12)) {
  console.log(`  ${(size / 1024).toFixed(1).padStart(7)} KB  ${name}`);
}
