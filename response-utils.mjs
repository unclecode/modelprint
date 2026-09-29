// Shared response validation for browser and Node harnesses.

export function parseJsonResponse(text, contentType) {
  if (contentType && !/\bjson\b/i.test(contentType))
    return { ok: false, error: `non-json response (${contentType || "unknown content type"})` };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, error: "invalid JSON response" };
  }
}

export function addProviderHeaders(headers, lane, provider, makeSessionId = () => crypto.randomUUID()) {
  if (provider.sessionHeader)
    headers["x-opencode-session"] = lane.sessionId || (lane.sessionId = makeSessionId());
  return headers;
}
