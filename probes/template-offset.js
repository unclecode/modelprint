// name:        template offset
// description: hidden serving-template tokens, from two prompts of known size difference
// author:      unclecode
// version:     1.0.0

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
  if (!a1.ok || !a2.ok || !b.ok) return { value: "probe-failed: " + (a1.status || a2.status || b.status) };
  if (a1.usage.prompt_tokens !== a2.usage.prompt_tokens)
    return { value: "unstable (multi-host routing)",
             raw: { first: a1.usage.prompt_tokens, second: a2.usage.prompt_tokens } };
  const perWordCost = b.usage.prompt_tokens - a1.usage.prompt_tokens;
  const overhead = a1.usage.prompt_tokens;   // template + 1 token of content
  return { value: `+${overhead} (delta ${perWordCost})`,
           raw: { one_token_prompt: a1.usage.prompt_tokens, nine_token_prompt: b.usage.prompt_tokens } };
}
