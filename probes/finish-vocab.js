// name:        finish vocabulary
// description: which finish_reason value a forced cut-off produces; vocabularies differ per lab
// author:      unclecode
// version:     1.0.0

export const meta = {
  id: "finish-vocab", name: "finish vocabulary", group: "shape",
  why: "finish_reason values the endpoint emits",
  long: false, author: "unclecode", version: "1.0.0",
};

export async function probe(ctx) {
  // A normal stop and a forced length-cut, so two vocabulary entries show.
  // 400 tokens of room, so reasoning models can finish and emit a true "stop".
  const stop = await ctx.chat({ messages: [{ role: "user", content: "Say only: ok" }], max_tokens: 400 });
  const cut  = await ctx.chat({ messages: [{ role: "user", content: "Count from 1 to 200." }], max_tokens: 6 });
  if (!stop.ok && !cut.ok) return { value: "probe-failed: " + stop.status };
  return { value: [stop.finish, cut.finish].filter(Boolean).join(" · ") };
}
