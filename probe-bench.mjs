#!/usr/bin/env node
/* probe-bench: the LIVE behavior gate. Needs OPENROUTER_API_KEY.
 *
 * Repeatable by construction: every model call pins ONE host (no routing
 * roulette), uses temperature 0 where the probe allows, and every probe is
 * run TWICE so a fluctuating value is reported as unstable instead of passing
 * by luck. The same command on the same day gives the same verdicts.
 *
 * Three cases, each testing a different property:
 *   SAME    deepseek-v4-flash vs -flash-0731  (same model, 2 snapshots)
 *           -> probes must say NEARLY IDENTICAL. A difference = false positive.
 *   FAMILY  glm-4.7-flash vs glm-5.3          (same lab, different generation)
 *           -> tokenizers should MATCH, deep probes should DIFFER (resolution).
 *   Per probe: does it return a real value, is it stable, what does it cost.
 *
 * Never runs automatically on untrusted PR code (that would expose the key).
 */
import { REGISTRY } from "./probes/index.js";
import { readFileSync } from "fs";

const KEY = process.env.OPENROUTER_API_KEY
  || (() => { try {
    return Object.fromEntries(readFileSync(process.env.HOME + "/devs/x-reach/.env", "utf8")
      .split("\n").filter(l => l.includes("=") && !l.startsWith("#")).map(l => l.split("=", 2)))
      .OPENROUTER_API_KEY;
  } catch { return ""; } })();
if (!KEY) { console.error("set OPENROUTER_API_KEY"); process.exit(1); }

const BASE = "https://openrouter.ai/api/v1";
// [id, pinned host] — pinning removes multi-host routing noise, the #1 source
// of false instability. Same host every run = repeatable.
const HOST = "DeepInfra";
const MODELS = {
  "ds-flash":       ["deepseek/deepseek-v4-flash", HOST],
  "ds-flash-0731":  ["deepseek/deepseek-v4-flash-0731", HOST],
  "glm-4.7-flash":  ["z-ai/glm-4.7-flash", HOST],
  "glm-5.3":        ["z-ai/glm-5.3", HOST],
};
const TOKENIZER_PROBES = new Set(["tok-english","tok-chinese","tok-code","tok-emoji"]);

function makeCtx(spec) {
  const [model, host] = spec;
  let inTok = 0, outTok = 0;
  const chat = async (payload) => {
    // temperature 0 unless the probe deliberately set one (error probes send 2.0)
    const body = { temperature: 0, ...payload, model,
      provider: { order: [host], allow_fallbacks: false } };
    const started = Date.now();
    let r;
    try {
      r = await fetch(BASE + "/chat/completions", { method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer " + KEY,
          "X-OpenRouter-Metadata": "enabled" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    } catch (e) { return { ok: false, status: 0, error: String(e) }; }
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: text, headers: hdrs(r) };
    const d = JSON.parse(text);
    const c = (d.choices || [])[0] || {};
    inTok += d.usage?.prompt_tokens || 0; outTok += d.usage?.completion_tokens || 0;
    return { ok: true, status: r.status,
      usage: { prompt_tokens: d.usage?.prompt_tokens, completion_tokens: d.usage?.completion_tokens },
      finish: c.native_finish_reason || c.finish_reason, text: c.message?.content || "",
      headers: hdrs(r), ms: Date.now() - started, id: d.id,
      reportedModel: d.model, logprobs: c.logprobs?.content || [], chunks: [] };
  };
  const http = async (p) => {
    const url = /^https?:/.test(p) ? p : BASE + p;
    try { const r = await fetch(url, { headers: { Authorization: "Bearer " + KEY }, signal: AbortSignal.timeout(30_000) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, status: r.status, text: t, json: j };
    } catch (e) { return { ok: false, status: 0, text: String(e), json: null }; }
  };
  return { ctx: { model, chat, http }, cost: () => ({ inTok, outTok }) };
}
function hdrs(r) { const o = {}; for (const [k, v] of r.headers) o[k.toLowerCase()] = v; return o; }

const probes = [];
for (const f of REGISTRY) probes.push(await import(`./probes/${f}`));
const ids = probes.map(p => p.meta.id);

async function runModel(spec) {
  const a = makeCtx(spec), b = makeCtx(spec);
  const out = {};
  for (const { meta, probe } of probes) {
    let v1, v2, err = null;
    try { v1 = (await probe(a.ctx)).value; } catch (e) { err = "threw: " + e.message; }
    try { v2 = (await probe(b.ctx)).value; } catch (e) { err = err || "threw: " + e.message; }
    out[meta.id] = { v1, v2, err, stable: !err && String(v1) === String(v2),
      value: err ? "ERROR" : String(v1) };
  }
  const cost = { ...a.cost() }; for (const k in b.cost()) cost[k] += b.cost()[k];
  return { out, cost };
}

console.log(`bench: ${probes.length} probes, host pinned to ${HOST}, temp 0, twice each\n`);
const R = {};
for (const [name, spec] of Object.entries(MODELS)) { R[name] = await runModel(spec); }

// ---- per-probe health on ds-flash ----
const H = "ds-flash";
console.log("PER PROBE (on " + H + "):");
console.log("  probe                   value                              stable");
for (const { meta } of probes) {
  const r = R[H].out[meta.id];
  console.log(`  ${meta.id.padEnd(23)} ${r.value.replace(/\n/g," ").slice(0,34).padEnd(34)} ${r.stable ? "yes" : "NO"}`);
}
const unstable = ids.filter(k => !R[H].out[k].stable && R[H].out[k].err === null);
const crashed = ids.filter(k => R[H].out[k].err && R[H].out[k].err.startsWith("threw"));

// ---- CASE SAME: ds-flash vs ds-flash-0731 -> should be near identical ----
const sameMatch = ids.filter(k => String(R["ds-flash"].out[k].v1) === String(R["ds-flash-0731"].out[k].v1));
const sameDiff = ids.filter(k => !sameMatch.includes(k));
// ---- CASE FAMILY: glm-4.7-flash vs glm-5.3 -> tokenizers match, deep differ ----
const tokMatch = [...TOKENIZER_PROBES].filter(k => String(R["glm-4.7-flash"].out[k].v1) === String(R["glm-5.3"].out[k].v1));
const famMatch = ids.filter(k => String(R["glm-4.7-flash"].out[k].v1) === String(R["glm-5.3"].out[k].v1));
const famDiff = ids.filter(k => !famMatch.includes(k));

console.log("\nCASE SAME  (deepseek-v4-flash vs its -0731 snapshot, should be identical):");
console.log(`  match ${sameMatch.length}/${ids.length}  |  differ on: ${sameDiff.join(", ") || "none"}`);
console.log("\nCASE FAMILY  (glm-4.7-flash vs glm-5.3, tokenizers should match, deep should differ):");
console.log(`  tokenizer probes match: ${tokMatch.length}/4 (${tokMatch.join(", ")||"none"})`);
console.log(`  total match ${famMatch.length}/${ids.length}  |  deep probes that separate the versions: ${famDiff.filter(k=>!TOKENIZER_PROBES.has(k)).join(", ") || "none"}`);

console.log("\nHEALTH:");
console.log(`  crashed: ${crashed.length ? crashed.join(", ") : "none"}`);
console.log(`  unstable (fluctuate on same model): ${unstable.length ? unstable.join(", ") : "none"}`);
let totIn = 0, totOut = 0;
for (const name in R) { totIn += R[name].cost.inTok; totOut += R[name].cost.outTok; }
console.log(`  total cost this bench: ${totIn.toLocaleString()} in + ${totOut.toLocaleString()} out tokens across 4 models`);
const heavy = ids.map(k => [k, R[H].out[k]]).length;
