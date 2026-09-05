/**
 * A small anti-aliased rasteriser and PNG encoder. No dependencies: node:zlib
 * is all a PNG needs, and the shapes here are polygons.
 */

import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";

const GLYPHS = JSON.parse(readFileSync(new URL("./glyphs.json", import.meta.url), "utf8"));

export class Canvas {
  constructor(width, height, bg = [8, 9, 12, 255]) {
    this.w = width;
    this.h = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = bg[0];
      this.data[i * 4 + 1] = bg[1];
      this.data[i * 4 + 2] = bg[2];
      this.data[i * 4 + 3] = bg[3];
    }
  }

  blend(x, y, [r, g, b], alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const a = alpha > 1 ? 1 : alpha;
    const d = this.data;
    d[i] = d[i] * (1 - a) + r * a;
    d[i + 1] = d[i + 1] * (1 - a) + g * a;
    d[i + 2] = d[i + 2] * (1 - a) + b * a;
    d[i + 3] = Math.max(d[i + 3], a * 255);
  }

  rect(x, y, w, h, colour, alpha = 1) {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    for (let yy = y0; yy < y0 + Math.round(h); yy++) {
      for (let xx = x0; xx < x0 + Math.round(w); xx++) this.blend(xx, yy, colour, alpha);
    }
  }

  /**
   * Fills polygons with 4x4 supersampling and the non-zero winding rule, which
   * is what makes a letter's counters (the hole in an O) come out as holes.
   */
  fillPolygons(contours, colour, alpha = 1) {
    const SS = 4;
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const c of contours) {
      for (const [x, y] of c) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    if (!Number.isFinite(minY)) return;
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.h - 1, Math.ceil(maxY));
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(this.w - 1, Math.ceil(maxX));
    if (y1 < y0 || x1 < x0) return;

    const width = x1 - x0 + 1;
    const cov = new Float32Array(width);

    for (let py = y0; py <= y1; py++) {
      cov.fill(0);
      for (let s = 0; s < SS; s++) {
        const sy = py + (s + 0.5) / SS;
        // gather crossings with winding direction
        const xs = [];
        for (const c of contours) {
          for (let i = 0; i < c.length; i++) {
            const a = c[i];
            const b = c[(i + 1) % c.length];
            if (a[1] === b[1]) continue;
            const lo = Math.min(a[1], b[1]);
            const hi = Math.max(a[1], b[1]);
            if (sy < lo || sy >= hi) continue;
            const t = (sy - a[1]) / (b[1] - a[1]);
            xs.push([a[0] + t * (b[0] - a[0]), b[1] > a[1] ? 1 : -1]);
          }
        }
        if (xs.length === 0) continue;
        xs.sort((p, q) => p[0] - q[0]);
        let winding = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          winding += xs[i][1];
          if (winding === 0) continue;
          const spanA = xs[i][0];
          const spanB = xs[i + 1][0];
          // accumulate horizontal coverage at subpixel resolution
          const from = Math.max(x0, Math.floor(spanA));
          const to = Math.min(x1, Math.ceil(spanB));
          for (let px = from; px <= to; px++) {
            const l = Math.max(spanA, px);
            const r = Math.min(spanB, px + 1);
            if (r > l) cov[px - x0] += (r - l) / SS;
          }
        }
      }
      for (let px = 0; px < width; px++) {
        if (cov[px] > 0.002) this.blend(x0 + px, py, colour, cov[px] * alpha);
      }
    }
  }

  toPng() {
    const { w, h, data } = this;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 4 + 1)] = 0; // filter: none
      for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = data[y * w * 4 + x];
    }
    const idat = deflateSync(raw, { level: 9 });

    const chunk = (type, body) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      const t = Buffer.from(type, "ascii");
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
      return Buffer.concat([len, t, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------

/** Width of a string at a given pixel size, in the mono advance. */
export function textWidth(text, size, weight = "regular") {
  const f = GLYPHS[weight] ?? GLYPHS.regular;
  const scale = size / f.unitsPerEm;
  let w = 0;
  for (const ch of text) {
    const g = f.glyphs[ch];
    w += (g ? g.a : f.glyphs[" "]?.a ?? f.unitsPerEm * 0.6) * scale;
  }
  return w;
}

/**
 * Draws text with the baseline at y. Letter-spacing is in pixels and is added
 * to each advance, which is how the wordmark gets its spacing.
 */
export function drawText(canvas, text, x, y, size, colour, weight = "regular", tracking = 0, alpha = 1) {
  const f = GLYPHS[weight] ?? GLYPHS.regular;
  const scale = size / f.unitsPerEm;
  let cursor = x;
  for (const ch of text) {
    const g = f.glyphs[ch];
    if (g && g.c.length > 0) {
      const contours = g.c.map((c) => c.map(([gx, gy]) => [cursor + gx * scale, y - gy * scale]));
      canvas.fillPolygons(contours, colour, alpha);
    }
    const adv = g ? g.a : f.glyphs[" "]?.a ?? f.unitsPerEm * 0.6;
    cursor += adv * scale + tracking;
  }
  return cursor - x;
}

export const HEX = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
