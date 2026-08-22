/* modelprint-api v1: telemetry + short links.
 *
 * The credited-key proxy exists in the design but is PARKED: /proxy/status
 * answers {enabled:false} and /proxy/chat answers 403 until the consumption
 * controls are agreed. Nothing runs on the house key in v1.
 *
 * Telemetry counts EVENTS in daily KV counters. No cookies, no profiles;
 * the visitor id is a truncated hash of the IP and expires with the day.
 * Events: visit, run, share_created, share_opened, lane_added, plus a
 * per-model counter so "what is being fingerprinted today" is answerable.
 *
 * Short links: POST /s stores the page's compressed share-state under a
 * 6-char id (30 days); GET /s/<id> returns it. The page keeps the long
 * hash-link as fallback, so sharing works even if this worker is down.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const EVENTS = new Set(["visit", "run", "share_created", "share_opened", "lane_added"]);
const STATE_MAX_BYTES = 40_000;       // a share state is ~600 bytes; 40k is generous
const LINK_TTL = 60 * 60 * 24 * 30;   // short links live 30 days
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/O/1/l/i

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...CORS },
  });
}

const day = () => new Date().toISOString().slice(0, 10);

async function visitorId(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode("modelprint:" + ip));
  return [...new Uint8Array(digest)].slice(0, 8)
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

async function count(kv, key, ttlDays = 90) {
  const v = parseInt((await kv.get(key)) || "0", 10) + 1;
  await kv.put(key, String(v), { expirationTtl: 60 * 60 * 24 * ttlDays });
  return v;
}

/* ---- telemetry ---- */

async function handleEvent(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const event = String(body.event || "");
  if (!EVENTS.has(event)) return json({ error: "unknown event" }, 400);

  const d = day();
  await count(env.KV, `t:${d}:${event}`);

  if (event === "visit") {
    // uniques: first visit of this visitor today bumps the uniques counter
    const visitor = await visitorId(request);
    const seenKey = `seen:${d}:${visitor}`;
    if (!(await env.KV.get(seenKey))) {
      await env.KV.put(seenKey, "1", { expirationTtl: 60 * 60 * 48 });
      await count(env.KV, `t:${d}:visit_unique`);
    }
  }
  if (event === "run") {
    if (body.provider) await count(env.KV, `t:${d}:run_provider:${String(body.provider).slice(0, 24)}`);
    if (body.keyless !== undefined) await count(env.KV, `t:${d}:run_${body.keyless ? "keyless" : "keyed"}`);
    for (const m of (Array.isArray(body.models) ? body.models.slice(0, 12) : []))
      await count(env.KV, `t:${d}:model:${String(m).slice(0, 60)}`);
  }
  return json({ ok: true });
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  const d = url.searchParams.get("day") || day();
  const list = await env.KV.list({ prefix: `t:${d}:`, limit: 1000 });
  const out = {};
  for (const k of list.keys) {
    out[k.name.slice(`t:${d}:`.length)] = parseInt((await env.KV.get(k.name)) || "0", 10);
  }
  return json({ day: d, stats: out });
}

/* ---- short links ---- */

/* Ids are derived from the CONTENT's hash, so the same state always maps to
   the same id: re-sharing an unchanged result returns the existing link
   instead of minting a new one. Different content colliding on a 6-char
   window is countered by sliding along the hash. */
async function handleShareCreate(request, env) {
  const text = await request.text();
  if (!text || text.length > STATE_MAX_BYTES) return json({ error: "state too large" }, 413);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(text)));
  for (let win = 0; win + 6 <= 24; win += 6) {
    const id = [...digest.slice(win, win + 6)]
      .map(b => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
    const existing = await env.KV.get(`s:${id}`);
    if (existing === text) return json({ id, existing: true });   // same state: same link
    if (existing !== null) continue;                              // true collision: slide
    await env.KV.put(`s:${id}`, text, { expirationTtl: LINK_TTL });
    await count(env.KV, `t:${day()}:share_created`);
    return json({ id });
  }
  return json({ error: "could not allocate id" }, 500);
}

async function handleShareGet(id, env) {
  const state = await env.KV.get(`s:${id}`);
  if (!state) return json({ error: "not found or expired" }, 404);
  await count(env.KV, `t:${day()}:share_opened`);
  return new Response(state, {
    headers: { "content-type": "text/plain", ...CORS },
  });
}

/* ---- parked: the credited-key proxy ---- */

const PROXY_PARKED = { enabled: false,
  note: "free credits not live yet; bring your own key" };

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/t" && request.method === "POST") return handleEvent(request, env);
    if (path === "/stats") return handleStats(request, env);
    if (path === "/s" && request.method === "POST") return handleShareCreate(request, env);
    const shareMatch = path.match(/^\/s\/([a-z2-9]{6})$/);
    if (shareMatch) return handleShareGet(shareMatch[1], env);
    if (path === "/proxy/status") return json(PROXY_PARKED);
    if (path === "/proxy/chat") return json(PROXY_PARKED, 403);
    return json({ ok: true, service: "modelprint-api", version: "1.0.0" });
  },
};
