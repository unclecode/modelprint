// name:        reasoning trace
// description: how the endpoint handles a reasoning parameter — its invalid-
//              value prose and its thinking-token overhead on a fixed task
// author:      your-handle
// version:     1.0.0

export const meta = {
  id: "reason-trace", name: "reasoning trace", group: "reasoning",
  why: "reasoning params and overhead differ per lab (effort vs thinking budget)",
  long: false, author: "unclecode", version: "1.0.0",
};

function scrub(text) {
  return String(text)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "…")
    .replace(/\b\d{13,}\b/g, "…")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

export async function probe(ctx) {
  // A fixed puzzle with generous room: the THINKING BUDGET spent on it is a
  // stable per-model number wherever usage exposes reasoning tokens.
  const task = await ctx.chat({
    messages: [{ role: "user", content:
      "A bat and a ball cost $1.10 total. The bat costs $1.00 more than the ball. " +
      "How much is the ball? End your reply with the exact line: ANSWER: $X.XX" }],
    max_tokens: 900,
  });
  if (!task.ok) return { value: "probe-failed: " + task.status };
  const overhead = task.reasoningTokens != null
    ? `+${task.reasoningTokens} tok`
    : `out ${task.usage?.completion_tokens ?? "?"} tok`;

  // An impossible enum value: labs that VALIDATE the field answer with their
  // own prose; gateways that strip unknown fields just answer normally.
  const bad = await ctx.chat({
    messages: [{ role: "user", content: "hi" }], max_tokens: 8,
    reasoning_effort: "banana",
  });
  const param = bad.ok ? "param-ignored"
    : scrub(bad.error).slice(0, 60);
  return { value: `${param} · ${overhead}`,
           raw: { task_error: null, param_error: bad.ok ? null : bad.error,
                  completion_tokens: task.usage?.completion_tokens,
                  reasoningTokens: task.reasoningTokens } };
}
