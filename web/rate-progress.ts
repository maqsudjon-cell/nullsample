/**
 * The progress screen.
 *
 * An unattended loop the human cannot inspect is worse than a manual one, so
 * this shows what the loop did and why, and carries the only control it has:
 * a pause. Reads `tuning.json`, which every cycle commits alongside the weight
 * change that produced it.
 */

/** null where an axis has not been rated yet - see cli/tune.ts. */
interface CycleAxisScores {
  hook: number | null;
  punch: number | null;
  space: number | null;
  interest: number | null;
}
interface Move { param: string; from: number[]; to: number[]; axis: string; r: number; n: number }
interface Cycle {
  cycle: number;
  at: string;
  batchId: string;
  rated: number;
  scores: CycleAxisScores;
  moved: Move[];
  skipped: { param: string; reason: string }[];
  discardedSessions: { session: string; agreement: number; reason: string }[];
  selfAgreement: number;
  stopped?: string;
}
interface Tuning { cycles: Cycle[]; paused: boolean; stopped?: string }

const AXES = ["hook", "punch", "space", "interest"] as const;
const COLOURS = ["#FF6A1A", "#838C99", "#D8DCE2", "#B34A12"];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function drawTrend(cycles: Cycle[]): void {
  const c = $("trend") as unknown as HTMLCanvasElement;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth || 340;
  const h = 200;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = 18;
  ctx.strokeStyle = "#1C2028";
  ctx.lineWidth = 1;
  for (let s = 1; s <= 5; s++) {
    const y = h - pad - ((s - 1) / 4) * (h - pad * 2);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }
  if (cycles.length === 0) return;
  const n = Math.max(1, cycles.length - 1);
  AXES.forEach((axis, i) => {
    ctx.strokeStyle = COLOURS[i];
    ctx.lineWidth = 2;
    ctx.beginPath();
    // An unrated axis leaves a gap rather than a line to zero: plotting "not
    // rated" as a score would read as "rated terrible".
    let drawing = false;
    cycles.forEach((cy, k) => {
      const v = cy.scores[axis];
      if (typeof v !== "number") {
        drawing = false;
        return;
      }
      const x = pad + (k / n) * (w - pad * 2);
      const y = h - pad - ((v - 1) / 4) * (h - pad * 2);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

async function main(): Promise<void> {
  let t: Tuning;
  try {
    t = await (await fetch("/rate/tuning.json", { cache: "no-cache" })).json();
  } catch {
    $("status").textContent = "No cycles have run yet.";
    return;
  }
  const cycles = t.cycles ?? [];
  const last = cycles[cycles.length - 1];
  const rated = cycles.reduce((s, c) => s + c.rated, 0);
  const discarded = cycles.reduce((s, c) => s + c.discardedSessions.length, 0);
  // "Cycle 0, 0 tracks rated" is a reading; "nothing has happened yet" is the
  // truth. The file exists from the first build so the fetch never 404s, which
  // means the empty case has to be handled here rather than in a catch.
  $("status").textContent = cycles.length === 0
    ? "No cycles have run yet."
    : t.stopped
      ? `Tuning complete — ${t.stopped}. ${cycles.length} cycles, ${rated} tracks rated.`
      : `Cycle ${cycles.length}. ${rated} tracks rated, ${discarded} sessions discarded.${t.paused ? " Paused." : ""}`;

  drawTrend(cycles);
  $("legend").innerHTML = AXES
    .map((a, i) => {
      const v = last ? last.scores[a] : undefined;
      const shown = typeof v === "number" ? ` ${v.toFixed(2)}` : last ? " —" : "";
      return `<span style="color:${COLOURS[i]}">${a}${shown}</span>`;
    })
    .join("   ");

  const moved = $("moved");
  const moves = last?.moved ?? [];
  if (moves.length === 0) {
    moved.innerHTML = cycles.length === 0
      ? `<li>Nothing yet.</li>`
      : `<li>Nothing cleared the confidence bar this cycle.</li>`;
  } else {
    moved.innerHTML = moves
      .map((m) => `<li><b>${m.param}</b> — ${m.axis}, r=${m.r.toFixed(2)} over ${m.n} tracks</li>`)
      .join("");
  }

  $("agreement").textContent = last
    ? `Self-agreement ${(last.selfAgreement * 100).toFixed(0)}% on the repeat tracks.`
    : "";
  const dis = $("discards");
  const all = cycles.flatMap((c) => c.discardedSessions);
  dis.innerHTML = all.length === 0
    ? `<li>No sessions discarded.</li>`
    : all.map((d) => `<li>${d.session} — ${d.reason} (agreement ${(d.agreement * 100).toFixed(0)}%)</li>`).join("");

  const btn = $("pause") as HTMLButtonElement;
  const setLabel = () => {
    const paused = localStorage.getItem("ns.tune.paused") === "1" || t.paused;
    btn.textContent = paused ? "Cycles paused — resume" : "Pause new cycles";
  };
  setLabel();
  btn.addEventListener("click", async () => {
    const paused = localStorage.getItem("ns.tune.paused") === "1" || t.paused;
    localStorage.setItem("ns.tune.paused", paused ? "0" : "1");
    t.paused = !paused;
    setLabel();
  });
}

void main();

export {};
