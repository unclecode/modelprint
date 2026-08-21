// The last untested suspect: Xiaomi MiMo, through its official API.
// Same probes, same contract; compared against the mystery fingerprint.
import { REGISTRY } from "./probes/index.js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(process.env.HOME + "/devs/x-reach/.env", "utf8").split("\n")
    .filter(l => l.includes("=") && !l.startsWith("#")).map(l => l.split("=", 2)));

async function chat(model, payload) {
  try {
    const r = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + env.MIMO_API_KEY },
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

// the mystery fingerprint from tonight's 12-model lineup
const OX = { "tok-english": "47", "tok-chinese": "56", "tok-code": "60", "tok-emoji": "90" };

const probes = [];
for (const f of REGISTRY) probes.push(await import(`./probes/${f}`));

for (const model of ["mimo-v2.5-pro", "mimo-v2.5"]) {
  console.log(`\n== ${model} ==`);
  let tokHits = 0, tokTotal = 0;
  for (const { meta, probe } of probes) {
    const out = await probe({ chat: p => chat(model, p), model });
    const v = String(out.value);
    let mark = "";
    if (meta.id in OX) { tokTotal++; if (v === OX[meta.id]) { tokHits++; mark = "  <-- MATCHES OX"; } }
    console.log(`  ${meta.id.padEnd(18)} ${v.slice(0, 90)}${mark}`);
  }
  console.log(`  tokenizer match vs mystery: ${tokHits}/${tokTotal}`);
}
