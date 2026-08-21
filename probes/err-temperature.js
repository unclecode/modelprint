// name:        temperature at the edge
// description: send temperature 2.0; gateways accept it and forward, labs with a lower
//              ceiling answer with their OWN validation prose (the AllThingsIntel trick)
// author:      unclecode
// version:     1.0.0

export const meta = {
  id: "err-temperature", name: "temperature: 2.0", group: "errors",
  why: "edge value passes gateways; a lab with a lower ceiling answers in its own words",
  long: true, author: "unclecode", version: "1.0.0",
};

// Routers wrap the lab's error inside their own envelope. The lab's prose is
// what fingerprints, so unwrap metadata.raw when present, then scrub volatile
// fields (ids, user ids, UUIDs) so identical wording compares equal.
export function scrub(input) {
  let text = String(input);
  try {
    const parsed = JSON.parse(text);
    const raw = parsed?.error?.metadata?.raw;
    if (raw) text = String(raw);
    else if (parsed?.error?.message) text = String(parsed.error.message)
      + (parsed.error.code !== undefined ? " · code " + parsed.error.code : "");
  } catch { /* keep as text */ }
  return text
    .replace(/"user_id"\s*:\s*"[^"]*"/g, "")
    .replace(/user_[A-Za-z0-9]{10,}/g, "…")
    .replace(/"(?:id|request_id|requestId)"\s*:\s*"[^"]*"/g, '"id":"…"')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "…")
    .replace(/\b\d{13,}\b/g, "…")
    .slice(0, 300);
}

export async function probe(ctx) {
  const res = await ctx.chat({
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8, temperature: 2.0,
  });
  if (res.ok) return { value: "accepts 2.0 (ceiling >= 2)" };
  return { value: scrub(res.error), raw: res.error };
}
