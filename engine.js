/* modelprint engine — loads the approved probes, drives lanes, renders the board.
   Design contract with probes/: see probes/_template.js. */

import { REGISTRY } from "./probes/index.js";
import { isBusy } from "./probes/_failure.js";

/* The key-credits backend (worker/). When an OpenRouter lane has NO key, the
   page runs through this proxy on the house budget: model whitelist, daily
   visitor cap, daily global cap, all enforced server-side. Empty string
   disables the free path entirely (the page then requires a key, as before),
   so a backend outage can never break the tool. */
const BACKEND = "https://modelprint-api.unclecode.workers.dev";
let FREE_INFO = null;   // filled from /proxy/status at boot when BACKEND is set
const FREE_ELIGIBLE = new Map();  // model id -> true/false, from /proxy/freecheck

function checkFreeEligible(model) {
  if (!model || FREE_ELIGIBLE.has(model)) return;
  FREE_ELIGIBLE.set(model, undefined);  // in flight
  fetch(BACKEND + "/proxy/freecheck?model=" + encodeURIComponent(model),
    { signal: AbortSignal.timeout(6000) })
    .then(r => r.ok ? r.json() : null)
    .then(d => { FREE_ELIGIBLE.set(model, !!d?.free_tier); render(); })
    .catch(() => FREE_ELIGIBLE.delete(model));
}

/* the out-of-credits banner: shown from status at load and the moment a
   run hits a 429 mid-way */
function showCreditsBanner(kind) {
  if (document.getElementById("creditsbanner")) return;
  const div = document.createElement("div");
  div.id = "creditsbanner";
  div.innerHTML = `<b>${kind === "global" ? "Free credits are done for today."
      : "Your free credits are done for today."}</b>
    Come back tomorrow, or use your own free key: the :free models cost $0.
    <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">get a key</a>
    <button onclick="this.parentElement.remove()">✕</button>`;
  document.body.prepend(div);
}

/* Anonymous usage counters (no cookies, no ids stored in the browser).
   Fire-and-forget: telemetry must never slow or break the tool. */
function ping(event, extra = {}) {
  if (!BACKEND) return;
  try {
    const body = JSON.stringify({ event, ...extra });
    if (navigator.sendBeacon) { navigator.sendBeacon(BACKEND + "/t", body); return; }
    fetch(BACKEND + "/t", { method: "POST",
      headers: { "content-type": "application/json" },
      body, keepalive: true }).catch(() => {});
  } catch { /* never surface */ }
}
// presence heartbeat: alive while the tab is open and visible
setInterval(() => { if (!document.hidden) ping("beat"); }, 45_000);

/* ---------------- providers ---------------- */
const PROVIDERS = {
  demo:      { label: "Demo (no key needed)", keyHint: "", base: null,
               models: ["stealth/ox-alpha","z-ai/glm-5.3","deepseek/deepseek-v4-flash",
                        "anthropic/claude-opus-5","openai/gpt-5.6-luna","qwen/qwen3.7-flash"] },
  openrouter:{ label: "OpenRouter", keyHint: "sk-or-…", base: "https://openrouter.ai/api/v1",
               models: [], modelsPublic: true },
  openai:    { label: "OpenAI", keyHint: "sk-…", base: "https://api.openai.com/v1", models: [] },
  deepseek:  { label: "DeepSeek", keyHint: "sk-…", base: "https://api.deepseek.com", models: [] },
  anthropic: { label: "Anthropic", keyHint: "sk-ant-…", base: "https://api.anthropic.com/v1",
               models: [], anthropic: true },
  mimo:      { label: "Xiaomi MiMo", keyHint: "sk-…", base: "https://api.xiaomimimo.com/v1",
               models: [] },
  custom:    { label: "Custom URL…", keyHint: "key", base: null, models: [] },
};

/* Shown on top of the model list before any search. */
const POPULAR = {
  openrouter: ["stealth/ox-alpha", "z-ai/glm-5.3", "deepseek/deepseek-v4-flash",
    "anthropic/claude-opus-5", "openai/gpt-5.6-luna", "moonshotai/kimi-k3",
    "qwen/qwen3.7-flash", "x-ai/grok-4.6"],
  openai: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.4-nano"],
  mimo: ["mimo-v2.5-pro", "mimo-v2.5"],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  anthropic: ["claude-opus-5", "claude-sonnet-5"],
  demo: ["stealth/ox-alpha", "z-ai/glm-5.3", "deepseek/deepseek-v4-flash"],
};

/* Fetch a provider's live model list. OpenRouter's is public; the rest need
   the lane's key. Failures leave a free-text input, never a broken lane. */
async function fetchModels(provider, key) {
  const p = PROVIDERS[provider];
  if (!p.base) return [];
  try {
    if (provider === "openrouter") {
      const r = await fetch(p.base + "/models");
      const d = await r.json();
      return d.data.map(m => m.id).sort();
    }
    if (!key) return [];
    const headers = p.anthropic
      ? { "x-api-key": key, "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" }
      : { Authorization: "Bearer " + key };
    const r = await fetch(p.base + "/models", { headers });
    const d = await r.json();
    return (d.data || []).map(m => m.id).sort();
  } catch { return []; }
}

/* ---------------- the chat adapter: one normalized call ----------------
   Every result carries the fields probes have always used (ok, status,
   usage, finish, text, error) PLUS optional telemetry the newer probes
   read when present and skip when absent:
   id, reportedModel, systemFingerprint, reasoningTokens, logprobs,
   metadata (router routing snapshot), headers, ms / ttftMs, stream.
   The Node suites (smoke.mjs) build thinner results; every probe that
   touches telemetry must degrade to an honest value without it. */
function pickHeaders(r) {
  const h = {};
  try { r.headers.forEach((v, k) => { h[k] = v; }); } catch {}
  return h;
}

async function chat(lane, payload) {
  const p = PROVIDERS[lane.provider];
  const base = lane.provider === "custom" ? lane.customBase : p.base;
  // keyless OpenRouter lane + live backend = the free-credits path
  if (lane.provider === "openrouter" && !lane.key && BACKEND && FREE_INFO) {
    try {
      const r = await fetch(BACKEND + "/proxy/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: lane.model, ...payload }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await r.text();
      if (r.status === 429) {
        let kind = "visitor";
        try { kind = JSON.parse(text).error === "global-exhausted" ? "global" : "visitor"; } catch {}
        if (FREE_INFO) FREE_INFO[kind + "_exhausted"] = true;
        showCreditsBanner(kind);
        return { ok: false, status: 429, error: text };
      }
      if (!r.ok) return { ok: false, status: r.status, error: text };
      const d = JSON.parse(text);
      const choice = (d.choices || [])[0] || {};
      return { ok: true, status: r.status,
        usage: { prompt_tokens: d.usage?.prompt_tokens, completion_tokens: d.usage?.completion_tokens },
        finish: choice.native_finish_reason || choice.finish_reason,
        text: choice.message?.content || "" };
    } catch (e) {
      return { ok: false, status: 0, error: "free-credits backend: " + e.message };
    }
  }
  const t0 = performance.now();
  try {
    let url, headers, body;
    if (p.anthropic) {
      url = base + "/messages";
      headers = { "content-type": "application/json", "x-api-key": lane.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true" };
      body = { model: lane.model, max_tokens: Math.max(1, payload.max_tokens ?? 16),
        messages: payload.messages };
      if (payload.temperature !== undefined) body.temperature = payload.temperature;
      if ((payload.max_tokens ?? 1) < 1) body.max_tokens = payload.max_tokens; // let the probe probe
    } else {
      url = base + "/chat/completions";
      headers = { "content-type": "application/json", Authorization: "Bearer " + lane.key };
      body = { model: lane.model, ...payload };
      // Routers spread calls across hosts whose templates differ, which makes
      // token counts unstable. Pinning one host removes that noise.
      if (lane.provider === "openrouter" && lane.pinHost)
        body.provider = { order: [lane.pinHost], allow_fallbacks: false };
    }
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000) });
    const ttftMs = performance.now() - t0;          // response HEADERS arrived
    const hdrs = pickHeaders(r);

    /* streaming: keep the chunk timeline, then normalize as usual */
    if (payload.stream && r.ok && r.body) {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "", timeline = [], firstAt = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const at = performance.now() - t0;
        const s = dec.decode(value, { stream: true });
        if (firstAt === null && s.trim()) firstAt = at;
        timeline.push({ at: +at.toFixed(1), chars: s.length });
        buf += s;
      }
      const total = performance.now() - t0;
      const out = parseSse(buf);
      if (!out.ok) return { ok: false, status: r.status, error: buf.slice(0, 2000),
        ms: total, ttftMs, headers: hdrs };
      return { ...out, status: r.status, ms: total, ttftMs, headers: hdrs,
        stream: summarizeStream(timeline) };
    }

    const text = await r.text();
    const ms = performance.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, error: text,
      ms, ttftMs, headers: hdrs };
    const d = JSON.parse(text);
    const common = { ok: true, status: r.status, ms, ttftMs, headers: hdrs,
      id: d.id, reportedModel: d.model, systemFingerprint: d.system_fingerprint,
      metadata: d.openrouter_metadata };
    if (p.anthropic) {
      return { ...common,
        usage: { prompt_tokens: d.usage?.input_tokens, completion_tokens: d.usage?.output_tokens },
        finish: d.stop_reason,
        text: (d.content || []).map(b => b.text || "").join("") };
    }
    const choice = (d.choices || [])[0] || {};
    return { ...common,
      usage: { prompt_tokens: d.usage?.prompt_tokens, completion_tokens: d.usage?.completion_tokens },
      reasoningTokens: d.usage?.completion_tokens_details?.reasoning_tokens
        ?? d.usage?.output_tokens_details?.reasoning_tokens ?? null,
      logprobs: choice.logprobs?.content?.[0]?.top_logprobs ?? choice.logprobs ?? null,
      // Routers NORMALIZE finish_reason; the lab's own vocabulary survives in
      // native_finish_reason. Without this, every routed model reads the same.
      finish: choice.native_finish_reason || choice.finish_reason,
      text: choice.message?.content || "" };
  } catch (e) {
    return { ok: false, status: 0, error: "network/CORS: " + e.message,
      ms: performance.now() - t0 };
  }
}

/* SSE buffer -> the same shape a non-streaming call returns */
function parseSse(buf) {
  let text = "", usage = null, finish = null, meta = null, id = null, model = null;
  for (const line of buf.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const data = s.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.openrouter_metadata) meta = j.openrouter_metadata;
    if (j.usage) usage = j.usage;
    if (j.id) id = j.id;
    if (j.model) model = j.model;
    const ch = (j.choices || [])[0] || {};
    if (typeof ch.delta?.content === "string") text += ch.delta.content;
    if (ch.finish_reason) finish = ch.native_finish_reason || ch.finish_reason;
  }
  if (!id && !text && !usage && !finish) return { ok: false };
  return { ok: true,
    usage: { prompt_tokens: usage?.prompt_tokens, completion_tokens: usage?.completion_tokens },
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    finish, text, id, reportedModel: model, systemFingerprint: undefined,
    metadata: meta, logprobs: null };
}

/* chunk timeline -> coarse cadence numbers a probe can bucket */
function summarizeStream(timeline) {
  if (!timeline.length) return null;
  const gaps = [];
  for (let i = 1; i < timeline.length; i++)
    gaps.push(+(timeline[i].at - timeline[i - 1].at).toFixed(1));
  const med = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
  return { chunks: timeline.length,
    ttftMs: timeline[0].at,
    gapMedianMs: med(gaps),
    charsMedian: med(timeline.map(c => c.chars)),
    totalMs: timeline[timeline.length - 1].at };
}

/* authenticated GET through the lane (generation records, host lists).
   Probes get this as ctx.http; the demo harness omits it entirely. */
async function httpGet(lane, pathOrUrl) {
  const p = PROVIDERS[lane.provider];
  const base = lane.provider === "custom" ? lane.customBase : p.base;
  if (!base) return { ok: false, status: 0, text: "no base url", json: null };
  try {
    // SECURITY: a probe is community code and gets the user's key on this call.
    // An absolute URL is allowed ONLY when its origin equals the lane's own
    // endpoint, so a probe can query the provider it is already talking to and
    // can never send the key to a third host. Relative paths resolve to base.
    let url;
    if (/^https?:/.test(pathOrUrl)) {
      if (new URL(pathOrUrl).origin !== new URL(base).origin)
        return { ok: false, status: 0, text: "blocked: cross-origin http not allowed", json: null };
      url = pathOrUrl;
    } else {
      url = base.replace(/\/$/, "") + pathOrUrl;
    }
    const headers = p.anthropic
      ? { "x-api-key": lane.key, "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" }
      : { Authorization: "Bearer " + lane.key };
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, text, json, headers: pickHeaders(r) };
  } catch (e) {
    return { ok: false, status: 0, text: String(e), json: null };
  }
}

/* ---------------- demo adapter: the dummy LLM ---------------- */
const DEMO_DB = {
  glm:      { "tok-english": 47, "tok-chinese": 88, "tok-code": 131, "tok-emoji": 63,
    "template-offset": "+75 (delta 8)",
    "err-temperature": '"temperature must be in [0, 2.0]. Adjust the parameter and resubmit."',
    "err-maxtokens": '"invalid max_tokens: expected positive integer" · code 20015',
    "err-code-family": "numeric-code", "finish-vocab": "stop · length",
    // community probes (simulated)
    "net-region": "iad · Stealth · direct",
    "net-genrecord": "Stealth · global · stop",
    "net-headerdna": "id:gen- · cf-ray · rl-*",
    "cap-contextceiling": "≈1M", "cap-cutoffdate": "≈2025-Q4",
    "leak-wrapper": 'len=213 h=9a41c2f7 "You are GLM…"',
    "reason-trace": "+312 tok",
    "lp-geometry": "δ=0.33 · k=10 ok",
    "stream-cadence": "ttft<300ms · ≤12ch · ≤40ms",
    "behave-onetoken": "42 | blue | heads | 七" },
  deepseek: { "tok-english": 52, "tok-chinese": 96, "tok-code": 127, "tok-emoji": 71,
    "template-offset": "+21 (delta 8)",
    "err-temperature": '"1 validation error: temperature: Input should be less than or equal to 2"',
    "err-maxtokens": '"max_tokens must be greater than 0" · invalid_request_error',
    "err-code-family": "string-code · type:invalid_request_error", "finish-vocab": "stop · length",
    // community probes (simulated)
    "net-region": "iad · DeepSeek · direct",
    "net-genrecord": "DeepSeek · global · stop",
    "net-headerdna": "id:chatcmpl- · server:uvicorn · rl-*",
    "cap-contextceiling": "≈128k", "cap-cutoffdate": "≈2025-Q2",
    "leak-wrapper": "no-leak",
    "reason-trace": "+187 tok",
    "lp-geometry": "δ=0.30 · k=10 ok",
    "stream-cadence": "ttft<800ms · ≤12ch · ≤40ms",
    "behave-onetoken": "37 | blue | heads | 八" },
  openai:   { "tok-english": 44, "tok-chinese": 104, "tok-code": 118, "tok-emoji": 58,
    "template-offset": "+11 (delta 8)",
    "err-temperature": `"'temperature' must be between 0 and 2, got 2.5"`,
    "err-maxtokens": '"max_tokens: integer above 0 expected"',
    "err-code-family": "string-code · param-field", "finish-vocab": "stop · length",
    // community probes (simulated)
    "net-region": "iad · OpenAI · direct",
    "net-genrecord": "OpenAI · global · stop",
    "net-headerdna": "id:chatcmpl- · openai-processing-ms · fp · rl-*",
    "cap-contextceiling": "≈400k", "cap-cutoffdate": "≈2025-Q3",
    "leak-wrapper": "no-leak",
    "reason-trace": "+240 tok",
    "lp-geometry": "δ=0.32 · k=10 ok",
    "stream-cadence": "ttft<300ms · ≤12ch · ≤15ms",
    "behave-onetoken": "42 | blue | heads | 七" },
  anthropic:{ "tok-english": 49, "tok-chinese": 91, "tok-code": 124, "tok-emoji": 66,
    "template-offset": "+3 (delta 8)",
    "err-temperature": '"temperature: range 0..1" (different scale!)',
    "err-maxtokens": '"max_tokens: field required, minimum 1"',
    "err-code-family": "type:invalid_request_error", "finish-vocab": "end_turn · max_tokens",
    // community probes (simulated)
    "net-region": "iad · Anthropic · direct",
    "net-genrecord": "Anthropic · global · end_turn",
    "net-headerdna": "id:msg_ · request-id · rl-*",
    "cap-contextceiling": "≈200k", "cap-cutoffdate": "≈2025-Q1",
    "leak-wrapper": "no-leak",
    "reason-trace": "+96 tok",
    "lp-geometry": "logprobs-unsupported",
    "stream-cadence": "ttft<300ms · ≤4ch · ≤40ms",
    "behave-onetoken": "57 | green | heads | 九" },
  qwen:     { "tok-english": 46, "tok-chinese": 82, "tok-code": 129, "tok-emoji": 61,
    "template-offset": "+44 (delta 8)",
    "err-temperature": '"InvalidParameter: temperature must be in [0, 2)"',
    "err-maxtokens": '"InvalidParameter: max_tokens invalid"',
    "err-code-family": "numeric-code · param-field", "finish-vocab": "stop · length",
    // community probes (simulated)
    "net-region": "iad · Qwen · direct",
    "net-genrecord": "Alibaba · global · stop",
    "net-headerdna": "id:chatcmpl · server:gunicorn · rl-*",
    "cap-contextceiling": "≈256k", "cap-cutoffdate": "≈2025-Q3",
    "leak-wrapper": "no-leak",
    "reason-trace": "+118 tok",
    "lp-geometry": "δ=0.31 · k=10 ok",
    "stream-cadence": "ttft<300ms · ≤4ch · ≤15ms",
    "behave-onetoken": "42 | red | tails | 七" },
};
function demoFamily(model) {
  const m = model.toLowerCase();
  if (m.includes("ox-alpha") || m.includes("glm")) return "glm";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("claude")) return "anthropic";
  if (m.includes("qwen") || m.includes("kimi")) return "qwen";
  return "openai";
}

/* ---------------- probe loading ---------------- */
let PROBES = [];           // [{meta, probe}]
let SELECTED = new Set();   // probe ids that will run; default is all
const isOn = (id) => SELECTED.has(id);
async function loadProbes() {
  // All files in parallel: sequential awaits cost one network round trip
  // per probe and kept the page blank while they queued.
  const loaded = await Promise.all(REGISTRY.map(async (file) => {
    try {
      const mod = await import(`./probes/${file}`);
      if (mod.meta?.id && typeof mod.probe === "function") return mod;
      console.warn("probe rejected (bad exports):", file);
    } catch (e) { console.warn("probe failed to load:", file, e); }
    return null;
  }));
  // registry order is table order, so keep it
  return REGISTRY.map(f => loaded[REGISTRY.indexOf(f)]).filter(Boolean);
}

/* ---------------- state + rendering ---------------- */
const lanesEl = document.getElementById("lanes");
const grid = document.getElementById("grid");
const verdictEl = document.getElementById("verdict");
let lanes = [];
let laneSeq = 0;

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}
window.toast = toast;

window.addLane = function (provider, model, scroll) {
  if (!provider) ping("lane_added");         // only user clicks, not boot lanes
  const prov = provider || "openrouter";     // every new card starts on OpenRouter
  const lane = { id: ++laneSeq, provider: prov, model: model || "",
    key: savedKey(prov), customBase: "", pinHost: "", models: PROVIDERS[prov].models,
    state: "idle", results: {}, raw: {} };
  lanes.push(lane);
  render();
  if (lane.provider === "openrouter") {
    hydrateModels(lane);
    if (lane.model) hydrateHosts(lane);
  }
  if (scroll) requestAnimationFrame(() =>
    window.scrollTo({ left: document.documentElement.scrollWidth, behavior: "smooth" }));
};
window.removeLane = function (id) { lanes = lanes.filter(l => l.id !== id); render(); };
window.setProvider = function (id, provider) {
  const lane = lanes.find(l => l.id === id);
  Object.assign(lane, { provider, model: "", models: PROVIDERS[provider].models,
    key: savedKey(provider), state: "idle", results: {}, fetchNote: "" });
  render();
  if (provider === "openrouter") hydrateModels(lane);
};
window.setModel = function (id, model) {
  const lane = lanes.find(l => l.id === id);
  lane.model = model; lane.state = "idle"; lane.results = {}; lane.hosts = [];
  render();
  if (lane.provider === "openrouter" && model) hydrateHosts(lane);
};

async function hydrateHosts(lane) {
  try {
    const r = await fetch(`https://openrouter.ai/api/v1/models/${lane.model}/endpoints`);
    const d = await r.json();
    lane.hosts = [...new Set((d.data?.endpoints || []).map(e => e.provider_name))].sort();
    // exactly one host serving the model: pin it, there is nothing to choose
    if (lane.hosts.length === 1) lane.pinHost = lane.hosts[0];
  } catch { lane.hosts = []; }
  render();
}
function savedKey(provider) {
  try { return localStorage.getItem("modelprint-key-" + provider) || ""; } catch { return ""; }
}
window.setKey = function (id, key) {
  const lane = lanes.find(l => l.id === id);
  lane.key = key;
  try { localStorage.setItem("modelprint-key-" + lane.provider, key); } catch {}
  for (const other of lanes) {
    if (other.id === id || other.provider !== lane.provider) continue;
    other.key = key;
    const input = document.getElementById("key-" + other.id);
    if (input) input.value = key;
  }
  if (!lane.models.length && key) hydrateModels(lane);
};
window.setCustomBase = function (id, base) {
  const lane = lanes.find(l => l.id === id);
  lane.customBase = base.replace(/\/$/, "");
};
window.setPinHost = function (id, host) {
  const lane = lanes.find(l => l.id === id);
  lane.pinHost = host.trim();
};

async function hydrateModels(lane) {
  lane.fetchNote = "fetching model list…";
  render();
  const models = await fetchModels(lane.provider, lane.key);
  lane.models = models;
  lane.fetchNote = models.length
    ? `✓ ${models.length} models fetched from ${PROVIDERS[lane.provider].label}`
    : "list unavailable — type the model id";
  render();
}

function laneHtml(lane, index) {
  const p = PROVIDERS[lane.provider];
  const letter = String.fromCharCode(65 + index);
  const options = Object.entries(PROVIDERS).map(([k, v]) =>
    `<option value="${k}" ${k === lane.provider ? "selected" : ""}>${v.label}</option>`).join("");
  const modelField = `<div class="picker" id="picker-${lane.id}">
      <input class="mono" placeholder="search ${lane.models.length || ""} models…"
        value="${lane.model}" autocomplete="off"
        onfocus="openPanel(${lane.id})" oninput="filterPanel(${lane.id}, this.value)"
        onkeydown="if(event.key==='Enter'){pickFirst(${lane.id})}if(event.key==='Escape'){closePanels()}">
      <div class="panel" id="panel-${lane.id}" style="display:none"></div>
    </div>`;
  const customField = lane.provider === "custom"
    ? `<label>base url</label><input placeholder="https://api.example.com/v1" class="mono"
         value="${lane.customBase}" onchange="setCustomBase(${lane.id}, this.value)">` : "";
  const keyField = lane.provider === "demo" ? "" :
    `<label>api key${lane.provider === "openrouter" && FREE_INFO ? " (optional)" : ""}</label><input type="password" id="key-${lane.id}" placeholder="${p.keyHint}" class="mono"
       value="${lane.key}" oninput="setKey(${lane.id}, this.value)">`;
  let freeNote = "";
  if (lane.provider === "openrouter" && !lane.key && BACKEND && FREE_INFO) {
    if (lane.model) checkFreeEligible(lane.model);
    if (FREE_INFO.visitor_exhausted || FREE_INFO.global_exhausted)
      freeNote = `<div class="fetchnote">free credits done for today — a free key removes all limits,
        :free models cost $0 → <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai/settings/keys</a></div>`;
    else if (FREE_ELIGIBLE.get(lane.model) === true)
      freeNote = `<div class="fetchnote ok">✓ no key needed — runs on free credits</div>`;
    else if (lane.model && FREE_ELIGIBLE.get(lane.model) === false)
      freeNote = `<div class="fetchnote">this model needs your own key — free credits cover models under $1.50/M</div>`;
  }
  const pinField = lane.provider !== "openrouter" ? "" :
    (lane.hosts?.length
      ? `<label>pin host (optional)</label>
         <select onchange="setPinHost(${lane.id}, this.value)">
           <option value="">any host (auto-routed)</option>
           ${lane.hosts.map(h => `<option ${h === lane.pinHost ? "selected" : ""}>${h}</option>`).join("")}
         </select>`
      : `<label>pin host (optional)</label>
         <input placeholder="pick a model first" class="mono" value="${lane.pinHost || ""}"
           onchange="setPinHost(${lane.id}, this.value)">`);
  const note = lane.fetchNote
    ? `<div class="fetchnote ${lane.fetchNote.startsWith("✓") ? "ok" : ""}">${lane.fetchNote}</div>`
    : (lane.provider === "demo" ? `<div class="fetchnote ok">✓ simulated — try the tool without any key</div>` : "");
  const creditsGone = lane.provider === "openrouter" && !lane.key && lane.model &&
    FREE_INFO && (FREE_INFO.visitor_exhausted || FREE_INFO.global_exhausted);
  const statusLine = (lane.state === "idle" && creditsGone)
      ? `<span class="led"></span>free credits done — needs your key`
      : lane.state === "shared" ? `<span class="led"></span>shared snapshot · Run to verify`
    : lane.state === "idle" ? `<span class="led"></span>ready`
    : lane.state === "running" ? `<span class="led running"></span>${lane.statusText || "starting…"}`
    : `<span class="led done"></span>done · ${SELECTED.size} probes · ${lane.elapsed}s`;
  return `<div class="lanecell"><div class="lane">
    <span class="chip">MODEL ${letter}</span>
    <button class="close" onclick="removeLane(${lane.id})" title="remove">✕</button>
    <label>endpoint</label>
    <select onchange="setProvider(${lane.id}, this.value)">${options}</select>
    ${customField}
    <label>model id</label>
    ${modelField}
    ${note}
    ${keyField}
    ${freeNote}
    ${pinField}
    <div class="status">${statusLine}</div>
  </div></div>`;
}

function render() {
  lanesEl.innerHTML = `<div class="lane-spacer"></div>`
    + lanes.map((l, i) => laneHtml(l, i)).join("")
    + `<button class="add-lane" onclick="addLane(undefined, undefined, true)">
        <span class="plus">+</span><span>add model</span></button>`;
  renderGrid();
}

/* ---------------- searchable model picker ---------------- */
function panelHtml(lane, query) {
  const q = (query || "").toLowerCase().trim();
  const all = lane.models.length ? lane.models : [];
  const opt = (m) => `<div class="opt" onmousedown="pickModel(${lane.id}, this.textContent)">${m}</div>`;
  if (q) {
    const hits = all.filter(m => m.toLowerCase().includes(q)).slice(0, 80);
    return hits.length
      ? `<div class="sect">search results (${hits.length})</div>` + hits.map(opt).join("")
      : `<div class="none">nothing matches "${query}" — press Enter to use it as a custom id</div>`;
  }
  const pop = (POPULAR[lane.provider] || []).filter(m => !all.length || all.includes(m));
  let html = "";
  if (pop.length) html += `<div class="sect">popular</div>` + pop.map(opt).join("");
  if (all.length) html += `<div class="sect">all models (${all.length})</div>` + all.map(opt).join("");
  if (!html) html = `<div class="none">type a model id</div>`;
  return html;
}
window.openPanel = function (id) {
  closePanels();
  const lane = lanes.find(l => l.id === id);
  const panel = document.getElementById("panel-" + id);
  if (!panel) return;
  panel.innerHTML = panelHtml(lane, "");
  panel.style.display = "";
};
window.filterPanel = function (id, query) {
  const lane = lanes.find(l => l.id === id);
  const panel = document.getElementById("panel-" + id);
  if (!panel) return;
  panel.innerHTML = panelHtml(lane, query);
  panel.style.display = "";
};
window.pickModel = function (id, model) {
  closePanels();
  setModel(id, model);
};
window.pickFirst = function (id) {
  const panel = document.getElementById("panel-" + id);
  const first = panel?.querySelector(".opt");
  const input = document.querySelector(`#picker-${id} input`);
  closePanels();
  if (first) setModel(id, first.textContent);
  else if (input?.value) setModel(id, input.value.trim());
};
window.closePanels = function () {
  document.querySelectorAll(".panel").forEach(p => p.style.display = "none");
};
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".picker")) closePanels();
});

/* ---------------- running ---------------- */
function laneReady(lane) {
  if (!lane.model) return false;
  if (lane.provider === "openrouter" && !lane.key && BACKEND && FREE_INFO)
    return FREE_ELIGIBLE.get(lane.model) === true &&
      !FREE_INFO.visitor_exhausted && !FREE_INFO.global_exhausted;
  return lane.provider === "demo" || !!lane.key || lane.provider === "custom";
}

/* While a lane is running, its status line is rebuilt every 3 seconds so a
   long wait on ONE call still tells the visitor the model is busy. */
let WAIT_TICKER = null;
function startWaitTicker() {
  if (WAIT_TICKER) return;
  WAIT_TICKER = setInterval(() => {
    const running = lanes.filter(l => l.state === "running");
    if (!running.length) { clearInterval(WAIT_TICKER); WAIT_TICKER = null; return; }
    let changed = false;
    for (const lane of running) {
      if (!lane.probeStartedAt) continue;
      const waited = Math.round((Date.now() - lane.probeStartedAt) / 1000);
      const next = lane.probeLabel + (waited > 20
        ? ` · waiting ${waited}s, this model is busy` : "");
      if (next !== lane.statusText) { lane.statusText = next; changed = true; }
    }
    if (changed) render();
  }, 3000);
}

window.runAll = async function () {
  const ready = lanes.filter(laneReady);
  if (!ready.length) {
    const creditBlocked = FREE_INFO &&
      (FREE_INFO.visitor_exhausted || FREE_INFO.global_exhausted) &&
      lanes.some(l => l.provider === "openrouter" && !l.key && l.model);
    if (creditBlocked) {
      toast("free credits are done for today — add your own key to run");
      showCreditsBanner(FREE_INFO.global_exhausted ? "global" : "visitor");
    } else toast("configure at least one model first");
    return;
  }
  const btn = document.getElementById("runall");
  btn.disabled = true;
  startWaitTicker();
  ping("run", {
    provider: ready[0]?.provider,
    keyless: ready.every(l => !l.key),
    models: ready.map(l => l.model),
  });
  window.scrollTo({ left: 0, behavior: "smooth" });
  document.querySelector(".tablewrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
  await Promise.all(ready.map(l => runLane(l.id)));
  btn.disabled = false;
  // one-time nudge at the moment of delight: first successful free run
  try {
    const ranFree = ready.some(l => l.provider === "openrouter" && !l.key && l.state === "done");
    if (ranFree && !localStorage.getItem("modelprint-nudged")) {
      localStorage.setItem("modelprint-nudged", "1");
      const verdict = document.getElementById("verdict");
      if (verdict) verdict.insertAdjacentHTML("afterend",
        `<div class="nudge">Ran on free credits. Your own free OpenRouter key takes one minute,
         and the :free models cost $0, without our daily limits.
         <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">get a key</a></div>`);
    }
  } catch { /* storage blocked: skip the nudge */ }
};

window.runLane = async function (id) {
  const lane = lanes.find(l => l.id === id);
  if (!lane || !laneReady(lane) || lane.state === "running") return;
  lane.state = "running"; lane.results = {}; lane.raw = {};
  const started = Date.now();
  const active = PROBES.filter(p => isOn(p.meta.id));
  for (let i = 0; i < active.length; i++) {
    const { meta, probe } = active[i];
    // A provider under load can take minutes ON A SINGLE CALL. The status is
    // therefore rebuilt by a ticker (see startWaitTicker) rather than only
    // between probes, so a lane stuck on one slow call still reports itself.
    lane.probeLabel = `probe ${i + 1}/${active.length} · ${meta.id}`;
    lane.probeStartedAt = Date.now();
    lane.statusText = lane.probeLabel;
    render();
    try {
      let out;
      if (lane.provider === "demo") {
        await new Promise(r => setTimeout(r, 60 + Math.random() * 80));
        out = { value: DEMO_DB[demoFamily(lane.model)][meta.id] };
      } else {
        out = await probe({ chat: (payload) => chat(lane, payload),
          http: (path) => httpGet(lane, path), model: lane.model });
      }
      lane.results[meta.id] = out.value;
      if (out.raw !== undefined) lane.raw[meta.id] = out.raw;
    } catch (e) {
      lane.results[meta.id] = "probe-failed: " + e.message;
    }
  }
  lane.elapsed = ((Date.now() - started) / 1000).toFixed(1);
  lane.state = "done";
  render();
};

/* ---------------- probe selection ---------------- */
window.toggleProbe = function (id) {
  if (SELECTED.has(id)) SELECTED.delete(id); else SELECTED.add(id);
  renderGrid();
};
window.toggleGroup = function (group) {
  const ids = PROBES.filter(p => p.meta.group === group).map(p => p.meta.id);
  const allOn = ids.every(id => SELECTED.has(id));
  for (const id of ids) { if (allOn) SELECTED.delete(id); else SELECTED.add(id); }
  renderGrid();
};
window.selectAllProbes = function (on) {
  SELECTED = on ? new Set(PROBES.map(p => p.meta.id)) : new Set();
  renderGrid();
};

/* ---------------- table + verdict ---------------- */
const GROUP_NOTES = {
  tokenizer: "same text in, token count out — tokenizers are unique per lab",
  errors: "invalid requests return the lab's own validation prose",
  shape: "field vocabulary and finish behaviour",
  network: "routing metadata, generation records and headers identify the serving route",
  capability: "the accepted context-window bucket helps date the model variant",
  leak: "the injected wrapper prompt unmasks whoever is wrapping your traffic",
  reasoning: "thinking overhead and its parameter validation differ per lab",
  logits: "top-logprob geometry survives API truncation; δ≈0.32 is universal, deviations are personal",
  timing: "upstream refusal paths identify the provider; round-trip timing stays in raw",
  behavior: "answer distributions on trivial choices are stable per trained model",
};

function renderGrid() {
  const cols = lanes;
  // table-layout:fixed only engages when the table has a width; without this
  // the browser falls back to auto layout and columns drift from the cards.
  grid.style.width = `calc(var(--probe-col) + ${cols.length} * var(--colw))`;
  let html = `<colgroup><col style="width:var(--probe-col)">${cols.map(() =>
    `<col style="width:var(--colw)">`).join("")}</colgroup>`;
  html += `<thead><tr><th>probe</th>${cols.map(l =>
    `<th>${l.model ? l.model.split("/").pop() : "—"}</th>`).join("")}</tr></thead><tbody>`;
  let lastGroup = null;
  for (const { meta } of PROBES) {
    if (meta.group !== lastGroup) {
      lastGroup = meta.group;
      const gids = PROBES.filter(p => p.meta.group === meta.group).map(p => p.meta.id);
      const gon = gids.filter(id => isOn(id)).length;
      const mark = gon === gids.length ? "on" : gon === 0 ? "off" : "some";
      html += `<tr class="section"><th><button class="gtoggle ${mark}" onclick="toggleGroup('${meta.group}')" title="toggle this group">${meta.group}</button></th>`
        + `<td colspan="${cols.length || 1}">${GROUP_NOTES[meta.group] || ""}</td></tr>`;
    }
    const on = isOn(meta.id);
    const values = cols.map(l => l.results[meta.id]);
    const present = values.filter(v => v !== undefined);
    // Color by VALUE GROUPS, not all-or-nothing: a cell is green when at
    // least one other lane shares its value, red when it stands alone.
    // 47 · 47 · 49 reads as two greens and one red, which is the finding.
    // "busy" answers describe the provider's load, not the model, so they
    // must never make two lanes look equal or different.
    const counts = {};
    for (const v of present) {
      if (isBusy(v)) continue;
      counts[String(v)] = (counts[String(v)] || 0) + 1;
    }
    // Per-row credit: probes by the house author carry no badge; a community
    // probe shows a small tag linking to the contributor's GitHub.
    const HOUSE = "unclecode";
    const badge = (meta.author && meta.author !== HOUSE)
      ? ` <a class="cbadge" href="https://github.com/${encodeURIComponent(meta.author)}" title="community probe by ${meta.author}" target="_blank" rel="noopener">community</a>`
      : "";
    html += `<tr class="${on ? "" : "prow-off"}"><th>`
      + `<label class="pcheck"><input type="checkbox" ${on ? "checked" : ""} onchange="toggleProbe('${meta.id}')"><span>${meta.name}</span></label>`
      + `${badge}<span class="why">${meta.why}</span></th>`;
    cols.forEach((lane, i) => {
      const v = values[i];
      if (v === undefined) {
        html += `<td class="pending">${lane.state === "running" ? '<span class="spin"></span>' : "·"}</td>`;
      } else {
        const cls = isBusy(v) ? "busy"
          : present.length > 1 ? (counts[String(v)] > 1 ? "match" : "diff") : "";
        html += `<td class="${cls}">${meta.long ? `<span class="long">${escapeHtml(String(v))}</span>`
          : `<span class="tick">${escapeHtml(String(v))}</span>`}</td>`;
      }
    });
    html += `</tr>`;
  }
  grid.innerHTML = html + `</tbody>`;
  renderVerdict();
}
function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

function renderVerdict() {
  // Include lanes restored from a share link ("shared"), not only fresh runs,
  // so the match cards appear the moment a shared link opens.
  const done = lanes.filter(l => l.state === "done" || l.state === "shared");
  if (done.length < 2) { verdictEl.innerHTML = ""; return; }
  const ids = PROBES.map(p => p.meta.id).filter(id => SELECTED.has(id));
  const pairs = [];
  for (let a = 0; a < done.length; a++) for (let b = a + 1; b < done.length; b++) {
    const A = done[a], B = done[b];
    // A busy provider must not inflate or deflate a verdict: those probes are
    // dropped from BOTH the hits and the total the score is measured against.
    const usable = ids.filter(k => !isBusy(A.results[k]) && !isBusy(B.results[k]));
    const hits = usable.filter(k => String(A.results[k]) === String(B.results[k])).length;
    pairs.push({ A, B, hits, total: usable.length, skipped: ids.length - usable.length });
  }
  pairs.sort((x, y) => y.hits - x.hits);
  const shown = pairs.slice(0, 8);
  let html = shown.map(({ A, B, hits, total, skipped }) => {
    const pct = total ? Math.round(100 * hits / total) : 0;
    const hot = total > 0 && hits >= total - 1;
    const read = hot
      ? "Same tokenizer, same error prose, same template offset. These endpoints run the same family."
      : hits <= 2 ? "Different plumbing on almost every probe. Unrelated stacks."
      : "Mixed signals. Trust the tokenizer rows most: matching normalized counts on all four texts is hard to fake across labs.";
    return `<div class="vcard ${hot ? "hot" : ""}">
      <div class="pair">${A.model.split("/").pop()} ↔ ${B.model.split("/").pop()}</div>
      <div class="score">${hits} / ${total} match</div>
      ${skipped ? `<div class="skipnote">${skipped} probe${skipped > 1 ? "s" : ""} skipped: model was busy</div>` : ""}
      <div class="read">${read}</div>
      <div class="meter"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join("");
  if (pairs.length > shown.length)
    html += `<div class="vcard"><div class="pair">…and ${pairs.length - shown.length} more pairs</div>
      <div class="read">Strongest matches are shown first.</div></div>`;
  html += `<div class="vshare"><button onclick="shareResult()">↗ Share this result</button></div>`;
  verdictEl.innerHTML = html;
}


/* ---------------- share link ----------------
   The whole comparison lives in the URL hash: which models, on which hosts,
   which probes were selected, and a snapshot of the results. A viewer who
   opens the link sees the exact same board and can click Run to REPRODUCE it.
   Snapshot values are shown labelled "shared, click Run to verify" and are
   never trusted as fact, because a URL can be edited. Pure client-side. */
function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(str) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
// gzip via the browser's native CompressionStream. Values repeat a lot across
// lanes, so the link stays short even though it carries the full results.
async function packState(obj) {
  const json = JSON.stringify(obj);
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(json)); w.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  return bytesToB64url(buf);
}
async function unpackState(b64) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(b64urlToBytes(b64)); w.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(buf));
}

window.shareResult = async function () {
  if (!lanes.some(l => l.state === "done" || l.state === "shared")) {
    toast("run a comparison first, then share it");
    return;
  }
  const order = PROBES.map(p => p.meta.id);
  let mask = 0n;
  order.forEach((id, i) => { if (SELECTED.has(id)) mask |= (1n << BigInt(i)); });
  const done = lanes.filter(l => l.state === "done");
  const sel = order.filter(id => SELECTED.has(id));
  // strongest pair, for the headline
  let vd = null, pairA = "", pairB = "";
  if (done.length >= 2) {
    let best = -1;
    for (let a = 0; a < done.length; a++) for (let b = a + 1; b < done.length; b++) {
      const hits = sel.filter(k => !isBusy(done[a].results[k]) && !isBusy(done[b].results[k])
        && String(done[a].results[k]) === String(done[b].results[k])).length;
      if (hits > best) { best = hits; pairA = done[a].model.split("/").pop(); pairB = done[b].model.split("/").pop(); }
    }
    if (best >= 0) vd = [best, sel.length];
  }
  const payload = {
    v: 1,
    l: lanes.filter(l => l.model).map(l => ({
      p: l.provider, m: l.model, h: l.pinHost || undefined,
      // full results, kept short per value; gzip shrinks the repetition
      r: Object.fromEntries(order.filter(id => l.results[id] !== undefined)
        .map(id => [id, String(l.results[id]).slice(0, 80)])),
    })),
    s: mask.toString(36),
    ...(vd ? { vd } : {}),
  };
  const headline = vd ? `${pairA} vs ${pairB}: ${vd[0]}/${vd[1]} probes match` : "model fingerprint comparison";
  const msg = vd
    ? `I fingerprinted ${pairA} vs ${pairB}. ${vd[0]} of ${vd[1]} infrastructure probes match. Run it yourself, bring your own key:`
    : `Fingerprint any model API with infrastructure probes. Run it yourself:`;
  // the modal opens NOW, in its loading state; the link fills in when ready
  openShareModal({ url: null, headline, msg });
  const packed = await packState(payload);
  let url = window.__shareMemo?.packed === packed ? window.__shareMemo.url : null;
  if (!url) {
    try {
      const r = await fetch(BACKEND + "/s", { method: "POST",
        headers: { "content-type": "text/plain" }, body: packed,
        signal: AbortSignal.timeout(5000) });
      if (r.ok) url = location.origin + location.pathname + "#s=" + (await r.json()).id;
    } catch { /* backend down: long link below */ }
    if (!url) url = location.origin + location.pathname + "#c=" + packed;
    window.__shareMemo = { packed, url };
  }
  openShareModal({ url, headline, msg });
};

function openShareModal({ url, headline, msg }) {
  const loading = !url;
  const xIntent = loading ? "#" : "https://twitter.com/intent/tweet?text="
    + encodeURIComponent(msg) + "&url=" + encodeURIComponent(url);
  let m = document.getElementById("sharemodal");
  if (!m) { m = document.createElement("div"); m.id = "sharemodal"; document.body.appendChild(m); }
  m.innerHTML = `<div class="sm-back" onclick="closeShareModal(event)">
    <div class="sm-card" onclick="event.stopPropagation()">
      <button class="sm-x" onclick="closeShareModal()">✕</button>
      <div class="sm-title">Share this result</div>
      <div class="sm-headline">${headline}</div>
      <textarea class="sm-msg" id="sm-msg" rows="3">${msg}</textarea>
      <div class="sm-link mono${loading ? " sm-loading" : ""}">${loading ? "creating link…" : url}</div>
      <div class="sm-actions">
        <a class="sm-x-btn${loading ? " sm-off" : ""}" href="${xIntent}" ${loading ? "" : 'target="_blank" rel="noopener"'}>Share on X</a>
        <button class="sm-copy" ${loading ? "disabled" : ""} onclick="copyShareLink('${loading ? "" : url.replace(/'/g, "\\'")}')">Copy link</button>
      </div>
      <div class="sm-note">The opener sees your result and can Run to reproduce it. Image preview coming soon.</div>
    </div></div>`;
  m.style.display = "block";
}
window.closeShareModal = function (e) { if (e) e.stopPropagation();
  const m = document.getElementById("sharemodal"); if (m) m.style.display = "none"; };
window.copyShareLink = function (url) {
  const t = document.getElementById("sm-msg");
  const full = (t ? t.value + "\n" : "") + url;
  copyText(full, "message + link copied");
};

// clipboard API exists only on https / localhost; degrade gracefully on http.
function copyText(text, okMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(okMsg), () => legacyCopy(text, okMsg));
  } else legacyCopy(text, okMsg);
}
function legacyCopy(text, okMsg) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    ok ? toast(okMsg) : prompt("copy this link:", text);
  } catch { prompt("copy this link:", text); }
}

async function restoreFromHash() {
  const short = location.hash.match(/#s=([a-z2-9]{6})/);
  if (short) {
    try {
      const r = await fetch(BACKEND + "/s/" + short[1], { signal: AbortSignal.timeout(6000) });
      if (r.ok) return await restorePacked(await r.text());
    } catch { /* fall through: nothing to restore */ }
  }
  const m = location.hash.match(/#c=([A-Za-z0-9\-_]+)/);
  if (!m) return false;
  return restorePacked(m[1]);
}

/* Rebuild the board from a packed share state (from a #c= hash or a short
   link's stored body). Same restore either way. */
async function restorePacked(packed) {
  let data; try { data = await unpackState(packed); } catch { return false; }
  if (!data || !Array.isArray(data.l)) return false;
  // rebuild lanes WITH the sharer's results, marked "shared" (Run to verify)
  lanes = []; laneSeq = 0;
  for (const L of data.l) {
    const hasResults = L.r && Object.keys(L.r).length > 0;
    const lane = { id: ++laneSeq, provider: L.p || "openrouter", model: L.m || "",
      key: savedKey(L.p || "openrouter"), customBase: "", pinHost: L.h || "",
      models: PROVIDERS[L.p || "openrouter"]?.models || [],
      state: hasResults ? "shared" : "idle",
      results: { ...(L.r || {}) }, raw: {}, shared: hasResults };
    lanes.push(lane);
    if (lane.provider === "openrouter") { hydrateModels(lane); if (lane.model) hydrateHosts(lane); }
  }
  window.__pendingSel = data.s;
  window.__sharedVerdict = data.vd || null;
  // land the opener on the VERDICT cards, the bottom line of the result
  setTimeout(() => {
    const verdict = document.getElementById("verdict");
    (verdict?.innerHTML ? verdict : document.querySelector(".tablewrap"))
      ?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, 600);
  return true;
}
function applyPendingSelection() {
  if (!window.__pendingSel) return;
  const order = PROBES.map(p => p.meta.id);
  let mask; try { mask = BigInt(parseInt(window.__pendingSel, 36)); } catch { mask = null; }
  if (mask !== null && mask >= 0n) {
    SELECTED = new Set(order.filter((_, i) => (mask >> BigInt(i)) & 1n));
  }
  window.__pendingSel = null;
}

/* ---------------- exports ---------------- */
window.exportMarkdown = function () {
  const done = lanes.filter(l => l.state === "done");
  let md = `| probe | ${done.map(l => l.model).join(" | ")} |\n`;
  md += `|---|${done.map(() => "---").join("|")}|\n`;
  for (const { meta } of PROBES)
    md += `| ${meta.name} | ${done.map(l => String(l.results[meta.id] ?? "")).join(" | ")} |\n`;
  copyText(md, "markdown copied");
};
window.exportJson = function () {
  const done = lanes.filter(l => l.state === "done");
  const out = done.map(l => ({ provider: l.provider, model: l.model,
    results: l.results, raw: l.raw }));
  copyText(JSON.stringify(out, null, 2), "JSON copied");
};

/* ---------------- boot ---------------- */
(async function boot() {
  if (BACKEND) {
    fetch(BACKEND + "/proxy/status", { signal: AbortSignal.timeout(6000) })
      .then(r => r.ok ? r.json() : null)
      .then(info => {
        FREE_INFO = (info && info.enabled) ? info : null;
        if (FREE_INFO?.global_exhausted) showCreditsBanner("global");
        else if (FREE_INFO?.visitor_exhausted) showCreditsBanner("visitor");
        render();
      })
      .catch(() => { FREE_INFO = null; });
    ping("visit");
    ping("beat");
  }
  // Cards first, instantly; probes stream in behind them.
  // Lane A: the current mystery model, real OpenRouter, host pre-pinned
  // (it is served by exactly one host, "Stealth"). The visitor adds a key.
  // Lane B: empty, focused — the model YOU suspect goes here.
  // The Demo provider stays one dropdown away for key-less visitors.
  const restored = await restoreFromHash();
  PROBES = await loadProbes();
  SELECTED = new Set(PROBES.map(p => p.meta.id));
  if (restored) applyPendingSelection();
  document.getElementById("modebadge").style.display = "";
  document.getElementById("modebadge").textContent = `${PROBES.length} probes loaded`;

  if (restored && lanes.length) {
    render();
    if (window.__sharedVerdict) {
      const [h, t] = window.__sharedVerdict;
      const a = lanes[0]?.model?.split("/").pop() || "A";
      const b = lanes[1]?.model?.split("/").pop() || "B";
      toast(`shared: ${a} vs ${b} was ${h}/${t} match — Run to verify`);
    }
  } else {
    addLane("openrouter", "stealth/ox-alpha");
    addLane("openrouter", "");
  }
  render();
  // focus lane B's model picker once its list arrives — but ONLY on a fresh
  // visit. A share-link opener is here to READ a result; stealing focus
  // would also yank the viewport back up to the cards.
  if (!restored) {
    const focusB = setInterval(() => {
      const cells = document.querySelectorAll(".lanecell");
      if (cells.length >= 2) {
        const modelSelect = cells[1].querySelectorAll("select")[1] || cells[1].querySelector("input.mono");
        if (modelSelect) { modelSelect.focus(); clearInterval(focusB); }
      }
    }, 400);
    setTimeout(() => clearInterval(focusB), 6000);
  }
})();
