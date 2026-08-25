// name:        code snippet
// description: prompt_tokens for fixed source code; indentation and symbol handling vary
// author:      unclecode
// version:     1.0.0

import { describeFailure, usageMissing, USAGE_NOT_REPORTED } from "./_failure.js";

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
  if (!a.ok || !b.ok || !base.ok) {
    // Name the call that ACTUALLY failed. Picking the first truthy status
    // printed "probe-failed: 200" when call one succeeded and a later one
    // timed out, which hides the real cause.
    const bad = [a, b, base].find(r => !r.ok);
    return { value: describeFailure(bad), raw: { status: bad.status, error: bad.error } };
  }
  if (usageMissing(a, b, base))
    return { value: USAGE_NOT_REPORTED,
             raw: { note: "this host answers 200 but does not report token counts" } };
  if (a.usage.prompt_tokens !== b.usage.prompt_tokens)
    return { value: "unstable (multi-host routing)",
             raw: { first: a.usage.prompt_tokens, second: b.usage.prompt_tokens } };
  const norm = a.usage.prompt_tokens - base.usage.prompt_tokens;
  return { value: norm, raw: { raw_count: a.usage.prompt_tokens, baseline: base.usage.prompt_tokens } };
}
