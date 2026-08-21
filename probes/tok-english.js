// name:        english pangram
// description: prompt_tokens for a fixed English text; tokenizers are unique per lab
// author:      unclecode
// version:     1.0.0

export const meta = {
  id: "tok-english", name: "english pangram", group: "tokenizer",
  why: "prompt_tokens for a fixed 212-char text",
  long: false, author: "unclecode", version: "1.0.0",
};

// Pinned byte-exact. Changing ONE character changes every fingerprint,
// so this string is versioned with the probe and must never be edited.
const TEXT = "The quick brown fox jumps over the lazy dog while packing my box "
  + "with five dozen liquor jugs; sphinx of black quartz, judge my vow. "
  + "Amazingly few discotheques provide jukeboxes, yet vexed zombies quip.";

export async function probe(ctx) {
  // Three cheap calls. TEXT twice: if the counts differ, a router is spreading
  // calls across hosts and no fingerprint exists ("unstable"). Then a one-char
  // baseline: the value reported is TEXT minus baseline, which cancels the
  // host's hidden template. Two hosts wrapping the SAME tokenizer then match,
  // which raw counts never would.
  const a = await ctx.chat({ messages: [{ role: "user", content: TEXT }], max_tokens: 1 });
  const b = await ctx.chat({ messages: [{ role: "user", content: TEXT }], max_tokens: 1 });
  const base = await ctx.chat({ messages: [{ role: "user", content: "a" }], max_tokens: 1 });
  if (!a.ok || !b.ok || !base.ok)
    return { value: "probe-failed: " + (a.status || b.status || base.status) };
  if (a.usage.prompt_tokens !== b.usage.prompt_tokens)
    return { value: "unstable (multi-host routing)",
             raw: { first: a.usage.prompt_tokens, second: b.usage.prompt_tokens } };
  const norm = a.usage.prompt_tokens - base.usage.prompt_tokens;
  return { value: norm, raw: { raw_count: a.usage.prompt_tokens, baseline: base.usage.prompt_tokens } };
}
