// name:        generation record
// description: OpenRouter's /generation endpoint names the serving provider,
//              its data region and the NATIVE token counts for one call
// author:      ItIsCuthNotCup
// version:     1.1.0

export const meta = {
  id: "net-genrecord", name: "generation record", group: "network",
  why: "the router's own ledger: provider_name + data_region + native tokens",
  long: false, author: "ItIsCuthNotCup", version: "1.1.0",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  let rec = null, d = null, waited = 0;
  for (const w of waits) {
    if (w) { waited += w; await sleep(w); }
    rec = await ctx.http(`/generation?id=${encodeURIComponent(gid)}`);
    d = rec.json?.data;
    if (d) break;
    // Only a 404 means "not yet"; anything else is terminal and must not be
    // retried behind the user's back.
    if (rec.status !== 404) break;
  }
  if (!rec.ok || !d)
    return { value: rec.status === 404 ? "record-pending"
             : "harness-lacks-auth", raw: { status: rec.status, waitedMs: waited } };
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
