/**
 * Nullsample rating collector.
 *
 * Private tooling. It receives one rating at a time from the phone, keeps them
 * in KV, and hands them back to `npm run narrow` and to the tuning workflow.
 *
 * This does not touch audio and does not participate in rendering: the product
 * itself is still a static site that renders on the user's device. The third
 * non-negotiable is about the product, and this stays inside the free tier —
 * a full M5 batch is about 200 writes against a 1,000/day allowance.
 *
 * Bindings expected:
 *   RATINGS        KV namespace
 *   RATE_SECRET    secret, sent by the phone as the x-rate-key header
 *   GITHUB_TOKEN   secret, optional; only used to fire the tuning workflow
 *   GITHUB_REPO    var, optional, "owner/repo"
 */

const ORIGIN = "https://nullsample.maqsudjon.com";

/** Ratings needed before a cycle is worth running. */
const DISPATCH_THRESHOLD = 40;

function cors(extra = {}) {
  return {
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-rate-key",
    "access-control-max-age": "86400",
    ...extra,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: cors({ "content-type": "application/json" }),
  });
}

/** Constant-time-ish comparison, so a wrong key cannot be probed byte by byte. */
function secretMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function safeId(s) {
  return typeof s === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(s);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (!secretMatches(request.headers.get("x-rate-key"), env.RATE_SECRET)) {
      return json({ error: "unauthorised" }, 401);
    }

    // --- write one rating ---------------------------------------------------
    if (request.method === "POST" && url.pathname === "/r") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json" }, 400);
      }
      const { batchId, trackId, pass, scores, session, skipped } = body ?? {};
      if (!safeId(batchId) || !safeId(trackId) || !safeId(String(pass)) || !safeId(session ?? "s")) {
        return json({ error: "bad ids" }, 400);
      }
      if (!skipped && (typeof scores !== "object" || scores === null)) {
        return json({ error: "no scores" }, 400);
      }
      for (const [k, v] of Object.entries(scores ?? {})) {
        if (!["hook", "punch", "space", "interest"].includes(k)) {
          return json({ error: `unknown axis ${k}` }, 400);
        }
        if (!Number.isInteger(v) || v < 1 || v > 5) {
          return json({ error: `bad score for ${k}` }, 400);
        }
      }
      // Last write wins: re-rating a track simply overwrites.
      const key = `rating:${batchId}:${trackId}:${pass}`;
      const value = {
        batchId, trackId, pass,
        scores: scores ?? {},
        skipped: skipped === true,
        session: session ?? "s",
        at: new Date().toISOString(),
      };
      await env.RATINGS.put(key, JSON.stringify(value));

      // KV list() is eventually consistent - a key can take up to a minute to
      // appear in it. Rating the last track and immediately running `narrow`
      // would then read a short batch and say nothing about it, which is the
      // one failure mode worth engineering against here. So every write also
      // appends its key to a single recent-writes index, which GET reads
      // directly: get() on a known key does not have list()'s lag.
      //
      // Single writer in practice (one phone, one queue), so the
      // read-modify-write is safe.
      const idxKey = `recent:${batchId}`;
      const idx = (await env.RATINGS.get(idxKey, "json")) ?? [];
      if (!idx.includes(key)) {
        idx.push(key);
        // bounded: older entries will have reached list() long ago
        while (idx.length > 400) idx.shift();
        await env.RATINGS.put(idxKey, JSON.stringify(idx));
      }
      return json({ ok: true, key });
    }

    // --- read a batch -------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/r") {
      const batch = url.searchParams.get("batch");
      if (!safeId(batch ?? "")) return json({ error: "bad batch" }, 400);
      const seen = new Set();
      const out = [];
      let cursor;
      do {
        const page = await env.RATINGS.list({ prefix: `rating:${batch}:`, cursor });
        for (const k of page.keys) {
          const v = await env.RATINGS.get(k.name, "json");
          if (v) {
            seen.add(k.name);
            out.push(v);
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);

      // Anything written too recently to be in list() yet
      const idx = (await env.RATINGS.get(`recent:${batch}`, "json")) ?? [];
      let lateCount = 0;
      for (const k of idx) {
        if (seen.has(k)) continue;
        const v = await env.RATINGS.get(k, "json");
        if (v) {
          out.push(v);
          lateCount++;
        }
      }
      return json({ batchId: batch, count: out.length, fromIndex: lateCount, ratings: out });
    }

    // --- ask whether a new cycle should run --------------------------------
    //
    // Called by the phone after a rating lands. The Worker holds the GitHub
    // token, not the phone: a token that can write ratings is harmless on a
    // lost device, and one that can write code is not.
    if (request.method === "POST" && url.pathname === "/cycle") {
      const { batchId } = await request.json().catch(() => ({}));
      if (!safeId(batchId ?? "")) return json({ error: "bad batch" }, 400);
      const marker = `dispatched:${batchId}`;
      const already = await env.RATINGS.get(marker);
      const page = await env.RATINGS.list({ prefix: `rating:${batchId}:` });
      const idx = (await env.RATINGS.get(`recent:${batchId}`, "json")) ?? [];
      const names = new Set(page.keys.map((k) => k.name));
      for (const k of idx) names.add(k);
      const n = names.size;
      if (n < DISPATCH_THRESHOLD) return json({ dispatched: false, count: n });
      if (already) return json({ dispatched: false, count: n, reason: "already dispatched" });
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
        return json({ dispatched: false, count: n, reason: "no github binding" });
      }
      const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "user-agent": "nullsample-rate-worker",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event_type: "ratings-ready", client_payload: { batchId, count: n } }),
      });
      if (!res.ok) return json({ dispatched: false, count: n, status: res.status }, 502);
      await env.RATINGS.put(marker, new Date().toISOString(), { expirationTtl: 86400 });
      return json({ dispatched: true, count: n });
    }

    return json({ error: "not found" }, 404);
  },
};
