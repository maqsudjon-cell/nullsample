#!/usr/bin/env node
/**
 * The determinism lint. Fails the build, not just a warning.
 *
 * Two classes of rule:
 *
 * 1. Non-determinism. Math.random is the obvious one. The transcendentals are
 *    the subtle one: ECMAScript specifies Math.sin, exp, log, pow and sqrt as
 *    "implementation-approximated", and engines genuinely differ in the last
 *    ulp. core/dmath.ts provides exact-arithmetic replacements for all of them.
 *    Wall-clock reads are banned for the same reason.
 *
 * 2. TypeScript syntax Node cannot strip. The engine runs unbundled under
 *    Node's type stripping, which erases types but performs no transforms, so
 *    enums, parameter properties and namespaces would fail only at runtime.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Directories whose output must be bit-identical on every host. */
const ENGINE = ["core", "compose", "presets", "render"];
/** Directories that must at least never call Math.random. */
const NO_RANDOM_ONLY = ["cli", "web", "test"];

const TRANSCENDENTAL =
  "sin|cos|tan|asin|acos|atan|atan2|exp|expm1|log|log2|log10|log1p|pow|sqrt|cbrt|hypot|sinh|cosh|tanh|asinh|acosh|atanh";

const RULES = [
  {
    id: "no-math-random",
    re: /\bMath\s*\.\s*random\b/g,
    msg: "Math.random() — take a value from the seeded Rng instead",
    scope: "all",
  },
  {
    id: "no-transcendentals",
    re: new RegExp(`\\bMath\\s*\\.\\s*(${TRANSCENDENTAL})\\b`, "g"),
    msg: "implementation-approximated Math function — use the equivalent from core/dmath.ts",
    scope: "engine",
  },
  {
    id: "no-exponent-operator",
    re: /[^*\s=][\s]*\*\*[\s]*[^*=]/g,
    msg: "** is Math.pow by another name — use dpow() or write the multiplication out",
    scope: "engine",
  },
  {
    id: "no-wall-clock",
    re: /\bDate\s*\.\s*now\b|\bnew\s+Date\b|\bperformance\s*\.\s*now\b/g,
    msg: "wall-clock read — nothing in the render path may depend on time",
    scope: "engine",
  },
  {
    id: "no-unordered-iteration",
    re: /\bfor\s*\(\s*const\s+\w+\s+in\s+/g,
    msg: "for..in iterates in an order the spec does not fully pin down — use an explicit array",
    scope: "engine",
  },
  {
    id: "no-enum",
    re: /^\s*(export\s+)?(const\s+)?enum\s+/gm,
    msg: "enum — Node's type stripping cannot synthesise it; use a `const` object with `as const`",
    scope: "all",
  },
  {
    id: "no-parameter-properties",
    re: /constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+\s*[:,)]/g,
    msg: "parameter property — Node's type stripping cannot expand it; assign in the body",
    scope: "all",
  },
  {
    id: "no-namespace",
    re: /^\s*(export\s+)?namespace\s+\w/gm,
    msg: "namespace — Node's type stripping cannot expand it",
    scope: "all",
  },
];

/** Blanks out comments and string bodies so prose never trips a rule. */
function strip(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && c2 === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const q = c; out += " "; i++;
      while (i < n) {
        if (src[i] === "\\") { out += "  "; i += 2; continue; }
        if (src[i] === q) { out += " "; i++; break; }
        out += src[i] === "\n" ? "\n" : " "; i++;
      }
    } else { out += c; i++; }
  }
  return out;
}

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p, acc); }
    else if (/\.(ts|mts|mjs|js)$/.test(e) && !e.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

let failures = 0;
let checked = 0;

for (const [dirs, scope] of [[ENGINE, "engine"], [NO_RANDOM_ONLY, "other"]]) {
  for (const d of dirs) {
    for (const file of walk(join(ROOT, d))) {
      const src = readFileSync(file, "utf8");
      const clean = strip(src);
      checked++;
      for (const rule of RULES) {
        if (rule.scope === "engine" && scope !== "engine") continue;
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(clean)) !== null) {
          const line = clean.slice(0, m.index).split("\n").length;
          const text = src.split("\n")[line - 1].trim();
          console.error(`${relative(ROOT, file)}:${line}  [${rule.id}] ${rule.msg}`);
          console.error(`    ${text}`);
          failures++;
        }
      }
    }
  }
}

if (failures > 0) {
  console.error(`\ndeterminism lint: ${failures} violation${failures === 1 ? "" : "s"} in ${checked} files`);
  process.exit(1);
}
console.log(`determinism lint: clean (${checked} files)`);
