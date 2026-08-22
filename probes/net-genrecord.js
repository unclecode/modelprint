// name:        generation record
// description: OpenRouter's /generation endpoint names the serving provider,
//              its data region and the NATIVE token counts for one call
// author:      ItIsCuthNotCup
// version:     1.0.0

export const meta = {
  id: "net-genrecord", name: "generation record", group: "network",
  why: "the router's own ledger: provider_name + data_region + native tokens",
  long: false, author: "ItIsCuthNotCup", version: "1.0.0",
};

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
  const rec = await ctx.http(`/api/v1/generation?id=${encodeURIComponent(gid)}`);
  const d = rec.json?.data;
  if (!rec.ok || !d)
    return { value: rec.status === 404 ? "record-not-found"
             : "harness-lacks-auth", raw: { status: rec.status } };
  // Deterministic fields only in the value; latency/cost stay in raw.
  return {
    value: [d.provider_name, d.data_region || "global",
            d.native_finish_reason || d.finish_reason || ""]
      .filter(Boolean).join(" · "),
    raw: { native_tokens_prompt: d.native_tokens_prompt,
           native_tokens_completion: d.native_tokens_completion,
           native_tokens_reasoning: d.native_tokens_reasoning,
           latency: d.latency, generation_time: d.generation_time,
           moderation_latency: d.moderation_latency, cost: d.token_cost ?? d.cost },
  };
}
