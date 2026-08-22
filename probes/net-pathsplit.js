// name:        path split
// description: differential RTT between a router-rejected call and an
//              upstream-rejected call, isolating the router->provider network
//              leg with no GPU, no queueing and no vantage dependence
// author:      pjperez
// version:     2.2.0
// calls:       up to 23 per run: up to 3 cascade probes + 20 measurement calls
//              (10 interleaved A/B pairs). EVERY call is deliberately rejected
//              with max_tokens: 1, so ZERO completion tokens are billed and each
//              carries ~2 prompt tokens — the whole probe costs nothing in
//              tokens despite the call count, and finishes in ~3s. Bails after 1
//              call on an auth/credit/throttle failure, and after 1-3 on a lane
//              with no upstream rejection path. Tested on OpenRouter.

export const meta = {
  id: "net-pathsplit", name: "path split", group: "timing",
  why: "router-rejected vs upstream-rejected latency isolates the provider RTT",
  long: false, author: "pjperez", version: "2.2.0",
};

// A client-measured latency to an aggregator is dominated by the client's own
// distance to the aggregator edge, so it fingerprints the observer, not the lab.
// v1 of this probe took the router's /api/v1/generation ledger at its word.
// Live measurement killed that premise three ways: the ledger is written
// ASYNCHRONOUSLY and 404s for the first 4-15 seconds, its `latency` field is
// wildly noisy (three identical calls: 735ms / 6261ms / 27272ms), and prefill
// sits so far below that noise floor that 900 extra prompt tokens measured as
// NEGATIVE time. No amount of bucketing rescues a 26-second spread.
//
// What survives is a differential. Send two calls that are both REJECTED, so
// neither reaches a GPU and neither can queue behind other users' work:
//
//   A arm — frequency_penalty: 9. The router rejects this itself, locally, on
//           every model. The error body carries metadata.provider_name = null.
//           Cost = client -> router -> client.
//   B arm — a payload the router FORWARDS and the real provider rejects at its
//           own API layer. The error body NAMES metadata.provider_name.
//           Cost = client -> router -> PROVIDER -> back.
//
//   delta = floor(B) - floor(A)  ~  router <-> provider round trip
//
// The client's own leg appears in both arms and cancels in the subtraction,
// which is what makes delta vantage-independent: identical for every user on
// earth. Calibrated against providers of known geography, from OpenRouter's
// origin: Together US 193/186ms, DeepInfra US 206ms, Azure 228ms, Moonshot CN
// 235ms, Z.AI CN 253/255ms, Baidu CN 285ms, Alibaba CN/SG 305/316ms. Clusters
// sit 60-120ms apart while reruns reproduce within 2-11ms.

// No single payload is rejected upstream by every provider — some validate it,
// some happily burn a GPU on it. So probe a cascade and take the first that the
// UPSTREAM rejects. Measured grid (UPSTREAM-REJ = rejected, provider named):
//                  temp2.0        badfmt         toplogprobs25
//   ox-alpha       UPSTREAM-REJ   accept(gpu)    accept(gpu)
//   Z.AI           UPSTREAM-REJ   accept(gpu)    accept(gpu)
//   DeepInfra      accept(gpu)    UPSTREAM-REJ   accept(gpu)
//   Together       UPSTREAM-REJ   UPSTREAM-REJ   accept(gpu)
//   Alibaba        UPSTREAM-REJ   UPSTREAM-REJ   UPSTREAM-REJ
const POISONS = [
  ["temp2.0", { temperature: 2.0 }],
  ["badfmt", { response_format: { type: "not_a_real_format" } }],
  ["toplogprobs25", { logprobs: true, top_logprobs: 25 }],
];

// Always router-rejected, never forwarded (temperature: -1 behaves the same
// way). That is precisely why it is the baseline arm.
const BASELINE = { frequency_penalty: 9 };

// Measured, not guessed. At 4 pairs the Together lane produced deltas of
// 166 / 110 / 103 ms across three runs — a 63ms spread that straddles the
// 150ms boundary and reports UNSTABLE. Its B samples were 633,407,207,212:
// four draws simply never reached the true floor. At 10 pairs the same lane
// draws 134-193 and yields 100 / 102 / 104 (4ms spread). Every lane tested
// tightened to <=4ms at 10 pairs (ox-alpha 1ms, Novita 1ms, DeepInfra 4ms),
// which is what the bucket boundaries assume. The extra calls are free: every
// one is rejected, so no completion tokens are ever billed.
const PAIRS = 10;

// Boundaries sit in the MIDDLE of the gaps between observed lane clusters, so
// ordinary jitter cannot walk a lane across one. Measured deltas (min-of-10,
// three repeats each): Together 100-114 | ox-alpha 183-196 | DeepInfra 185-203
// | Novita 226-246 | Z.AI 236-251 | Baidu ~285 | Alibaba 300-325.
//
// The first boundary set placed cuts at 225 and 300. Live runs showed both were
// unsafe: Novita drew 226 against the 225 cut (1ms of margin) and Alibaba
// straddled 300 outright, flipping bucket between two runs and reporting
// UNSTABLE. Re-centring to 215 and 270 restores >=11ms of margin on every
// observed lane while keeping the discrimination that matters — ox-alpha and
// DeepInfra land in one bucket, Novita and Z.AI in the next.
const RTT_BANDS = [
  [80, "rtt<80ms"], [150, "rtt80-150ms"], [215, "rtt150-215ms"],
  [270, "rtt215-270ms"], [400, "rtt270-400ms"], [Infinity, "rtt>400ms"],
];

function band(v, bands) {
  for (const [hi, label] of bands) if (v < hi) return label;
  return bands[bands.length - 1][1];
}

function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

// Classify one answer. ORDER MATTERS.
//
// OpenRouter passes the UPSTREAM's status code straight through, so no status
// allow-list can be correct: DeepInfra rejects a bad response_format with 422
// (its own validation prose buried in metadata.raw, "Input should be 'text'"),
// while Novita and Alibaba reject with 400. All three are real upstream
// rejections. What they share is not a status code — it is that the provider
// NAMED ITSELF in metadata.provider_name, which is only possible if the packet
// completed the full round trip. So provider_name is the decisive signal and it
// must be tested FIRST, before any status reasoning.
//
// Only once no provider is named does the status mean anything, and then it
// separates the account/transport from the lane: 401/403 auth, 402 out of
// credits, 408/429 throttling, any 5xx, or 0 for a network/CORS failure.
//
// That guard is load-bearing, not pedantry. When an account runs out of credits
// EVERY lane answers 402, and without it the cascade finds no upstream rejection
// anywhere and reports a confident "no-upstream-reject-path" for every model at
// once. That reads like a unanimous fingerprint but is only a dead key — a fake
// absence dressed up as a finding, which is worse than the honest absence the
// README asks for. Same for a 429 storm on free lanes.
const INFRA_STATUS = new Set([0, 401, 402, 403, 408, 429]);

function classify(r) {
  // 1. the provider named itself => the round trip happened => real evidence
  if (r.pn) return "upstream";
  // 2. nobody upstream answered, so the status describes the account/transport
  if (typeof r.status !== "number") return "infra";
  if (INFRA_STATUS.has(r.status) || r.status >= 500) return "infra";
  // 3. 2xx (poison accepted) or a 4xx the router rejected locally
  return "other";
}

const floorOf = (xs) => {
  const ok = xs.filter((v) => typeof v === "number" && isFinite(v));
  return ok.length ? Math.min(...ok) : null;
};

// The harness hands back the provider's error body verbatim as a string; some
// adapters may already have parsed it. Accept either, never throw on garbage.
function errBody(res) {
  const e = res && res.error;
  if (!e) return null;
  if (typeof e === "object") return e;
  if (typeof e === "string") { try { return JSON.parse(e); } catch { return null; } }
  return null;
}

// Present and non-empty => the REAL provider rejected it, so the packet made the
// full round trip. Absent/null => the router rejected it locally.
function providerName(res) {
  const j = errBody(res);
  const meta = j && j.error && j.error.metadata;
  const pn = meta && meta.provider_name;
  return typeof pn === "string" && pn ? pn : null;
}

// Which edge the measurement STARTED from, so the RTT has an anchor.
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

async function shot(ctx, extra) {
  const res = await ctx.chat({
    messages: [{ role: "user", content: "ok" }], max_tokens: 1, ...extra,
  });
  if (!res) return { ok: false, ms: null, pn: null, status: "no-response", body: null };
  return {
    ok: res.ok === true, ms: num(res.ms), pn: providerName(res),
    status: res.status, headers: res.headers || null,
    body: typeof res.error === "string" ? res.error.slice(0, 300) : res.error || null,
  };
}

export async function probe(ctx) {
  try {
    // ---- cascade: find a payload the UPSTREAM rejects, cheapest path first.
    const grid = [];
    let poison = null, poisonName = null, provider = null, firstHeaders = null;
    for (const [name, payload] of POISONS) {
      const r = await shot(ctx, payload);
      if (r.headers && !firstHeaders) firstHeaders = r.headers;
      grid.push({ poison: name, ok: r.ok, status: r.status, providerName: r.pn,
                  ms: r.ms, body: r.body });
      const kind = classify(r);
      // Infrastructure failure: stop now. Continuing would let a dead key or a
      // throttled account masquerade as a statement about this provider.
      if (kind === "infra")
        return { value: "probe-failed: " + r.status, raw: { grid } };
      if (kind === "upstream") {
        // The provider named itself in the rejection, so the packet reached it.
        if (r.ms === null)
          // engine.js returns ms on the error path; probe-bench's mock ctx does
          // not. Without it there is nothing to difference — say so, do not fake.
          return { value: "harness-lacks-timing", raw: { grid, note: "no ms on rejection path" } };
        poison = payload; poisonName = name; provider = r.pn;
        break;
      }
    }
    if (!poison)
      return { value: "no-upstream-reject-path", raw: { grid } };

    // ---- interleave A,B,A,B... so any drift in load or routing hits both arms
    // equally. Running all A then all B would let a warm-up or a slow minute
    // land on one arm only and poison the difference.
    const aS = [], bS = [], aRaw = [], bRaw = [];
    let baselineForeign = false;
    for (let i = 0; i < PAIRS; i++) {
      const a = await shot(ctx, BASELINE);
      aRaw.push({ ok: a.ok, status: a.status, providerName: a.pn, ms: a.ms });
      const aKind = classify(a);
      // A named provider on the baseline means the router FORWARDED it, so it is
      // not a local baseline at all. That is checked before the infra guard,
      // because provider_name outranks the status code here too.
      if (aKind === "upstream") baselineForeign = true;
      // Same guard on the measurement arms. Quietly dropping an infra-failed
      // sample and taking the floor of whatever survived is how a confident
      // number gets computed from two lucky calls.
      else if (aKind === "infra")
        return { value: "probe-failed: " + a.status,
                 raw: { grid, poison: poisonName, provider, aSamples: aRaw, bSamples: bRaw } };
      else if (!a.ok && a.ms !== null) aS.push(a.ms);

      const b = await shot(ctx, poison);
      bRaw.push({ ok: b.ok, status: b.status, providerName: b.pn, ms: b.ms });
      const bKind = classify(b);
      // Counted whatever the status: DeepInfra says 422, Novita says 400, and
      // both are genuine upstream rejections.
      if (bKind === "upstream") { if (b.ms !== null) bS.push(b.ms); }
      else if (bKind === "infra")
        return { value: "probe-failed: " + b.status,
                 raw: { grid, poison: poisonName, provider, aSamples: aRaw, bSamples: bRaw } };
      if (b.headers && !firstHeaders) firstHeaders = b.headers;
    }

    const colo = edgeColo(firstHeaders);
    const rawBase = { grid, poison: poisonName, provider, aSamples: aRaw,
                      bSamples: bRaw, edgeColo: colo || null, headers: firstHeaders };

    // The baseline must be a LOCAL rejection. If the router forwarded it, it is
    // not a baseline at all and the difference would be meaningless.
    if (baselineForeign)
      return { value: "baseline-not-local", raw: rawBase };
    if (!aS.length)
      return { value: "baseline-not-local", raw: rawBase };
    // The cascade proved this payload is upstream-rejected; if it stopped being
    // so mid-measurement the lane is flapping and the delta cannot be trusted.
    if (!bS.length)
      return { value: "upstream-reject-unstable", raw: rawBase };

    // Minimum of K on both arms: a floor is what strips queueing and jitter out
    // of a network measurement. Rejected calls cannot queue behind GPU work, so
    // the floors converge tightly (reruns reproduced within 2-11ms).
    const floorA = floorOf(aS), floorB = floorOf(bS);
    const deltaMs = floorB - floorA;

    // The poison NAME is part of the value: different payloads are validated at
    // different depths in a provider's stack, so a delta measured with temp2.0
    // is not comparable to one measured with badfmt.
    const parts = [provider, poisonName, band(deltaMs, RTT_BANDS), colo].filter(Boolean);
    return {
      value: parts.join(" · "),
      raw: { ...rawBase, floorAMs: +floorA.toFixed(1), floorBMs: +floorB.toFixed(1),
             deltaMs: +deltaMs.toFixed(1), aUsable: aS.length, bUsable: bS.length },
    };
  } catch (e) {
    return { value: "probe-failed: " + ((e && e.message) || "error") };
  }
}
