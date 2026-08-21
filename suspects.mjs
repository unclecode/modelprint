// The full lineup: run every crowd-guessed suspect through all probes and
// rank by match against the mystery model. Also a stress test: any probe
// crashing on any provider's quirks shows up here before launch.
import { REGISTRY } from "./probes/index.js";
import { readFileSync } from "fs";

const KEY = process.env.OPENROUTER_API_KEY
  || (() => { try {
    return Object.fromEntries(readFileSync(process.env.HOME + "/devs/x-reach/.env", "utf8")
      .split("\n").filter(l => l.includes("=") && !l.startsWith("#"))
      .map(l => l.split("=", 2))).OPENROUTER_API_KEY;
  } catch { return ""; } })();
if (!KEY) { console.error("set OPENROUTER_API_KEY"); process.exit(1); }

const MYSTERY = "stealth/ox-alpha";
const SUSPECTS = [
  "z-ai/glm-5.3", "z-ai/glm-5.2", "z-ai/glm-4.7-flash",
  "moonshotai/kimi-k3", "qwen/qwen3.7-flash", "deepseek/deepseek-v4-flash",
  "google/gemini-3.7-flash", "minimax/minimax-m3", "x-ai/grok-4.6",
  "openai/gpt-5.6-luna", "anthropic/claude-opus-5",
];

async function chat(model, payload) {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify({ model, ...payload }),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: text };
    const d = JSON.parse(text);
    const choice = (d.choices || [])[0] || {};
    return { ok: true, status: r.status,
      usage: { prompt_tokens: d.usage?.prompt_tokens, completion_tokens: d.usage?.completion_tokens },
      finish: choice.native_finish_reason || choice.finish_reason,
      text: choice.message?.content || "" };
  } catch (e) { return { ok: false, status: 0, error: String(e) }; }
}

const probes = [];
for (const f of REGISTRY) probes.push(await import(`./probes/${f}`));
const ids = probes.map(p => p.meta.id);

async function runModel(model) {
  const out = {};
  for (const { meta, probe } of probes) {
    try { out[meta.id] = (await probe({ chat: p => chat(model, p), model })).value; }
    catch (e) { out[meta.id] = "PROBE-CRASH: " + e.message; }
  }
  return out;
}

console.log(`running ${1 + SUSPECTS.length} models x ${ids.length} probes in parallel...\n`);
const all = await Promise.all([MYSTERY, ...SUSPECTS].map(async m => {
  const r = await runModel(m);
  console.log(`  done: ${m}`);
  return [m, r];
}));
const results = Object.fromEntries(all);
const ox = results[MYSTERY];

// any crashes or failures anywhere?
let crashes = 0;
for (const [m, r] of all) for (const k of ids) {
  const v = String(r[k]);
  if (v.startsWith("PROBE-CRASH")) { console.log(`  CRASH ${m} ${k}: ${v.slice(0, 90)}`); crashes++; }
}
console.log(crashes ? `\n${crashes} crashes above\n` : "no probe crashes on any model\n");

console.log("mystery model fingerprint:");
for (const k of ids) console.log(`  ${k.padEnd(18)} ${String(ox[k]).slice(0, 90)}`);

console.log("\nmatch vs ox-alpha (tokenizer rows are the strong evidence):");
const rank = SUSPECTS.map(m => {
  const hits = ids.filter(k => String(results[m][k]) === String(ox[k]));
  const tok = ["tok-english","tok-chinese","tok-code","tok-emoji"]
    .filter(k => String(results[m][k]) === String(ox[k])).length;
  return { m, hits: hits.length, tok };
}).sort((a, b) => b.hits - a.hits || b.tok - a.tok);
for (const { m, hits, tok } of rank)
  console.log(`  ${String(hits).padStart(2)}/9  tokenizer ${tok}/4  ${m}`);
