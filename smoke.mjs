// Node smoke test: load every probe from the registry and run the full set
// against two REAL cheap models through OpenRouter. Proves the plugin
// contract, the adapter and each probe before any browser is involved.
import { REGISTRY } from "./probes/index.js";
import { readFileSync } from "fs";

const KEY = process.env.OPENROUTER_API_KEY
  || (() => { try {
    return Object.fromEntries(readFileSync(process.env.HOME + "/devs/x-reach/.env", "utf8")
      .split("\n").filter(l => l.includes("=") && !l.startsWith("#"))
      .map(l => l.split("=", 2))).OPENROUTER_API_KEY;
  } catch { return ""; } })();
if (!KEY) { console.error("set OPENROUTER_API_KEY"); process.exit(1); }

async function chat(model, payload) {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify({ model, ...payload }),
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: text };
    const d = JSON.parse(text);
    const choice = (d.choices || [])[0] || {};
    return { ok: true, status: r.status,
      usage: { prompt_tokens: d.usage?.prompt_tokens, completion_tokens: d.usage?.completion_tokens },
      finish: choice.native_finish_reason || choice.finish_reason, text: choice.message?.content || "" };
  } catch (e) { return { ok: false, status: 0, error: String(e) }; }
}

const MODELS = ["z-ai/glm-4.7-flash", "deepseek/deepseek-v4-flash"];
const probes = [];
for (const f of REGISTRY) {
  const mod = await import(`./probes/${f}`);
  if (!mod.meta?.id || typeof mod.probe !== "function") {
    console.log(`  LOAD FAIL ${f}`); process.exit(1);
  }
  probes.push(mod);
}
console.log(`  ${probes.length} probes loaded from registry\n`);

const results = {};
for (const model of MODELS) {
  results[model] = {};
  for (const { meta, probe } of probes) {
    const t0 = Date.now();
    const out = await probe({ chat: (p) => chat(model, p), model });
    results[model][meta.id] = out.value;
    console.log(`  ${model.padEnd(28)} ${meta.id.padEnd(18)} ${String(out.value).slice(0, 80)}  (${Date.now()-t0}ms)`);
  }
  console.log();
}
const ids = probes.map(p => p.meta.id);
const hits = ids.filter(k => String(results[MODELS[0]][k]) === String(results[MODELS[1]][k]));
console.log(`  match: ${hits.length}/${ids.length}  (${hits.join(", ") || "none"})`);
