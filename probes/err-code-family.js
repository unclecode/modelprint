// name:        error code family
// description: the SHAPE of error responses: numeric code families vs string codes vs typed objects
// author:      unclecode
// version:     1.0.0

export const meta = {
  id: "err-code-family", name: "error code family", group: "errors",
  why: "numeric codes are vendor DNA (GLM's 1301 gave Ox away)",
  long: false, author: "unclecode", version: "1.0.0",
};

export async function probe(ctx) {
  // temperature 2.0 passes gateways and reaches the lab. Only the UPSTREAM
  // error body (metadata.raw behind a router, or the whole body direct) is
  // analysed; a router's own envelope is numeric-code for everything and
  // would fake matches between unrelated stacks.
  const res = await ctx.chat({
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8, temperature: 2.0,
  });
  if (res.ok) return { value: "no upstream error (accepts 2.0)" };
  let body = String(res.error);
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error?.metadata?.raw) body = String(parsed.error.metadata.raw);
    else if (parsed?.error?.metadata === undefined && parsed?.error) body = JSON.stringify(parsed.error);
    else return { value: "router-validated (no upstream signal)", raw: res.error };
  } catch { /* raw text stays */ }
  let shape = "opaque-text";
  try {
    const err = JSON.parse(body);
    const e = err.error ?? err;
    const parts = [];
    if (typeof e.code === "number" || /^\d+$/.test(String(e.code ?? ""))) parts.push("numeric-code");
    else if (e.code) parts.push("string-code");
    if (e.type) parts.push("type:" + e.type);
    if (e.param !== undefined) parts.push("param-field");
    shape = parts.join(" · ") || "message-only";
  } catch {
    if (/^[A-Z ]{3,20}$/.test(body.trim())) shape = "opaque (host hides errors)";
  }
  return { value: shape, raw: res.error };
}
