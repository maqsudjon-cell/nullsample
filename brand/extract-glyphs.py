#!/usr/bin/env python3
"""
Extracts the glyph outlines the brand scripts need, once, into glyphs.json.

Run only when the typeface changes:
    python3 brand/extract-glyphs.py path/to/JetBrainsMono-Regular.ttf ...

The output is committed so the build needs nothing but Node. Curves are
flattened to polylines here rather than at render time, because the sizes the
brand assets use are known and a flattened contour keeps the Node rasteriser
to a scanline fill with no curve maths in it.
"""
import json
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

CHARS = ("ABCDEFGHIJKLMNOPQRSTUVWXYZ"
         "abcdefghijklmnopqrstuvwxyz"
         "0123456789 .,:-_/()")
SEGMENTS = 10


class FlattenPen(BasePen):
    """Records contours as flat point lists."""

    def __init__(self, glyphSet):
        super().__init__(glyphSet)
        self.contours = []
        self._cur = []

    def _moveTo(self, pt):
        if self._cur:
            self.contours.append(self._cur)
        self._cur = [list(pt)]

    def _lineTo(self, pt):
        self._cur.append(list(pt))

    def _curveToOne(self, p1, p2, p3):
        p0 = self._cur[-1]
        for i in range(1, SEGMENTS + 1):
            t = i / SEGMENTS
            u = 1 - t
            x = (u**3) * p0[0] + 3 * (u**2) * t * p1[0] + 3 * u * (t**2) * p2[0] + (t**3) * p3[0]
            y = (u**3) * p0[1] + 3 * (u**2) * t * p1[1] + 3 * u * (t**2) * p2[1] + (t**3) * p3[1]
            self._cur.append([x, y])

    def _qCurveToOne(self, p1, p2):
        p0 = self._cur[-1]
        for i in range(1, SEGMENTS + 1):
            t = i / SEGMENTS
            u = 1 - t
            x = (u * u) * p0[0] + 2 * u * t * p1[0] + (t * t) * p2[0]
            y = (u * u) * p0[1] + 2 * u * t * p1[1] + (t * t) * p2[1]
            self._cur.append([x, y])

    def _closePath(self):
        if self._cur:
            self.contours.append(self._cur)
            self._cur = []

    def _endPath(self):
        self._closePath()


def extract(path):
    font = TTFont(path)
    upem = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    glyphSet = font.getGlyphSet()
    hmtx = font["hmtx"]
    out = {}
    for ch in CHARS:
        name = cmap.get(ord(ch))
        if name is None:
            continue
        pen = FlattenPen(glyphSet)
        glyphSet[name].draw(pen)
        pen._endPath()
        advance = hmtx[name][0]
        contours = [[[round(x, 1), round(y, 1)] for x, y in c] for c in pen.contours if len(c) > 2]
        out[ch] = {"a": advance, "c": contours}
    return {"unitsPerEm": upem, "glyphs": out}


if __name__ == "__main__":
    weights = {}
    for arg in sys.argv[1:]:
        weight = "bold" if "Bold" in arg else "medium" if "Medium" in arg else "regular"
        weights[weight] = extract(arg)
        print(f"  {weight}: {len(weights[weight]['glyphs'])} glyphs from {arg}")
    with open("brand/glyphs.json", "w") as f:
        json.dump(weights, f, separators=(",", ":"))
    print("wrote brand/glyphs.json")
