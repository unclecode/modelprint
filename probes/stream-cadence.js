// name:        stream cadence
// description: chunk pacing of a streamed completion — TTFT, inter-chunk gap
//              and chunk size cluster per serving stack (vLLM ≠ TGI ≠ first-party)
// author:      your-handle
// version:     1.0.0

export const meta = {
  id: "stream-cadence", name: "stream cadence", group: "timing",
  why: "the same model streams differently from different serving stacks",
  long: false, author: "unclecode", version: "1.0.0",
};

// Coarse buckets, never raw milliseconds: latency is noisy, but which BUCKET
// a stack lives in is stable. Two streamed calls; if the buckets disagree the
// lane is being load-balanced across stacks and we say so instead of guessing.
const PROMPT = "Count aloud: one two three four five six seven eight nine ten.";

function bucket(stream) {
  const ttft = stream.ttftMs < 300 ? "ttft<300ms"
    : stream.ttftMs < 800 ? "ttft<800ms" : "ttft≥800ms";
  const gap = stream.gapMedianMs <= 15 ? "gap≤15ms"
    : stream.gapMedianMs <= 40 ? "gap≤40ms" : "gap>40ms";
  const size = stream.charsMedian <= 4 ? "≤4ch/chunk"
    : stream.charsMedian <= 12 ? "≤12ch/chunk" : ">12ch/chunk";
  return `${ttft} · ${size} · ${gap}`;
}

export async function probe(ctx) {
  const calls = [];
  for (let i = 0; i < 2; i++) {
    const r = await ctx.chat({
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: 48, temperature: 0, stream: true,
    });
    if (!r.ok) return { value: "probe-failed: " + r.status };
    if (!r.stream) return { value: "harness-lacks-stream", raw: r.text?.slice?.(0, 80) };
    calls.push(r.stream);
  }
  const b1 = bucket(calls[0]), b2 = bucket(calls[1]);
  if (b1 !== b2)
    return { value: "unstable (mixed serving)", raw: calls };
  return { value: b1, raw: calls };
}
