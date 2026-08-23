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
  await bumpSummary(kv, key, v);
  return v;
}

/* THE SUMMARY.
 *
 * /stats used to LIST the store three times per call to rebuild the day's
 * picture. The dashboard called it every 60 seconds, which spent about 3,600
 * list operations a day against a free limit of 1,000, and the endpoint then
 * failed with 500 for the rest of the day.
 *
 * Now every counter write also folds itself into one small summary object,
 * and /stats reads that single object. Zero lists, one read. */
const SUMMARY_KEY = () => `summary:${day()}`;

async function readSummary(kv) {
  return (await kv.get(SUMMARY_KEY(), "json")) || { events: {}, models: {}, spend: 0, spendByModel: {} };
}

async function bumpSummary(kv, key, value) {
  const d = day();
  const prefix = `t:${d}:`;
  if (!key.startsWith(prefix)) return;
  const name = key.slice(prefix.length);
  const sum = await readSummary(kv);
  if (name.startsWith("model:")) sum.models[name.slice(6)] = value;
  else sum.events[name] = value;
  await kv.put(SUMMARY_KEY(), JSON.stringify(sum), { expirationTtl: 60 * 60 * 24 * 90 });
}

async function bumpSummarySpend(kv, model, usd) {
  const sum = await readSummary(kv);
  sum.spend = +((sum.spend || 0) + usd).toFixed(8);
  sum.spendByModel[model] = +((sum.spendByModel[model] || 0) + usd).toFixed(8);
  await kv.put(SUMMARY_KEY(), JSON.stringify(sum), { expirationTtl: 60 * 60 * 24 * 90 });
}

/* ---- telemetry ---- */

async function handleEvent(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const event = String(body.event || "");
  if (event === "beat") {
    // Presence used to be one key per visitor plus a LIST to count them.
    // It is now a single roster object of {visitorId: lastSeenMs}, pruned on
    // write, so counting who is here costs one read instead of a listing.
    const visitor = await visitorId(request);
    const now = Date.now();
    let roster = {};
    try { roster = (await env.KV.get("presence", "json")) || {}; } catch {}
    roster[visitor] = now;
    for (const [k, t] of Object.entries(roster)) if (now - t > 120_000) delete roster[k];
    await env.KV.put("presence", JSON.stringify(roster), { expirationTtl: 600 });
    return json({ ok: true });
  }
  if (!EVENTS.has(event)) return json({ error: "unknown event" }, 400);

  const d = day();
  await count(env.KV, `t:${d}:${event}`);
  if (event === "run" || event === "visit")
    await count(env.KV, `total:${event}`, 3650);   // all-time, ~10y ttl

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
  // Reads only. No list operations, so the daily free limit cannot be hit.
  const [sum, rosterRaw, totalRunsRaw, totalVisitsRaw] = await Promise.all([
    readSummary(env.KV),
    env.KV.get("presence", "json"),
    env.KV.get("total:run"),
    env.KV.get("total:visit"),
  ]);
  const out = { ...sum.events };
  for (const [m, v] of Object.entries(sum.models || {})) out["model:" + m] = v;
  const now = Date.now();
  const online = Object.values(rosterRaw || {}).filter(t => now - t <= 120_000).length;
  const byModel = {};
  for (const [m, v] of Object.entries(sum.spendByModel || {})) byModel[m] = +v.toFixed(6);
  return json({ day: d, stats: out, online_now: online,
    total_runs: parseInt(totalRunsRaw || "0", 10),
    total_visits: parseInt(totalVisitsRaw || "0", 10),
    spend_today_usd: +(sum.spend || 0).toFixed(6), spend_by_model: byModel });
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

/* ---- the credited-key proxy: price catalog ----
 *
 * Free tier is a RULE, not a list: input price under $1 per million tokens.
 * The catalog (model -> prompt price) is fetched from OpenRouter and cached
 * in KV for an hour, so the rule keeps deciding by itself as models and
 * prices change. */

const FREE_TIER_MAX_PROMPT_PRICE = 1.5 / 1_000_000; // $1.50 per million tokens
const CATALOG_TTL = 60 * 60;                        // seconds
const VISITOR_DAILY_USD = 0.05;    // ~6 glm-5.3 runs or ~50 flash-tier runs    // ~30 flash-tier runs
const GLOBAL_DAILY_USD = 3.00;     // the whole world's ceiling per day
const MAX_TOKENS_CLAMP = 2048;     // the only real cost lever in a probe call

async function spend(kv, key) {
  const mem = BUD_MEM.get(key);
  if (mem && Date.now() - mem.t < 10_000) return mem.v;
  const v = parseFloat((await kv.get(key)) || "0");
  BUD_MEM.set(key, { t: Date.now(), v });
  return v;
}
async function addSpend(kv, key, usd, ttlDays = 90) {
  const stored = parseFloat((await kv.get(key)) || "0") + usd;
  await kv.put(key, stored.toFixed(8), { expirationTtl: 60 * 60 * 24 * ttlDays });
  BUD_MEM.set(key, { t: Date.now(), v: stored });
  return stored;
}

/* Memory caches, per worker instance: the catalog barely changes and the
   budget counters tolerate ten seconds of lag. This removes the storage
   round trip from the hot path; the key-level $100 wall backs any lag. */
let CAT_MEM = { t: 0, v: null };
const BUD_MEM = new Map();

async function getCatalog(env) {
  if (CAT_MEM.v && Date.now() - CAT_MEM.t < 10 * 60 * 1000) return CAT_MEM.v;
  const cached = await env.KV.get("catalog:prices", "json");
  if (cached) { CAT_MEM = { t: Date.now(), v: cached }; return cached; }
  const r = await fetch("https://openrouter.ai/api/v1/models");
  if (!r.ok) return null;
  const data = (await r.json()).data || [];
  const prices = {};
  for (const m of data) {
    const p = parseFloat(m.pricing?.prompt);
    if (Number.isFinite(p)) prices[m.id] = p;
  }
  await env.KV.put("catalog:prices", JSON.stringify(prices),
    { expirationTtl: CATALOG_TTL });
  CAT_MEM = { t: Date.now(), v: prices };
  return prices;
}

function freeTierAllows(prices, model) {
  const p = prices?.[model];
  return Number.isFinite(p) && p >= 0 && p < FREE_TIER_MAX_PROMPT_PRICE;
}

/* ---- the credited-key proxy: budgets in dollars ----
 *
 * Enabled purely by the SECRET's existence: no key configured means the
 * free mode honestly reports disabled. Costs are the REAL numbers OpenRouter
 * returns per call (usage.include), accumulated per visitor, per day, and
 * per model. The final wall is the spending limit set ON the key at
 * OpenRouter, which this code cannot exceed even when wrong. */

async function handleProxyStatus(request, env) {
  if (!env.OPENROUTER_KEY) return json({ enabled: false,
    note: "free credits not live yet; bring your own key" });
  const d = day();
  const visitor = await visitorId(request);
  const used = await spend(env.KV, `v$:${visitor}:${d}`);
  const globalUsed = await spend(env.KV, `g$:${d}`);
  return json({
    enabled: true,
    rule: "models with input price under $1.50 per million tokens run free",
    visitor_used_usd: +used.toFixed(6),
    visitor_limit_usd: VISITOR_DAILY_USD,
    visitor_exhausted: used >= VISITOR_DAILY_USD,
    global_exhausted: globalUsed >= GLOBAL_DAILY_USD,
  });
}

async function handleProxyChat(request, env, ctx) {
  if (!env.OPENROUTER_KEY) return json({ enabled: false,
    note: "free credits not live yet; bring your own key" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }

  const model = String(body.model || "");
  const d = day();
  // one parallel round for everything the gate needs
  const visitor = await visitorId(request);
  const [prices, globalUsed, visitorUsed] = await Promise.all([
    getCatalog(env),
    spend(env.KV, `g$:${d}`),
    spend(env.KV, `v$:${visitor}:${d}`),
  ]);
  if (!prices) return json({ error: "price catalog unavailable, try again shortly" }, 503);
  if (!freeTierAllows(prices, model))
    return json({ error: "needs-own-key",
      note: "this model is above the free tier; bring your own key" }, 403);
  if (globalUsed >= GLOBAL_DAILY_USD)
    return json({ error: "global-exhausted",
      note: "free credits are done for today, come back tomorrow or use your own key" }, 429);
  if (visitorUsed >= VISITOR_DAILY_USD)
    return json({ error: "visitor-exhausted",
      note: "your free credits are done for today, a free key removes all limits" }, 429);

  const payload = {
    model,
    messages: body.messages,
    max_tokens: Math.min(Math.abs(body.max_tokens ?? 256) || 256, MAX_TOKENS_CLAMP),
    usage: { include: true },
  };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.provider !== undefined) payload.provider = body.provider;
  // the giant-max_tokens probe must reach the provider: the refusal text IS
  // the fingerprint, and an impossible number can only error, never bill
  if ((body.max_tokens ?? 0) >= 10_000_000) payload.max_tokens = body.max_tokens;

  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.OPENROUTER_KEY}`,
      "HTTP-Referer": "https://unclecode.github.io/modelprint/",
      "X-Title": "modelprint free credits",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await upstream.text();

  let cost = 0;
  try { cost = parseFloat(JSON.parse(text)?.usage?.cost) || 0; } catch {}
  if (cost > 0) {
    // bookkeeping rides BEHIND the response; the caller never waits for it
    ctx.waitUntil(Promise.all([
      addSpend(env.KV, `v$:${visitor}:${d}`, cost, 2),
      addSpend(env.KV, `g$:${d}`, cost),
      addSpend(env.KV, `m$:${d}:${model.slice(0, 60)}`, cost),
      bumpSummarySpend(env.KV, model.slice(0, 60), cost),
    ]));
  }
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json", ...CORS,
      "x-modelprint-usd-used": (visitorUsed + cost).toFixed(6),
      "x-modelprint-usd-limit": String(VISITOR_DAILY_USD) },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/t" && request.method === "POST") return handleEvent(request, env);
    if (path === "/stats") return handleStats(request, env);
    if (path === "/s" && request.method === "POST") return handleShareCreate(request, env);
    const shareMatch = path.match(/^\/s\/([a-z2-9]{6})$/);
    if (shareMatch) return handleShareGet(shareMatch[1], env);
    if (path === "/proxy/status") return handleProxyStatus(request, env);
    if (path === "/proxy/chat" && request.method === "POST")
      return handleProxyChat(request, env, ctx);
    if (path === "/proxy/freecheck") {
      // step-1 verification endpoint: is this model inside the free tier?
      const model = url.searchParams.get("model") || "";
      const prices = await getCatalog(env);
      if (!prices) return json({ error: "catalog unavailable" }, 503);
      return json({ model, prompt_price_usd: prices[model] ?? null,
        free_tier: freeTierAllows(prices, model) });
    }
    return json({ ok: true, service: "modelprint-api", version: "1.0.0" });
  },
};
