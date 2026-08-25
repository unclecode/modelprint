// name:        router region
// description: which edge region and which provider actually served each call,
//              from the router's own opt-in metadata snapshot
// author:      ItIsCuthNotCup
// version:     1.0.0

import { describeFailure } from "./_failure.js";

export const meta = {
  id: "net-region", name: "router region", group: "network",
  why: "the routing layer names its region and the provider that answered",
  long: false, author: "ItIsCuthNotCup", version: "1.0.0",
};

// OpenRouter answers with an openrouter_metadata object when the request
// carries X-OpenRouter-Metadata: enabled (the engine sends it on every
// OpenRouter lane). Inside: region ("iad", null…), strategy, and the
// endpoints considered, one flagged selected. That is the router telling you
// WHO served the call — a stealth lane served by "Z.AI" ends one argument.
export async function probe(ctx) {
  const res = await ctx.chat({
    messages: [{ role: "user", content: "hi" }], max_tokens: 1,
  });
  if (!res.ok) return { value: describeFailure(res), raw: { status: res.status } };
  const m = res.metadata;
  if (!m) return { value: res.status === 200 ? "no-router-metadata" : "no-router-metadata",
                   raw: { id: res.id } };
  const sel = (m.endpoints?.available || []).find(e => e.selected);
  const parts = [
    m.region ? m.region : "region-hidden",
    sel?.provider || m.summary?.split("selected=")?.[1] || "provider-unknown",
    m.strategy || "",
    m.attempt > 1 ? `attempt-${m.attempt}` : "",
  ].filter(Boolean);
  // raw keeps latency samples and the full snapshot; latency never enters
  // the value because it changes every run.
  return { value: parts.join(" · "),
           raw: { metadata: m, ttftMs: Math.round(res.ttftMs ?? -1),
                  totalMs: Math.round(res.ms ?? -1) } };
}
