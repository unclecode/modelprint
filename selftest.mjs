// Key-less verification: import every registry probe and run it twice,
// once against a RICH harness (telemetry like the browser adapter) and
// once against the MINIMAL legacy shape (old smoke.mjs). Proves the
// contract holds: no crash, always a value, meta.id matches filename.
//   node selftest.mjs
import { REGISTRY } from "./probes/index.js";

const GROUPS = new Set(["tokenizer", "errors", "shape", "network",
  "capability", "leak", "reasoning", "logits", "timing", "behavior"]);

/* ---- mock endpoint ---- */
function mockText(content) {
  const c = String(content);
  const y = c.match(/(19|20)\d\d/)?.[0] || "2024";
  if (/month and year/i.test(c)) return "March 2024";
  if (/random number between 1 and 100/i.test(c)) return "42";
  if (/random color/i.test(c)) return "blue";
  if (/flip a coin/i.test(c)) return "heads";
  if (/随机说一个/.test(c)) return "七";
  return c.length > 80 ? "ok" : "Paris";
}

function mockResult(payload, rich) {
  const content = payload.messages?.[0]?.content ?? "";
  const headers = { "cf-ray": "8a91b_mock", "x-request-id": "req_mock123",
    "openai-version": "2020-10-01", "x-ratelimit-limit-tokens": "30000",
    server: "cloudflare" };
  const strip = (r) => {
    if (!rich) { const { ms, ttftMs, headers, id, reportedModel, systemFingerprint,
      metadata, reasoningTokens, logprobs, stream, ...rest } = r; return rest; }
    return r;
  };

  // pretend the endpoint dies above ~64k tokens of padding ("a " ≈ 1 tok)
  if (content.length > 130000)
    return strip({ ok: false, status: 400,
      error: '{"error":{"message":"This model supports at most 131072 context tokens"}}' });

  if (payload.temperature === 2.0)
    return strip({ ok: false, status: 400,
      error: '{"error":{"message":"temperature must be in [0, 2)","code":1301}}' });
  if (payload.reasoning_effort === "banana")
    return strip({ ok: false, status: 400,
      error: '{"error":{"message":"reasoning_effort must be one of \\"low\\", \\"medium\\", \\"high\\""}}' });
  if (payload.max_tokens !== undefined && payload.max_tokens < 1)
    return strip({ ok: false, status: 400,
      error: '{"error":{"message":"max_tokens must be positive","type":"invalid_request_error"}}' });
  if (payload.stream) {
    const s = { chunks: 14, ttftMs: 190, gapMedianMs: 24, charsMedian: 5, totalMs: 1100 };
    return strip({ ok: true, status: 200, finish: "stop",
      text: "one two three four five six seven eight nine ten",
      usage: { prompt_tokens: 15, completion_tokens: 20 }, stream: s });
  }
  const lp = [];
  for (let i = 0; i < 10; i++) lp.push({ token: "t" + i, logprob: -(0.2 * i * i + 0.1) });
  return strip({
    ok: true, status: 200, finish: "stop",
    text: mockText(content),
    usage: { prompt_tokens: 7 + Math.ceil(content.length / 2),
             completion_tokens: Math.min(payload.max_tokens ?? 8, 5) },
    id: "gen-mock0001", reportedModel: "mock/mock", systemFingerprint: "fp_mock",
    metadata: { region: "iad", strategy: "direct",
      endpoints: { available: [{ provider: "Z.AI", selected: true }] }, attempt: 1 },
    reasoningTokens: 42,
    logprobs: payload.logprobs ? lp : null,
    headers, ms: 240, ttftMs: 180,
  });
}

const makeCtx = (rich) => ({
  chat: (payload) => mockResult(payload, rich),
  http: rich ? async (path) => ({ ok: true, status: 200,
      json: { data: { provider_name: "Z.AI", data_region: "global",
        native_finish_reason: "stop", native_tokens_prompt: 9,
        native_tokens_completion: 4, native_tokens_reasoning: 42,
        latency: 321, generation_time: 800 } } })
    : undefined,
  model: "mock/mock",
});

/* ---- run ---- */
let fails = 0, count = 0;
console.log(`selftest: ${REGISTRY.length} registry entries\n`);
for (const file of REGISTRY) {
  const expectedId = file.replace(/\.js$/, "");
  let mod;
  try { mod = await import(`./probes/${file}`); }
  catch (e) { console.log(`  FAIL ${file}: import error ${e.message}`); fails++; continue; }
  if (mod.meta?.id !== expectedId)
    { console.log(`  FAIL ${file}: meta.id "${mod.meta?.id}" != filename`); fails++; continue; }
  if (!GROUPS.has(mod.meta?.group))
    { console.log(`  FAIL ${file}: unknown group "${mod.meta?.group}"`); fails++; continue; }
  if (typeof mod.probe !== "function")
    { console.log(`  FAIL ${file}: no probe export`); fails++; continue; }

  const row = `  ${mod.meta.id.padEnd(20)}`;
  for (const mode of ["rich", "mini"]) {
    count++;
    try {
      const out = await mod.probe(makeCtx(mode === "rich"));
      if (out === undefined || out.value === undefined || String(out.value) === "")
        { console.log(`${row} FAIL (${mode}): empty value`); fails++; continue; }
      if (/^\s*probe-failed|CRASH/i.test(String(out.value)) && mode === "rich")
        { console.log(`${row} FAIL (${mode}): ${String(out.value).slice(0, 60)}`); fails++; continue; }
      console.log(`${row} ok (${mode}) ${String(out.value).slice(0, 58)}`);
    } catch (e) {
      console.log(`${row} CRASH (${mode}): ${e.message}`); fails++;
    }
  }
}
console.log(`\n${fails ? `${fails} FAILURES` : "all green"} across ${count} runs`);
process.exit(fails ? 1 : 0);
