// name:        template offset
// description: hidden serving-template tokens, from two prompts of known size difference
// author:      unclecode
// version:     1.0.0

import { describeFailure, usageMissing, USAGE_NOT_REPORTED } from "./_failure.js";

export const meta = {
  id: "template-offset", name: "template offset", group: "tokenizer",
  why: "hidden system-template tokens",
  long: false, author: "unclecode", version: "1.0.0",
};

// Two prompts whose visible content differs by a known amount. The part of
// prompt_tokens that BOTH share beyond the text is the serving template.
// The +75 constant was one of the clues the community used on Ox Alpha.
export async function probe(ctx) {
  // The same tiny prompt twice: if the counts differ, a router is spreading
  // the calls across hosts with different templates, and any offset read here
  // would be noise. Saying "unstable" is the honest fingerprint then.
  const a1 = await ctx.chat({ messages: [{ role: "user", content: "a" }], max_tokens: 1 });
  const a2 = await ctx.chat({ messages: [{ role: "user", content: "a" }], max_tokens: 1 });
  const b  = await ctx.chat({ messages: [{ role: "user", content: "a b c d e f g h" }], max_tokens: 1 });
  if (!a1.ok || !a2.ok || !b.ok) {
    // Name the call that ACTUALLY failed. Picking the first truthy status
    // printed "probe-failed: 200" when call one succeeded and a later one
    // was refused, which hides the real cause.
    const bad = [a1, a2, b].find(r => !r.ok);
    return { value: describeFailure(bad), raw: { status: bad.status, error: bad.error } };
  }
  if (usageMissing(a1, a2, b))
    return { value: USAGE_NOT_REPORTED,
             raw: { note: "this host answers 200 but does not report token counts" } };
  if (a1.usage.prompt_tokens !== a2.usage.prompt_tokens)
    return { value: "unstable (multi-host routing)",
             raw: { first: a1.usage.prompt_tokens, second: a2.usage.prompt_tokens } };
  const perWordCost = b.usage.prompt_tokens - a1.usage.prompt_tokens;
  const overhead = a1.usage.prompt_tokens;   // template + 1 token of content
  return { value: `+${overhead} (delta ${perWordCost})`,
           raw: { one_token_prompt: a1.usage.prompt_tokens, nine_token_prompt: b.usage.prompt_tokens } };
}
