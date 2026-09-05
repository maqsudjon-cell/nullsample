/**
 * Deterministic math.
 *
 * ECMAScript specifies +, -, *, / and the exact-value operations (floor, round,
 * abs, min, max) to IEEE-754 exactness, but it explicitly leaves Math.sin,
 * Math.cos, Math.tan, Math.exp, Math.log, Math.pow and Math.sqrt as
 * "implementation-approximated". V8, JavaScriptCore and SpiderMonkey do differ
 * in the last ulp, and on some platforms an engine forwards to the system libm,
 * which differs again. A single differing ulp inside a feedback path diverges
 * audibly within a second.
 *
 * Non-negotiable #1 therefore forbids all of them. Everything here is built
 * from exact arithmetic only, so every host produces bit-identical results.
 * Accuracy is ~1e-15 relative — seven orders of magnitude better than the
 * float32 buffers this feeds.
 *
 * Angles are in TURNS, not radians: one turn = one full cycle. Oscillators keep
 * a phase accumulator in [0,1), which avoids large-argument range reduction
 * entirely and keeps full mantissa precision at every sample.
 */

// ---------------------------------------------------------------------------
// exact powers of two
// ---------------------------------------------------------------------------

const P2_BIAS = 1100;
const POW2 = /* @__PURE__ */ (() => {
  const t = new Float64Array(P2_BIAS * 2 + 1);
  t[P2_BIAS] = 1;
  // doubling and halving a power of two is exact in IEEE-754 until it
  // overflows to Infinity or underflows past 2^-1074 to zero.
  for (let n = 1; n <= P2_BIAS; n++) t[P2_BIAS + n] = t[P2_BIAS + n - 1] * 2;
  for (let n = 1; n <= P2_BIAS; n++) t[P2_BIAS - n] = t[P2_BIAS - n + 1] * 0.5;
  return t;
})();

/** 2^n for integer n. Exact. */
export function pow2i(n: number): number {
  if (n < -P2_BIAS) return 0;
  if (n > P2_BIAS) return Infinity;
  return POW2[n + P2_BIAS];
}

// ---------------------------------------------------------------------------
// sine / cosine, argument in turns
// ---------------------------------------------------------------------------

// Coefficients are built here from Math.PI (a spec-exact constant) using only
// multiplication and division, so they are themselves bit-identical everywhere.
const SIN_C = /* @__PURE__ */ (() => {
  const K = Math.PI / 2;
  const KK = K * K;
  const c: number[] = [];
  // Recurrence a_{j+2} = -a_j * K^2 / ((j+1)(j+2)). Dividing by small exact
  // integers each step keeps every coefficient exact to within one rounding,
  // and sidesteps the factorial overflowing 2^53.
  let a = K;
  for (let j = 1; j <= 19; j += 2) {
    c.push(a);
    a = (-a * KK) / ((j + 1) * (j + 2));
  }
  return c;
})();

const COS_C = /* @__PURE__ */ (() => {
  const K = Math.PI / 2;
  const KK = K * K;
  const c: number[] = [];
  let a = 1;
  for (let j = 0; j <= 20; j += 2) {
    c.push(a);
    a = (-a * KK) / ((j + 1) * (j + 2));
  }
  return c;
})();

/** sin(pi*r/2) for r in [0,1]. */
function sinQuarter(r: number): number {
  const r2 = r * r;
  let s = SIN_C[9];
  for (let i = 8; i >= 0; i--) s = s * r2 + SIN_C[i];
  return s * r;
}

/** cos(pi*r/2) for r in [0,1]. */
function cosQuarter(r: number): number {
  const r2 = r * r;
  let s = COS_C[10];
  for (let i = 9; i >= 0; i--) s = s * r2 + COS_C[i];
  return s;
}

/** sin(2*pi*t), t in turns. */
export function sinTurns(t: number): number {
  const u = (t - Math.floor(t)) * 4;
  const q = Math.floor(u);
  const r = u - q;
  switch (q) {
    case 0: return sinQuarter(r);
    case 1: return cosQuarter(r);
    case 2: return -sinQuarter(r);
    default: return -cosQuarter(r);
  }
}

/** cos(2*pi*t), t in turns. */
export function cosTurns(t: number): number {
  const u = (t - Math.floor(t)) * 4;
  const q = Math.floor(u);
  const r = u - q;
  switch (q) {
    case 0: return cosQuarter(r);
    case 1: return -sinQuarter(r);
    case 2: return -cosQuarter(r);
    default: return sinQuarter(r);
  }
}

/** tan(2*pi*t). Used for filter prewarping; t stays well inside a quarter turn. */
export function tanTurns(t: number): number {
  return sinTurns(t) / cosTurns(t);
}

// ---------------------------------------------------------------------------
// exp / log / pow
// ---------------------------------------------------------------------------

// fdlibm's split of ln(2). n * LN2_HI is exact for the integers we produce, so
// the reduced argument keeps full precision.
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const LOG2E = Math.LOG2E;

const EXP_C = /* @__PURE__ */ (() => {
  const c: number[] = [];
  let fact = 1;
  for (let j = 0; j <= 12; j++) {
    if (j > 0) fact = fact * j; // exact: 12! = 479001600
    c.push(1 / fact);
  }
  return c;
})();

/** e^x. */
export function dexp(x: number): number {
  if (x !== x) return NaN;
  if (x >= 709.79) return Infinity;
  if (x <= -745.2) return 0;
  const n = Math.round(x * LOG2E);
  const r = x - n * LN2_HI - n * LN2_LO;
  let s = EXP_C[12];
  s = s * r + EXP_C[11];
  s = s * r + EXP_C[10];
  s = s * r + EXP_C[9];
  s = s * r + EXP_C[8];
  s = s * r + EXP_C[7];
  s = s * r + EXP_C[6];
  s = s * r + EXP_C[5];
  s = s * r + EXP_C[4];
  s = s * r + EXP_C[3];
  s = s * r + EXP_C[2];
  s = s * r + EXP_C[1];
  s = s * r + EXP_C[0];
  return pow2i(n) * s;
}

// Endianness-independent access to the exponent field.
const BITS_BUF = new ArrayBuffer(8);
const BITS = new DataView(BITS_BUF);
const SQRT2 = 1.4142135623730951;

/** natural log of x, x > 0. */
export function dlog(x: number): number {
  if (x !== x) return NaN;
  if (x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;

  let scale = 0;
  if (x < 2.2250738585072014e-308) {
    // subnormal: scale into the normal range first (exact, power of two)
    x = x * POW2[P2_BIAS + 54];
    scale = -54;
  }
  BITS.setFloat64(0, x, true);
  const hi = BITS.getUint32(4, true);
  let e = ((hi >>> 20) & 0x7ff) - 1023 + scale;

  let m = x * pow2i(-(e - scale)); // mantissa in [1,2), exact
  if (m > SQRT2) {
    m = m * 0.5;
    e = e + 1;
  }

  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let p = 1 / 17;
  p = p * s2 + 1 / 15;
  p = p * s2 + 1 / 13;
  p = p * s2 + 1 / 11;
  p = p * s2 + 1 / 9;
  p = p * s2 + 1 / 7;
  p = p * s2 + 1 / 5;
  p = p * s2 + 1 / 3;
  p = p * s2 + 1;
  const logm = 2 * s * p;

  return e * LN2_HI + (logm + e * LN2_LO);
}

/** x^y for x > 0. */
export function dpow(x: number, y: number): number {
  if (y === 0) return 1;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return NaN;
  if (y === 1) return x;
  if (y === 2) return x * x;
  return dexp(y * dlog(x));
}

/** 2^x for real x. */
export function dexp2(x: number): number {
  const n = Math.round(x);
  return pow2i(n) * dexp((x - n) * (LN2_HI + LN2_LO));
}

/** log2(x). */
export function dlog2(x: number): number {
  return dlog(x) * LOG2E;
}

// ---------------------------------------------------------------------------
// sqrt and tanh
// ---------------------------------------------------------------------------

/**
 * Square root by a fixed five-step Newton iteration from a bit-hack seed.
 * The iteration count is fixed, so the result is bit-identical on every host
 * regardless of whether the platform's hardware sqrt is correctly rounded.
 */
export function dsqrt(x: number): number {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return x;
  if (x === Infinity) return Infinity;

  let scale = 0;
  if (x < 2.2250738585072014e-308) {
    x = x * POW2[P2_BIAS + 100];
    scale = -50;
  }

  BITS.setFloat64(0, x, true);
  const hi = BITS.getUint32(4, true);
  BITS.setUint32(0, 0, true);
  BITS.setUint32(4, (hi >>> 1) + 0x1ff80000, true);
  let y = BITS.getFloat64(0, true);

  y = 0.5 * (y + x / y);
  y = 0.5 * (y + x / y);
  y = 0.5 * (y + x / y);
  y = 0.5 * (y + x / y);
  y = 0.5 * (y + x / y);

  return y * pow2i(scale);
}

/** hyperbolic tangent. The workhorse saturator. */
export function dtanh(x: number): number {
  if (x > 19) return 1;
  if (x < -19) return -1;
  const ax = x < 0 ? -x : x;
  if (ax < 1e-4) return x - (x * x * x) / 3;
  const e = dexp(2 * ax);
  const t = (e - 1) / (e + 1);
  return x < 0 ? -t : t;
}

// ---------------------------------------------------------------------------
// audio conveniences
// ---------------------------------------------------------------------------

/** decibels to linear gain. */
export function db2gain(db: number): number {
  return dexp(db * 0.11512925464970229); // ln(10)/20
}

/** linear gain to decibels. */
export function gain2db(g: number): number {
  return dlog(g < 1e-30 ? 1e-30 : g) * 8.685889638065035; // 20/ln(10)
}

/** MIDI note number to hertz. */
export function midiToHz(m: number): number {
  return 440 * dexp2((m - 69) / 12);
}

/** semitone offset to frequency ratio. */
export function semitones(n: number): number {
  return dexp2(n / 12);
}

/** cents offset to frequency ratio. */
export function cents(c: number): number {
  return dexp2(c / 1200);
}

/** One-pole smoothing coefficient for a time constant in seconds. */
export function timeCoef(seconds: number, sampleRate: number): number {
  if (seconds <= 0) return 0;
  return dexp(-1 / (seconds * sampleRate));
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Equal-power pan. pan in [-1,1]. Returns [left, right]. */
export function panGains(pan: number): [number, number] {
  const p = (clamp(pan, -1, 1) + 1) * 0.125; // map to [0, 0.25] turns
  return [cosTurns(p), sinTurns(p)];
}
