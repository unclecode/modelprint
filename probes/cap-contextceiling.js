// name:        context ceiling
// description: bisect the maximum accepted prompt size; exact ceilings are
//              published per model and almost never collide across families
// author:      your-handle
// version:     1.0.0

export const meta = {
  id: "cap-contextceiling", name: "context ceiling", group: "capability",
  why: "1,048,576 vs 262,144 vs 131,072 — the ceiling dates the variant",
  long: false, author: "unclecode", version: "1.0.0",
};

// Filler-based bisection. The filler is calibrated against the endpoint's own
// usage.prompt_tokens, so the tokenizer under test measures itself. Ladders
// are coarse on purpose: we fingerprint the BUCKET, not the byte, because
// routers sometimes shave a little headroom off the advertised window.
const LADDER = [
  { t: 8000,   label: "≤8k"    },
  { t: 32000,  label: "≈32k"   },
  { t: 64000,  label: "≈64k"   },
  { t: 128000, label: "≈128k"  },
  { t: 196000, label: "≈200k"  },
  { t: 262000, label: "≈256k"  },
  { t: 520000, label: "≈512k"  },
  { t: 1048500, label: "≈1M"   },
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

  // 2. walk the ladder until an entry fails
  let okIdx = -1, errSnippet = "";
  for (let i = 0; i < LADDER.length; i++) {
    const n = Math.floor(LADDER[i].t / tpu);
    const r = await ctx.chat({
      messages: [{ role: "user", content: "Ignore this padding.\n" + UNIT.repeat(n) }],
      max_tokens: 1,
    });
    if (r.ok && r.usage?.prompt_tokens) { okIdx = i; continue; }
    errSnippet = String(r.error || "").slice(0, 160);
    break;
  }
  if (okIdx < 0) return { value: "probe-failed: rejected even 8k",
                          raw: { tpu, err: errSnippet } };
  if (okIdx === LADDER.length - 1)
    return { value: "≥1M (ladder-top)", raw: { tpu, errSnippet } };
  return { value: ">" + LADDER[okIdx].label.replace(/[≈≤]/g, "") +
                  " ≤" + LADDER[okIdx + 1].label.slice(1),
           raw: { tpu, failed_at: LADDER[okIdx + 1].t, errSnippet } };
}
