// name:        cutoff dating
// description: binary-search the most recent event whose DATE the model can
//              recall; training data has a hard edge, weights do not lie
// author:      your-handle
// version:     1.0.0

export const meta = {
  id: "cap-cutoffdate", name: "cutoff dating", group: "capability",
  why: "a checkpoint's knowledge edge narrows the version window",
  long: false, author: "unclecode", version: "1.0.0",
};

// Each entry pins one verifiable public event to its quarter and a grading
// key. The model is asked for the DATE, not an opinion — date recall is
// what actually has a hard edge at the training boundary.
const EVENTS = [
  { q: "2022-Q4", ask: "In which month and year did OpenAI release ChatGPT? Answer with just the month and year.",
    keys: ["nov", "2022"] },
  { q: "2023-Q1", ask: "In which month and year did OpenAI release GPT-4? Answer with just the month and year.",
    keys: ["mar", "2023"] },
  { q: "2023-Q3", ask: "In which month and year did OpenAI release DALL-E 3? Answer with just the month and year.",
    keys: ["oct", "2023"] },
  { q: "2024-Q1", ask: "In which month and year did Anthropic release the Claude 3 family? Answer with just the month and year.",
    keys: ["mar", "2024"] },
  { q: "2024-Q2", ask: "In which month and year did OpenAI release GPT-4o? Answer with just the month and year.",
    keys: ["may", "2024"] },
  { q: "2024-Q4", ask: "In which month and year was the last US presidential election held? Answer with just the month and year.",
    keys: ["nov", "2024"] },
  { q: "2025-Q1", ask: "In which month and year did DeepSeek release its R1 model? Answer with just the month and year.",
    keys: ["jan", "2025"] },
  { q: "2025-Q2", ask: "In which month and year did OpenAI release GPT-4.1? Answer with just the month and year.",
    keys: ["apr", "2025"] },
];

function knows(text, keys) {
  const t = String(text || "").toLowerCase();
  return keys.every(k => t.includes(k));
}

export async function probe(ctx) {
  // Binary search over the bank: ~3 calls instead of 8. temperature 0 so
  // identical weights give identical answers; any match needs BOTH key parts
  // (month AND year) to count as known.
  let lo = -1, hi = EVENTS.length;          // knows up to lo; hi unknown
  const transcripts = [];
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await ctx.chat({
      messages: [{ role: "user", content: EVENTS[mid].ask }], max_tokens: 16,
      temperature: 0,
    });
    if (!r.ok) return { value: "probe-failed: " + r.status };
    const hit = knows(r.text, EVENTS[mid].keys);
    transcripts.push({ q: EVENTS[mid].q, answer: String(r.text).slice(0, 60), known: hit });
    if (hit) lo = mid; else hi = mid;
  }
  if (lo < 0) return { value: "pre-2023 (bank floor)", raw: transcripts };
  if (lo === EVENTS.length - 1)
    return { value: "≥" + EVENTS[lo].q + " (bank top)", raw: transcripts };
  // The edge sits between quarter lo (known) and lo+1 (unknown).
  return { value: `cutoff ≈ ${EVENTS[lo].q} … ${EVENTS[lo + 1].q}`,
           raw: transcripts };
}
