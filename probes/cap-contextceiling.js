// name:        context ceiling
// description: bisect the accepted prompt-size bucket; window classes help
//              distinguish model variants without probing all the way to 1M
// author:      ItIsCuthNotCup
// version:     1.0.0

export const meta = {
  id: "cap-contextceiling", name: "context ceiling", group: "capability",
  why: "64k, 128k, 200k and 256k+ window classes help date the variant",
  long: false, author: "ItIsCuthNotCup", version: "1.0.0",
};

// Filler-based bisection. The filler is calibrated against the endpoint's own
// usage.prompt_tokens, so the tokenizer under test measures itself. Ladders
// are coarse on purpose: we fingerprint the BUCKET, not the byte, because
// routers sometimes shave a little headroom off the advertised window.
// Ladder capped at 256k on purpose. Filling all the way to 1M cost ~2.2M
// tokens per run, the single most expensive probe in the set. The useful
// discrimination between variants lives in the 64k-256k buckets; anything
// beyond reports ">=256k" and, where the provider exposes it, err-maxtokens
// already names the real limit for free.
const LADDER = [
  { t: 8000,   label: "8k"   },
  { t: 32000,  label: "32k"  },
  { t: 64000,  label: "64k"  },
  { t: 128000, label: "128k" },
  { t: 196000, label: "200k" },
  { t: 262000, label: "256k" },
];
const UNIT = "a ";                       // cheapest possible padding unit

export async function probe(ctx) {
  // 1. calibrate: how many tokens does one UNIT cost on THIS endpoint?
  const base = await ctx.chat({ messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
  const cal  = await ctx.chat({
    messages: [{ role: "user", content: "hi\n" + UNIT.repeat(200) }], max_tokens: 1 });
  if (!base.ok || !cal.ok || !base.usage?.prompt_tokens || !cal.usage?.prompt_tokens)
    return { value: "probe-failed: " + (base.status || cal.status) };
  const tpu = Math.max(0.05, (cal.usage.prompt_tokens - base.usage.prompt_tokens) / 200);

  const accepts = async (rung) => {
    const n = Math.floor(LADDER[rung].t / tpu);
    const r = await ctx.chat({
      messages: [{ role: "user", content: "Ignore this padding.\n" + UNIT.repeat(n) }],
      max_tokens: 1,
    });
    return r.ok && r.usage?.prompt_tokens ? true : String(r.error || "").slice(0, 160);
  };

  // 2. BINARY SEARCH the ladder for the highest accepted rung. ~3 calls
  //    instead of walking all six, and it never sends a rung it can skip.
  let lo = 0, hi = LADDER.length - 1, okIdx = -1, errSnippet = "";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const res = await accepts(mid);
    if (res === true) { okIdx = mid; lo = mid + 1; }
    else { errSnippet = res; hi = mid - 1; }
  }
  if (okIdx < 0) return { value: "probe-failed: rejected even 8k", raw: { tpu, err: errSnippet } };
  if (okIdx === LADDER.length - 1)
    return { value: "≥256k (ladder-top)", raw: { tpu, errSnippet } };
  return { value: ">" + LADDER[okIdx].label + " ≤" + LADDER[okIdx + 1].label,
           raw: { tpu, failed_at: LADDER[okIdx + 1].t, errSnippet } };
}
