// name:        giant max_tokens
// description: ask for a billion output tokens; the refusal names the lab's real limit,
//              and that number is vendor DNA (a gateway forwards this, unlike -1)
// author:      unclecode
// version:     1.0.0

import { scrub } from "./err-temperature.js";

export const meta = {
  id: "err-maxtokens", name: "max_tokens: 10^9", group: "errors",
  why: "the refusal names the lab's real output limit",
  long: true, author: "unclecode", version: "1.0.0",
};

export async function probe(ctx) {
  const res = await ctx.chat({
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1_000_000_000,
  });
  if (res.ok) return { value: "accepted 10^9 (silently capped)" };
  // A router that knows the endpoint's context length answers this itself,
  // in its own words, before the lab ever sees the request. That message is
  // NOT lab DNA. Keep only the number then, clearly labelled, so identical
  // router prose can never fake a family match.
  let upstream = null;
  try { upstream = JSON.parse(res.error)?.error?.metadata?.raw || null; } catch {}
  if (!upstream) {
    const limit = /maximum context length is (\d+)/.exec(String(res.error))?.[1];
    return { value: limit ? `router-reported limit: ${limit} tokens` : "router-validated (no upstream signal)",
             raw: res.error };
  }
  return { value: scrub(upstream), raw: res.error };
}
