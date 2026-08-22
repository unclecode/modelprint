// name:        generation record
// description: OpenRouter's /generation endpoint names the serving provider,
//              its data region and the NATIVE token counts for one call
// author:      ItIsCuthNotCup
// version:     1.2.0

export const meta = {
  id: "net-genrecord", name: "generation record", group: "network",
  why: "the router's own ledger: provider_name + data_region + native tokens",
  long: false, author: "ItIsCuthNotCup", version: "1.2.0",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Total wall-clock budget for the ledger lookup. It bounds when requests are
// ISSUED: the elapsed time is re-checked before every sleep and after every
// response, so no new request starts past the budget. A single already-in-flight
// request cannot be aborted from here (ctx.http owns its own timeout — 30s in
// engine.js), so the true worst case is this budget plus one such request rather
// than a hard cap. That still turns an unbounded 7-request crawl into a bounded
// one: a 9s-per-request endpoint went from ~63s of requests plus sleeps down to
// 3 requests and 32s.
const LEDGER_BUDGET_MS = 25_000;

// Only OpenRouter mints "gen-…" ids and only OpenRouter has a /generation
// ledger. A direct OpenAI lane answers "chatcmpl-…", Anthropic "msg_…", and a
// custom endpoint anything at all — none of them have this endpoint, so polling
// them is 7 wasted requests and a 25s wait to learn nothing. Verified live that
// EVERY model served through OpenRouter carries the gen- prefix, including
// openai/* and anthropic/* lanes, so this skips only genuinely ledger-less
// endpoints.
const OPENROUTER_ID = /^gen-/;

// The chat response id (gen-…) is the key to a richer record the router
// keeps for every call. It reports which provider answered, whether traffic
// stayed global or went through Europe, the native prompt/completion/
// REASONING token counts, and moderation latency. For routed lanes this is
// the single strongest "who served me" probe; it also exposes reasoning
// overhead on lanes whose usage object hides it.
export async function probe(ctx) {
  if (typeof ctx.http !== "function")
    return { value: "harness-lacks-http" };
  const res = await ctx.chat({
    messages: [{ role: "user", content: "Say only: ok" }], max_tokens: 8,
  });
  if (!res.ok) return { value: "probe-failed: " + res.status };
  const gid = res.headers?.["x-generation-id"] || res.id;
  if (!gid) return { value: "no-generation-id", raw: { headers: res.headers } };
  // Bail before spending anything on a lane that cannot have a ledger. Costs one
  // request and no wait, exactly as the probe did before polling was added.
  if (!OPENROUTER_ID.test(String(gid)))
    return { value: "no-generation-ledger",
             raw: { idPrefix: String(gid).split(/[-_]/)[0] || null } };
  // TWO bugs kept this probe from ever returning a record.
  //
  // 1. PATH. ctx.http resolves a relative path against the LANE's base, which
  //    for OpenRouter is already "https://openrouter.ai/api/v1". Asking for
  //    "/api/v1/generation" therefore fetched ".../api/v1/api/v1/generation"
  //    and 404'd every time, in the browser and in both Node harnesses alike.
  //    The correct relative path is "/generation".
  //
  // 2. TIMING. The ledger is written ASYNCHRONOUSLY and 404s for several
  //    seconds after the call returns, so even a correctly-addressed immediate
  //    lookup misses. Measured on live OpenRouter, the record appeared at
  //    +7.0s, +9.3s, +10.4s, +13.9s and +15.0s for stealth/ox-alpha,
  //    z-ai/glm-4.7-flash and deepseek/deepseek-v4-flash. A ~25s budget covers
  //    the observed spread with headroom; the ledger IS this probe's entire
  //    payload, so waiting for it is the point rather than an overhead.
  //
  // Poll with backoff, and distinguish "not written YET" from "does not exist".
  const waits = [0, 2000, 3000, 4000, 5000, 5000, 6000];
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  let rec = null, d = null, waited = 0, timedOut = false;
  for (const w of waits) {
    // Never start a sleep that would run past the budget.
    if (w) {
      if (elapsed() + w > LEDGER_BUDGET_MS) { timedOut = true; break; }
      waited += w; await sleep(w);
    }
    rec = await ctx.http(`/generation?id=${encodeURIComponent(gid)}`);
    d = rec.json?.data;
    if (d) break;
    // Only a 404 means "not yet"; anything else is terminal and must not be
    // retried behind the user's back.
    if (rec.status !== 404) break;
    // A slow endpoint burns budget inside ctx.http rather than in sleep, so
    // re-check here too: this stops the NEXT request from being issued.
    if (elapsed() >= LEDGER_BUDGET_MS) { timedOut = true; break; }
  }
  if (!rec || !rec.ok || !d)
    // Value stays "record-not-found" so snapshots shared before this fix still
    // compare; whether the budget ran out is recorded in raw instead.
    return { value: rec && rec.status !== 404 ? "harness-lacks-auth"
             : "record-not-found",
             raw: { status: rec ? rec.status : null, waitedMs: waited,
                    timedOut, budgetMs: LEDGER_BUDGET_MS } };
  // Deterministic fields only in the value; latency/cost stay in raw.
  return {
    value: [d.provider_name, d.data_region || "global",
            d.native_finish_reason || d.finish_reason || ""]
      .filter(Boolean).join(" · "),
    raw: { native_tokens_prompt: d.native_tokens_prompt,
           native_tokens_completion: d.native_tokens_completion,
           native_tokens_reasoning: d.native_tokens_reasoning,
           latency: d.latency, generation_time: d.generation_time,
           moderation_latency: d.moderation_latency, cost: d.token_cost ?? d.cost,
           ledgerWaitedMs: waited },
  };
}
