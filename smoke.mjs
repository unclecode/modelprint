// Node smoke test: load every probe from the registry and run the full set
// against two REAL cheap models through OpenRouter. Proves the plugin
// contract, the adapter and each probe before any browser is involved.
import { REGISTRY } from "./probes/index.js";
import { chat, httpGet, loadKey } from "./net-harness.mjs";

if (!loadKey()) { console.error("set OPENROUTER_API_KEY"); process.exit(1); }

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
    const out = await probe({ chat: (p) => chat(model, p), http: httpGet, model });
    results[model][meta.id] = out.value;
    console.log(`  ${model.padEnd(28)} ${meta.id.padEnd(20)} ${String(out.value).slice(0, 80)}  (${Date.now()-t0}ms)`);
  }
  console.log();
}
const ids = probes.map(p => p.meta.id);
const hits = ids.filter(k => String(results[MODELS[0]][k]) === String(results[MODELS[1]][k]));
console.log(`  match: ${hits.length}/${ids.length}  (${hits.join(", ") || "none"})`);
