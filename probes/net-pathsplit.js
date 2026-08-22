// name:        path split
// description: which upstream provider answers a lane and which payload it
//              refuses, plus a GPU-free router->provider RTT measurement in raw
// author:      pjperez
// version:     3.0.0
// calls:       up to 13 per run: up to 3 cascade probes + 10 measurement calls
//              (5 interleaved A/B pairs). EVERY call is deliberately rejected
//              with max_tokens: 1, so ZERO completion tokens are billed and each
//              carries ~2 prompt tokens — the whole probe costs nothing in
//              tokens, and finishes in ~2s. Bails after 1 call on an
//              auth/credit/throttle failure, and after 1-3 on a lane with no
//              upstream rejection path. Tested on OpenRouter.

export const meta = {
  id: "net-pathsplit", name: "path split", group: "timing",
  why: "names the upstream provider and the payload it refuses; RTT lives in raw",
  long: false, author: "pjperez", version: "3.0.0",
};

// WHAT THE VALUE IS. Two things that are stable for a given lane: which
// upstream provider actually answers, and which payload that provider refuses.
// The second is a real stack signature — providers validate different
// parameters at different depths, and the cascade grid below shows ox-alpha and
// Z.AI refusing temperature 2.0 while DeepInfra happily burns a GPU on it and
// refuses a bad response_format instead.
//
// WHAT THE VALUE IS NOT. The RTT measurement and the edge colo are deliberately
// kept OUT of the value and reported in raw:
//   - a timing band can flip between two runs of the SAME model, and the
//     comparison table would then show a difference that is not there;
//   - the colo describes the VISITOR, not the model, and value strings travel
//     into public share links.
// The numbers are still in the JSON export for anyone doing the analysis.
//
// HOW THE TIMING IN raw IS MEASURED. A client-measured latency to an aggregator
// is dominated by the client's own distance to the aggregator edge, so it
// fingerprints the observer, not the lab. Send two calls that are both
// REJECTED, so neither reaches a GPU and neither can queue behind other users'
// work:
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
// The client's own leg appears in both arms and cancels in the subtraction, so
// delta is vantage-independent. Calibrated against providers of known geography
// from OpenRouter's origin, with a fixed poison and 12 pairs: BaseTen US
// 159-167ms, ox-alpha 179-189ms, Z.AI CN 236-243ms, Alibaba CN/SG 296-308ms.
//
// The delta is an UPPER BOUND on network RTT, not pure distance: it includes
// however long the upstream takes to validate and refuse the request. Some
// providers' rejection paths are queue-bound rather than distance-bound
// (Together measured 986ms with a 2089ms spread; Modal floored at 398ms against
// a second-lowest of 888ms). raw carries secondLowestBMs and bSpreadMs so that
// case is visible instead of being mistaken for distance.
//
// v1 of this probe used the router's /api/v1/generation ledger instead. Live
// measurement killed that premise three ways: the ledger is written
// ASYNCHRONOUSLY and 404s for the first 7-15 seconds, its `latency` field is
// wildly noisy (three identical calls: 735ms / 6261ms / 27272ms), and prefill
// sits so far below that noise floor that 900 extra prompt tokens measured as
// NEGATIVE time.

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

// The floor of K interleaved pairs. K=5 keeps the whole probe to at most 13
// calls, so it cannot trip a rate limit and break the probes that run after it
// in the same lane. Earlier revisions used K=10 because the delta was bucketed
// into the value and needed millisecond-scale precision; now that the timing
// lives only in raw, a coarser floor is enough, and raw carries the
// second-lowest sample and the spread so a reader can judge its quality.
const PAIRS = 5;

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
    // Which providers actually answered the MEASUREMENT calls, not just the
    // cascade probe. On an unpinned lane the router can spread calls across
    // hosts, which would let the label name one provider while the timings came
    // from another. Distinct names here mean the lane is not a single target.
    const bProviders = [...new Set(bRaw.map((s) => s.providerName).filter(Boolean))];
    const rawBase = { grid, poison: poisonName, provider,
                      measuredProviders: bProviders, aSamples: aRaw,
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
    // Same rule the tokenizer probes use: a router spreading calls across hosts
    // is reported as unstable rather than as a fingerprint of whichever host
    // happened to answer first.
    if (bProviders.length > 1)
      return { value: "router-spread-unstable", raw: rawBase };

    // Minimum of K on both arms: a floor is what strips queueing and jitter out
    // of a network measurement. Rejected calls cannot queue behind GPU work.
    const floorA = floorOf(aS), floorB = floorOf(bS);
    const deltaMs = floorB - floorA;
    // B traverses a strict superset of A's path, so a non-positive delta is
    // physically impossible and means the measurement is invalid rather than
    // fast. Never publish it as a number, not even in raw.
    const deltaValid = deltaMs > 0;
    // Second-lowest B sample: if it sits far above the floor, the floor was a
    // lucky draw and this provider's rejection path is queue-bound rather than
    // distance-bound. Lets a reader judge the timing instead of trusting it.
    const sortedB = bS.slice().sort((x, y) => x - y);
    const secondB = sortedB.length > 1 ? sortedB[1] : null;

    // VALUE carries only what is stable and comparable: which provider answered
    // and which payload it refused. The timing does NOT go in, because a band
    // can flip between runs on the same model and the table would then show a
    // false difference. The edge colo does not go in either: it describes the
    // VISITOR, not the model, and value strings end up in public share links.
    // Both live in raw, where the JSON export keeps them for analysis.
    const parts = [provider, poisonName].filter(Boolean);
    return {
      value: parts.join(" · "),
      raw: { ...rawBase, floorAMs: +floorA.toFixed(1), floorBMs: +floorB.toFixed(1),
             deltaMs: deltaValid ? +deltaMs.toFixed(1) : null,
             deltaNote: deltaValid ? null : "non-positive-delta-unstable",
             secondLowestBMs: secondB === null ? null : +secondB.toFixed(1),
             bSpreadMs: sortedB.length > 1
               ? +(sortedB[sortedB.length - 1] - sortedB[0]).toFixed(1) : null,
             aUsable: aS.length, bUsable: bS.length },
    };
  } catch (e) {
    return { value: "probe-failed: " + ((e && e.message) || "error") };
  }
}
