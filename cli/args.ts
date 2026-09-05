/** Minimal argument parsing. Shared by every CLI entry point. */

export interface Args {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function str(args: Args, key: string, fallback: string): string {
  const v = args.flags[key];
  return typeof v === "string" ? v : fallback;
}

export function num(args: Args, key: string, fallback: number): number {
  const v = args.flags[key];
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(args: Args, key: string): boolean {
  return args.flags[key] === true || args.flags[key] === "true";
}

/** Word slider values, given as --darker=-0.4 --harder=0.8 --wider=0.2 */
export function words(args: Args): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of ["darker", "harder", "wider"]) {
    const v = args.flags[name];
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) out[name] = Math.max(-1, Math.min(1, n));
    }
  }
  return out;
}
