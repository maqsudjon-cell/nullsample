#!/usr/bin/env node
/** Minimal static server for local preview of dist/. */
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("../dist", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 4321);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".wav": "audio/wav",
};

createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
  try {
    if (statSync(file).isDirectory()) throw new Error("dir");
    const body = readFileSync(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}).listen(PORT, () => console.log(`serving dist/ on http://localhost:${PORT}`));
