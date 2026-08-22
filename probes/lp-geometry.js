// name:        logprob geometry
// description: the normalized 3rd top-logprob gap on pinned continuations.
//              EVT predicts δ≈0.318 for Gumbel-class models; deviations and
//              gap vectors are model-specific (fallrisk.ai protocol)
// author:      ItIsCuthNotCup
// version:     1.0.0

export const meta = {
  id: "lp-geometry", name: "logprob geometry", group: "logits",
  why: "δ_norm ≈ 0.32 is universal; the residual spread is a personal signature",
  long: false, author: "ItIsCuthNotCup", version: "1.0.0",
};

// Pinned one-token continuations. For each position with k>=5 candidates:
//   gaps G_k = lp[k]-lp[k+1];  δ_norm = G3/(G2+G3+G4)
// Averaged over prompts, rounded to 2dp — coarse enough to survive serving
// noise, fine enough to separate quantized clones from full weights.
const PROMPTS = [
  "The capital city of France is",
  "Water boils at one hundred degrees",
  "One two three four five",
];

export async function probe(ctx) {
  const deltas = [];
  let minK = Infinity;
  for (const p of PROMPTS) {
    const r = await ctx.chat({
      messages: [{ role: "user", content: p }],
      max_tokens: 1, temperature: 0,
      logprobs: true, top_logprobs: 10,
    });
    if (!r.ok) {
      if (/logprob/i.test(String(r.error || "")))
        return { value: "logprobs-unsupported", raw: { error: String(r.error).slice(0, 300) } };
      return { value: "probe-failed: " + r.status };
    }
    const tops = r.logprobs;
    if (!Array.isArray(tops) || tops.length < 5)
      return { value: "logprobs-unsupported", raw: { got: tops ? "short" : "null" } };
    minK = Math.min(minK, tops.length);
    const lp = tops.map(x => x.logprob);
    const g = i => lp[i] - lp[i + 1];
    const denom = g(1) + g(2) + g(3);
    if (denom > 1e-9) deltas.push(g(2) / denom);
  }
  if (!deltas.length) return { value: "degenerate-distribution" };
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const spread = Math.max(...deltas) - Math.min(...deltas);
  return { value: `δ=${avg.toFixed(2)} · span=${spread.toFixed(2)} · k=${minK === Infinity ? "?" : minK}`,
           raw: { deltas } };
}
