// name:        your probe name (short, lowercase)
// description: one sentence: what it measures and why it identifies a lab
// author:      your-github-or-x-handle
// version:     1.0.0
//
// CONTRACT
// Every probe is one file in probes/, exporting exactly two things:
//
//   meta   — the object below. `id` must equal the filename without .js.
//            `group` places the row in the table: tokenizer | errors | shape.
//            `long: true` renders the value as wrapped text (error prose).
//
//   probe  — async function(ctx) -> { value, raw? }
//            `value` is the fingerprint: a string or number. Two endpoints
//            running the same stack must produce the SAME value, so never
//            include timestamps, latency, or random ids in it.
//            `raw` (optional) is kept for the JSON export, never compared.
//
//   ctx.chat(payload) sends ONE chat request to the lane's endpoint and
//   resolves to a normalized result:
//       { ok, status, usage: {prompt_tokens, completion_tokens},
//         finish, text, error }   // error = verbatim provider body (string)
//   The harness owns keys, endpoints and provider quirks; probes stay pure.
//   ctx.model is the model id, for probes that need it in the payload.
//
// A probe must never throw: return { value: "probe-failed: <reason>" } so
// one broken probe cannot kill a whole run.

export const meta = {
  id: "_template",
  name: "template",
  group: "shape",
  why: "copy this file to write a new probe",
  long: false,
  author: "unclecode",
  version: "1.0.0",
};

export async function probe(ctx) {
  const res = await ctx.chat({
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8,
  });
  if (!res.ok) return { value: "probe-failed: " + res.status };
  return { value: res.usage.prompt_tokens };
}
