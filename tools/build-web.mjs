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

await build({
  entryPoints: [join(ROOT, "web/app.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  outfile: join(OUT, "app.js"),
  loader: { ".json": "json" },
  logLevel: "warning",
});

await build({
  entryPoints: [join(ROOT, "web/worker.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  outfile: join(OUT, "worker.js"),
  loader: { ".json": "json" },
  logLevel: "warning",
});

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
writeFileSync(join(OUT, "styles.css"), css);
cpSync(join(ROOT, "web/fonts"), join(OUT, "fonts"), { recursive: true });
for (const name of ["about", "tracks"]) {
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
  `User-agent: *\nAllow: /\n\nSitemap: ${DOMAIN}/sitemap.xml\n`,
);

const today = new Date().toISOString().slice(0, 10);
const pages = [
  { loc: "/", priority: "1.0", changefreq: "weekly" },
  { loc: "/about/", priority: "0.7", changefreq: "monthly" },
  { loc: "/tracks/", priority: "0.7", changefreq: "monthly" },
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
