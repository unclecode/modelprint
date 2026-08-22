// name:        path split
// description: splits the measured latency into the router->provider leg and the
//              client->router leg, then buckets the upstream network floor and the
//              prefill slope, fingerprinting the REAL provider instead of the edge
// author:      pjperez
// version:     1.0.0
// calls:       ~4 API calls per run, tested on OpenRouter (3 pinned short calls +
//              1 pinned long call, all max_tokens: 1), plus one authenticated GET
//              to the generation ledger per call.

export const meta = {
  id: "net-pathsplit", name: "path split", group: "timing",
  why: "router-side latency minus moderation is the upstream leg: vantage-independent",
  long: false, author: "pjperez", version: "1.0.0",
};

// A latency measured in the client is dominated by the client's own distance to
// the aggregator's edge, so it says nothing about who runs the weights. The
// router's ledger (/api/v1/generation) reports latency, moderation_latency and
// generation_time as measured ROUTER-SIDE, which splits the path in two:
//
//   latency - moderation_latency  ~ OpenRouter -> real provider (RTT + prefill)
//   res.ttftMs - latency          ~ this user -> OpenRouter edge
//
// The first leg is identical for every user on earth, so it is a property of the
// upstream, not of the observer — a legitimate fingerprint. The second is pure
// vantage and is kept in raw only. Firing the same call at two very different
// pinned prompt sizes separates the two components of the upstream leg: the
// SLOPE (us per prompt token) is the accelerator/serving-stack signature, while
// the INTERCEPT (floor minus slope*tokens) is the network distance class from
// the router to the provider. Both are snapped into wide bands, since the
// contract forbids raw milliseconds in a value.

const SMALL_PROMPT = "ok";
// Fixed literal, repeated a fixed number of times: deterministic token count on
// every run and every tokenizer. Never randomize this.
const BIG_PROMPT =
  "The quick brown fox jumps over the lazy dog near the quiet river bank. "
    .repeat(60) + "ok";

// Wide, clearly separated bands. Run-to-run jitter is tens of milliseconds at
// worst after taking a floor, so it cannot walk a lane across a boundary.
const NET_BANDS = [
  [20, "up<20ms"], [60, "up20-60ms"], [120, "up60-120ms"],
  [250, "up120-250ms"], [Infinity, "up>250ms"],
];
const SLOPE_BANDS = [
  [25, "pf<25us/tok"], [100, "pf25-100us/tok"], [300, "pf100-300us/tok"],
  [800, "pf300-800us/tok"], [Infinity, "pf>800us/tok"],
];

function band(v, bands) {
  for (const [hi, label] of bands) if (v < hi) return label;
  return bands[bands.length - 1][1];
}

// Which edge the measurement STARTED from, so the upstream leg has an anchor.
// net-headerdna only records that cf-ray exists; the colo suffix is the new bit.
function edgeColo(h) {
  if (!h) return "";
  const ray = h["cf-ray"];
  if (typeof ray === "string") {
    const m = ray.match(/-([A-Za-z]{3})$/);
    if (m) return "cf:" + m[1].toUpperCase();
  }
  const pop = h["x-amz-cf-pop"];
  if (typeof pop === "string" && pop) return "cfpop:" + pop.slice(0, 3).toUpperCase();
  const fly = h["fly-region"];
  if (typeof fly === "string" && fly) return "fly:" + fly.toUpperCase();
  const vercel = h["x-vercel-id"];
  if (typeof vercel === "string" && vercel)
    return "vercel:" + vercel.split(":")[0].slice(0, 4).toUpperCase();
  return "";
}

function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

async function sample(ctx, content) {
  const res = await ctx.chat({
    messages: [{ role: "user", content }], max_tokens: 1,
  });
  if (!res || !res.ok)
    return { failed: true, status: res ? res.status : "no-response" };
  const headers = res.headers || null;
  const gid = (headers && headers["x-generation-id"]) || res.id || null;
  let rec = null, recStatus = null;
  if (gid) {
    const r = await ctx.http("/api/v1/generation?id=" + encodeURIComponent(gid));
    recStatus = r ? r.status : null;
    if (r && r.json && r.json.data) rec = r.json.data;
  }
  const lat = rec ? num(rec.latency) : null;
  const mod = rec ? num(rec.moderation_latency) : null;
  const upstreamMs = lat === null ? null : lat - (mod === null ? 0 : mod);
  const ttftMs = num(res.ttftMs);
  return {
    failed: false, gid, recStatus, rec, headers, upstreamMs, ttftMs,
    clientLegMs: ttftMs === null || upstreamMs === null ? null : ttftMs - upstreamMs,
    promptTokens: num(rec && rec.native_tokens_prompt) ??
      num(res.usage && res.usage.prompt_tokens),
    generationTimeMs: rec ? num(rec.generation_time) : null,
    totalMs: num(res.ms),
  };
}

const floorOf = (xs) => {
  const ok = xs.filter((v) => typeof v === "number" && isFinite(v));
  return ok.length ? Math.min(...ok) : null;
};

export async function probe(ctx) {
  try {
    if (typeof ctx.http !== "function") return { value: "harness-lacks-http" };

    const smalls = [];
    for (let i = 0; i < 3; i++) {
      const s = await sample(ctx, SMALL_PROMPT);
      if (s.failed) return { value: "probe-failed: " + s.status };
      smalls.push(s);
    }
    const big = await sample(ctx, BIG_PROMPT);
    if (big.failed) return { value: "probe-failed: " + big.status };

    const all = smalls.concat([big]);
    const headers = (all.find((s) => s.headers && Object.keys(s.headers).length) || {}).headers || {};
    const colo = edgeColo(headers);
    const rawBase = {
      samples: all.map((s) => ({
        gid: s.gid, recStatus: s.recStatus, upstreamMs: s.upstreamMs,
        ttftMs: s.ttftMs, clientLegMs: s.clientLegMs, totalMs: s.totalMs,
        promptTokens: s.promptTokens, generationTimeMs: s.generationTimeMs,
      })),
      records: all.map((s) => s.rec),
      // vantage-dependent, therefore never part of the value
      clientLegFloorMs: floorOf(all.map((s) => s.clientLegMs)),
      edgeColo: colo || null, headers,
    };

    if (!all.some((s) => s.gid))
      return { value: "no-generation-record", raw: rawBase };
    if (!all.some((s) => s.rec))
      return {
        value: all.some((s) => s.recStatus === 404) ? "record-not-found"
          : "no-generation-record",
        raw: rawBase,
      };

    const smallFloor = floorOf(smalls.map((s) => s.upstreamMs));
    const bigUp = big.upstreamMs;
    if (smallFloor === null) {
      // The ledger exists but carries no router-side latency: say so, do not guess.
      const clientOnly = floorOf(all.map((s) => s.ttftMs));
      return {
        value: clientOnly === null ? "harness-lacks-timing" : "record-lacks-latency",
        raw: rawBase,
      };
    }

    const smallTok = floorOf(smalls.map((s) => s.promptTokens));
    const bigTok = big.promptTokens;
    let slopeUsPerTok = null, interceptMs = smallFloor;
    if (bigUp !== null && smallTok !== null && bigTok !== null && bigTok > smallTok) {
      const perTokMs = (bigUp - smallFloor) / (bigTok - smallTok);
      slopeUsPerTok = Math.max(0, perTokMs * 1000);
      interceptMs = Math.max(0, smallFloor - (slopeUsPerTok / 1000) * smallTok);
    }

    const rec0 = (all.find((s) => s.rec) || {}).rec || {};
    const parts = [
      rec0.provider_name || "provider-unknown",
      rec0.data_region || "global",
      band(interceptMs, NET_BANDS),
      slopeUsPerTok === null ? "pf-unknown" : band(slopeUsPerTok, SLOPE_BANDS),
      colo,
    ].filter(Boolean);

    return {
      value: parts.join(" · "),
      raw: {
        ...rawBase,
        upstreamFloorSmallMs: smallFloor, upstreamLargeMs: bigUp,
        promptTokensSmall: smallTok, promptTokensLarge: bigTok,
        slopeUsPerTok: slopeUsPerTok === null ? null : +slopeUsPerTok.toFixed(1),
        interceptMs: +interceptMs.toFixed(1),
        provider: rec0.provider_name || null, dataRegion: rec0.data_region || null,
      },
    };
  } catch (e) {
    return { value: "probe-failed: " + ((e && e.message) || "error") };
  }
}
