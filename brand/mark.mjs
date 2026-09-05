/**
 * The mark.
 *
 * A single-cycle band-limited saw where the first cycle is flatlined at zero
 * and the second breaks into a full saw: null, then sample. Three strokes,
 * hard edges, no curves, no gradient - it has to still read at 16 pixels,
 * where anything softer turns to mush.
 *
 * Defined once here in a 32x32 grid, so the SVG and every rasterised icon are
 * the same geometry rather than two drawings that drift apart.
 */

export const GRID = 32;

/** Stroke centre-lines, in grid units. */
export const STROKES = [
  { points: [[3, 16], [14, 16]], accent: false },          // the null
  { points: [[17, 25], [17, 7], [29, 25]], accent: true }, // the saw tooth
];

export const STROKE_WIDTH = 2.6;

export function markSvg({ accent = "#FF6A1A", base = "#7A8391", size = 32 } = {}) {
  const paths = STROKES.map((s) => {
    const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${p[1]}`).join(" ");
    return `  <path d="${d}" stroke="${s.accent ? accent : base}" stroke-width="${STROKE_WIDTH}" fill="none" stroke-linecap="butt" stroke-linejoin="miter"/>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" width="${size}" height="${size}" role="img" aria-label="Nullsample">\n${paths}\n</svg>\n`;
}

/** Line-line intersection, or null when the lines are parallel. */
function intersect(p1, d1, p2, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
  return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
}

/**
 * Expands a stroke into filled quads so the rasteriser can draw it.
 *
 * Joints are true miters, computed as the intersection of the two offset
 * edges. An axis-aligned square at the joint is easier but leaves a visible
 * tab at the apex, which on a mark this simple is the only thing you look at.
 */
export function strokePolygons(points, width, scale, offsetX = 0, offsetY = 0) {
  const pts = points.map(([x, y]) => [offsetX + x * scale, offsetY + y * scale]);
  const hw = (width * scale) / 2;
  const polys = [];

  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const d = [dx / len, dy / len];
    seg.push({ a, b, d, n: [-d[1] * hw, d[0] * hw] });
  }

  for (let i = 0; i < seg.length; i++) {
    const s = seg[i];
    polys.push([
      [s.a[0] + s.n[0], s.a[1] + s.n[1]],
      [s.b[0] + s.n[0], s.b[1] + s.n[1]],
      [s.b[0] - s.n[0], s.b[1] - s.n[1]],
      [s.a[0] - s.n[0], s.a[1] - s.n[1]],
    ]);

    const next = seg[i + 1];
    if (!next) continue;
    const p = s.b;
    // fill the wedge on both sides; the inner one is degenerate and harmless
    for (const sign of [1, -1]) {
      const o1 = [p[0] + s.n[0] * sign, p[1] + s.n[1] * sign];
      const o2 = [p[0] + next.n[0] * sign, p[1] + next.n[1] * sign];
      const m = intersect(o1, s.d, o2, next.d);
      if (!m) continue;
      const reach = Math.hypot(m[0] - p[0], m[1] - p[1]);
      // a miter limit, so a very sharp angle cannot grow a spike
      if (reach > hw * 4) continue;
      polys.push([o1, m, o2, p]);
    }
  }
  return polys;
}
