// name:        code snippet
// description: prompt_tokens for fixed source code; indentation and symbol handling vary
// author:      unclecode
// version:     1.0.0

export const meta = {
  id: "tok-code", name: "code snippet", group: "tokenizer",
  why: "indentation + symbol handling",
  long: false, author: "unclecode", version: "1.0.0",
};

const TEXT = 'def fingerprint(endpoint: str, *, probes: list[str]) -> dict:\n'
  + '    """Run every probe against one endpoint."""\n'
  + '    results = {p: run(endpoint, p) for p in probes}\n'
  + '    return {k: v for k, v in sorted(results.items()) if v is not None}\n';

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
