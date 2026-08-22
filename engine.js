/* modelprint engine — loads the approved probes, drives lanes, renders the board.
   Design contract with probes/: see probes/_template.js. */

import { REGISTRY } from "./probes/index.js";

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
    // Opt-in routing snapshot on every OpenRouter call: names the edge region
    // and the provider that actually served the request (net-region probe).
    if (lane.provider === "openrouter") headers["X-OpenRouter-Metadata"] = "enabled";

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
    `<label>api key</label><input type="password" id="key-${lane.id}" placeholder="${p.keyHint}" class="mono"
       value="${lane.key}" oninput="setKey(${lane.id}, this.value)">`;
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
  const statusLine = lane.state === "idle" ? `<span class="led"></span>ready`
    : lane.state === "running" ? `<span class="led running"></span>${lane.statusText || "starting…"}`
    : `<span class="led done"></span>done · ${PROBES.length}/${PROBES.length} probes · ${lane.elapsed}s`;
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
  return lane.model && (lane.provider === "demo" || lane.key || lane.provider === "custom");
}

window.runAll = async function () {
  const ready = lanes.filter(laneReady);
  if (!ready.length) { toast("configure at least one model first"); return; }
  const btn = document.getElementById("runall");
  btn.disabled = true;
  window.scrollTo({ left: 0, behavior: "smooth" });
  document.querySelector(".tablewrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
  await Promise.all(ready.map(l => runLane(l.id)));
  btn.disabled = false;
};

window.runLane = async function (id) {
  const lane = lanes.find(l => l.id === id);
  if (!lane || !laneReady(lane) || lane.state === "running") return;
  lane.state = "running"; lane.results = {}; lane.raw = {};
  const started = Date.now();
  for (let i = 0; i < PROBES.length; i++) {
    const { meta, probe } = PROBES[i];
    lane.statusText = `probe ${i + 1}/${PROBES.length} · ${meta.id}`;
    render();
    try {
      let out;
      if (lane.provider === "demo") {
        await new Promise(r => setTimeout(r, 300 + Math.random() * 450));
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

/* ---------------- table + verdict ---------------- */
const GROUP_NOTES = {
  tokenizer: "same text in, token count out — tokenizers are unique per lab",
  errors: "invalid requests return the lab's own validation prose",
  shape: "field vocabulary and finish behaviour",
  network: "routing metadata, generation records and headers name the host that served you",
  capability: "hard ceilings: context length and knowledge cutoff date the checkpoint",
  leak: "the injected wrapper prompt unmasks whoever is wrapping your traffic",
  reasoning: "thinking overhead and its parameter validation differ per lab",
  logits: "top-logprob geometry survives API truncation; δ≈0.32 is universal, deviations are personal",
  timing: "streaming chunk pacing fingerprints the serving stack",
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
      html += `<tr class="section"><th>${meta.group}</th><td colspan="${cols.length || 1}">${GROUP_NOTES[meta.group] || ""}</td></tr>`;
    }
    const values = cols.map(l => l.results[meta.id]);
    const present = values.filter(v => v !== undefined);
    // Color by VALUE GROUPS, not all-or-nothing: a cell is green when at
    // least one other lane shares its value, red when it stands alone.
    // 47 · 47 · 49 reads as two greens and one red, which is the finding.
    const counts = {};
    for (const v of present) counts[String(v)] = (counts[String(v)] || 0) + 1;
    html += `<tr><th>${meta.name}<span class="why">${meta.why}</span></th>`;
    cols.forEach((lane, i) => {
      const v = values[i];
      if (v === undefined) {
        html += `<td class="pending">${lane.state === "running" ? '<span class="spin">◌</span>' : "·"}</td>`;
      } else {
        const cls = present.length > 1 ? (counts[String(v)] > 1 ? "match" : "diff") : "";
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
  const done = lanes.filter(l => l.state === "done");
  if (done.length < 2) { verdictEl.innerHTML = ""; return; }
  const ids = PROBES.map(p => p.meta.id);
  const pairs = [];
  for (let a = 0; a < done.length; a++) for (let b = a + 1; b < done.length; b++) {
    const A = done[a], B = done[b];
    const hits = ids.filter(k => String(A.results[k]) === String(B.results[k])).length;
    pairs.push({ A, B, hits });
  }
  pairs.sort((x, y) => y.hits - x.hits);
  const shown = pairs.slice(0, 8);
  let html = shown.map(({ A, B, hits }) => {
    const pct = Math.round(100 * hits / ids.length);
    const hot = hits >= ids.length - 1;
    const read = hot
      ? "Same tokenizer, same error prose, same template offset. These endpoints run the same family."
      : hits <= 2 ? "Different plumbing on almost every probe. Unrelated stacks."
      : "Mixed signals. Trust the tokenizer rows most: matching normalized counts on all four texts is hard to fake across labs.";
    return `<div class="vcard ${hot ? "hot" : ""}">
      <div class="pair">${A.model.split("/").pop()} ↔ ${B.model.split("/").pop()}</div>
      <div class="score">${hits} / ${ids.length} match</div>
      <div class="read">${read}</div>
      <div class="meter"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join("");
  if (pairs.length > shown.length)
    html += `<div class="vcard"><div class="pair">…and ${pairs.length - shown.length} more pairs</div>
      <div class="read">Strongest matches are shown first.</div></div>`;
  verdictEl.innerHTML = html;
}

/* ---------------- exports ---------------- */
window.exportMarkdown = function () {
  const done = lanes.filter(l => l.state === "done");
  let md = `| probe | ${done.map(l => l.model).join(" | ")} |\n`;
  md += `|---|${done.map(() => "---").join("|")}|\n`;
  for (const { meta } of PROBES)
    md += `| ${meta.name} | ${done.map(l => String(l.results[meta.id] ?? "")).join(" | ")} |\n`;
  navigator.clipboard.writeText(md).then(() => toast("markdown copied"));
};
window.exportJson = function () {
  const done = lanes.filter(l => l.state === "done");
  const out = done.map(l => ({ provider: l.provider, model: l.model,
    results: l.results, raw: l.raw }));
  navigator.clipboard.writeText(JSON.stringify(out, null, 2)).then(() => toast("JSON copied"));
};

/* ---------------- boot ---------------- */
(async function boot() {
  // Cards first, instantly; probes stream in behind them.
  // Lane A: the current mystery model, real OpenRouter, host pre-pinned
  // (it is served by exactly one host, "Stealth"). The visitor adds a key.
  // Lane B: empty, focused — the model YOU suspect goes here.
  // The Demo provider stays one dropdown away for key-less visitors.
  addLane("openrouter", "stealth/ox-alpha");
  addLane("openrouter", "");
  PROBES = await loadProbes();
  document.getElementById("modebadge").style.display = "";
  document.getElementById("modebadge").textContent = `${PROBES.length} probes loaded`;
  render();
  // focus lane B's model picker once its list arrives
  const focusB = setInterval(() => {
    const cells = document.querySelectorAll(".lanecell");
    if (cells.length >= 2) {
      const control = cells[1].querySelector("select:nth-of-type(2), input.mono, select");
      const modelSelect = cells[1].querySelectorAll("select")[1] || cells[1].querySelector("input.mono");
      if (modelSelect) { modelSelect.focus(); clearInterval(focusB); }
    }
  }, 400);
  setTimeout(() => clearInterval(focusB), 6000);
})();
