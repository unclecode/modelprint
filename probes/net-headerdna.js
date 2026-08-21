// name:        header dna
// description: which response headers exist and in what format — serving
//              stacks expose different header families, and CORS hides the rest
// author:      your-handle
// version:     1.0.0

export const meta = {
  id: "net-headerdna", name: "header dna", group: "network",
  why: "header presence/format is stack DNA (Bedrock, Vertex, Cloudflare…)",
  long: false, author: "unclecode", version: "1.0.0",
};

// Values like request ids are per-call; PRESENCE and FORMAT are stable.
// Known families: cf-ray (Cloudflare), x-amzn-requestid (AWS Bedrock),
// x-envoy-upstream-service-time (Google frontends), openai-processing-ms +
// openai-version (OpenAI), server: gunicorn/uvicorn/cloudflare (serving tier),
// x-ratelimit-* (quota shape), id prefix gen-/chatcmpl-/msg_ (gateway),
// system_fingerprint field (weight snapshot). A browser can only read headers
// the provider CORS-exposes; an EMPTY set means hidden-by-CORS, not absent —
// reported honestly instead of pretending it is a fingerprint.
export async function probe(ctx) {
  const res = await ctx.chat({
    messages: [{ role: "user", content: "hi" }], max_tokens: 1,
  });
  const h = res.headers || {};
  if (!res.ok && res.status === 0) return { value: "probe-failed: network" };
  if (!Object.keys(h).length)
    return { value: "headers-hidden-by-cors", raw: { note: "no headers visible to JS" } };
  const parts = [];
  if (h["cf-ray"]) parts.push("cf-ray");
  if (h["x-amzn-requestid"] || h["x-amz-request-id"]) parts.push("aws");
  if (h["x-envoy-upstream-service-time"]) parts.push("envoy");
  if (h["openai-processing-ms"]) parts.push("oai-proc-ms");
  if (h["openai-version"]) parts.push("oai-ver:" + h["openai-version"]);
  if (h["anthropic-ratelimit-requests-limit"]) parts.push("ant-rl");
  if (Object.keys(h).some(k => k.startsWith("x-ratelimit"))) parts.push("rl-*");
  if (h.server) parts.push("server:" + String(h.server).slice(0, 24));
  if (h["x-request-id"])
    parts.push("xreq:" + String(h["x-request-id"]).replace(/[0-9a-f]{4,}/gi, "…").slice(0, 18));
  const idPrefix = typeof res.id === "string" ? res.id.replace(/[^A-Za-z_-].*$/, "") : "";
  if (idPrefix) parts.push("id:" + idPrefix);
  if (res.systemFingerprint) parts.push("fp");
  return { value: parts.join(" · ") || "none-visible",
           raw: { headers: h, id: res.id } };
}
