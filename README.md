# modelprint

One page that answers one question: **who is really behind that API?**

Run infrastructure probes against any OpenAI-compatible endpoint and compare
the fingerprints, side by side. Plumbing does not lie; personality does.

**Try it: [unclecode.github.io/modelprint](https://unclecode.github.io/modelprint/)**
No install, no build, no server. Your API keys stay in your browser tab; every
call goes from your browser straight to the provider.

## Why I built this

On 21 August 2026 a stealth model called Ox Alpha appeared on OpenRouter and
the whole timeline turned into a detective game. The best evidence was not in
anyone's hot take. It was scattered across replies: one person compared token
counts, one person read error codes, one person sent temperature 2.0 and let
the upstream error speak. Each trick lived and died in a single reply.

I collected them into one tool. And the same tricks matter far beyond stealth
models: two days earlier I showed that DeepSeek's API silently serves a
different model under the old `deepseek-chat` name. Providers move models
behind aliases and nothing tells you. This page is how you check.

## What it found on day one

The full suspect lineup, 12 models, 9 probes each, one command:

```
mystery model (stealth/ox-alpha) against the crowd's guesses:

 6/9  tokenizer 4/4   z-ai/glm-5.3
 5/9  tokenizer 4/4   z-ai/glm-4.7-flash
 2/9  tokenizer 2/4   openai/gpt-5.6-luna
 2/9  tokenizer 1/4   qwen/qwen3.7-flash
 2/9  tokenizer 0/4   kimi-k3, deepseek-v4-flash, minimax-m3
 1/9  tokenizer 0/4   google/gemini-3.7-flash
 0/9  tokenizer 0/4   x-ai/grok-4.6, claude-opus-5
```

Only the GLM family matches all four normalized tokenizer counts. Every other
lab's best is 2 of 4.

## The probes

| probe | what it reads | why it identifies a lab |
| --- | --- | --- |
| english pangram | `usage.prompt_tokens` for a pinned text | tokenizers are built per lab |
| chinese paragraph | same, CJK text | CJK segmentation differs most |
| code snippet | same, source code | indentation and symbol handling |
| emoji + rare unicode | same, hard codepoints | byte-fallback behaviour |
| template offset | tokens added around an empty prompt | the serving template's size |
| temperature: 2.0 | the validation prose, verbatim | written by the lab's engineers |
| max_tokens: 10^9 | the refusal message | it names the real output limit |
| error code family | numeric vs string vs typed errors | GLM's 1301 code gave Ox away |
| finish vocabulary | `finish_reason` values | vocabularies differ per lab |

### Community batch: network forensics + capability + deep signals

| probe | what it reads | why it identifies a lab |
| --- | --- | --- |
| router region | the router's opt-in metadata snapshot (region, provider, strategy) | the routing layer names who answered — a "Stealth" lane served by Z.AI ends one argument |
| generation record | OpenRouter's `/generation` ledger for one call id | provider name, data region and NATIVE token counts, straight from the router's books |
| header dna | response header families (`cf-ray`, `x-amzn-requestid`, `openai-processing-ms`…) and the response-id prefix | serving stacks expose different headers; Bedrock ≠ Vertex ≠ first-party |
| path split | latency difference between a router-rejected call (`frequency_penalty: 9`) and one the real provider rejects, bucketed | both calls are refused, so no GPU and no queueing is measured — the difference is the router→PROVIDER round trip, and your own leg cancels out of the subtraction |
| context ceiling | bisected maximum accepted prompt size | 1,048,576 vs 262,144 vs 131,072 — exact ceilings date the variant |
| cutoff dating | binary-searched recall of pinned event dates | training data has a hard edge; weights do not lie |
| wrapper leak | extracted hidden system prompt (length + hash) | routers and labs inject wrappers; their wording unmasks the host |
| reasoning trace | invalid-`reasoning_effort` prose + thinking-token overhead on a fixed puzzle | labs validate parameters in their own words and budget thinking differently |
| logprob geometry | normalized 3rd top-logprob gap δ on pinned continuations | EVT predicts δ≈0.32 universally; deviations flag quantized or substituted weights |
| stream cadence | bucketed TTFT / chunk gap / chunk size of a streamed reply | vLLM, TGI and first-party stacks pace chunks differently |
| one-token battery | modal answer to "random number / color / coin" cells | per arXiv:2607.10252 these biases are model-deep and stable across providers |

Telemetry probes degrade honestly when a harness lacks the signal
(`harness-lacks-http`, `headers-hidden-by-cors`, `logprobs-unsupported`) —
an honest absence beats a fake fingerprint.

Tokenizer counts are **normalized against a one-character baseline**, so a
host's hidden template cancels out. Two hosts wrapping the same tokenizer
match; raw counts never would. Every tokenizer probe also runs twice and
reports `unstable` when a router spreads calls across different hosts,
instead of reporting noise as a fingerprint.

**Why no censorship or personality probes:** the community ran both on Ox
Alpha and reached opposite verdicts on the same day. Behaviour bends to a
system prompt. Tokenizers and error handlers do not.

## Write your own probe

Every probe is one file in [`probes/`](probes/) with the same contract:

```js
// name:        your probe name
// description: what it measures and why it identifies a lab
// author:      your-handle
// version:     1.0.0

export const meta = { id: "...", name: "...", group: "tokenizer|errors|shape",
                      why: "...", long: false, author: "...", version: "1.0.0" };

export async function probe(ctx) {
  const res = await ctx.chat({ messages: [...], max_tokens: 8 });
  return { value: res.usage.prompt_tokens };   // the comparable fingerprint
}
```

Copy [`probes/_template.js`](probes/_template.js), keep the rules in its
header (deterministic value, never throw, no timestamps), open a pull
request. Approved probes are one line in [`probes/index.js`](probes/index.js).

## Honest limits

- Through a router, some answers are the router's, not the lab's. The tool
  detects and labels these ("router-reported", "router-validated") and reads
  the upstream error body whenever the router passes it through.
- A pinned host removes routing noise; the page fetches each model's real
  host list and offers pinning for OpenRouter lanes.
- Matching fingerprints prove shared infrastructure, not identity. A lab can
  serve two different models on the same stack. Read the tokenizer rows as
  strong evidence about the family, not a signed confession.

## Run the test suites yourself

```
node selftest.mjs    # no key needed: every probe against a mock harness
node smoke.mjs       # every probe against two real models, prints values
node suspects.mjs    # the full 12-model lineup, prints the ranking
```

`selftest.mjs` runs everywhere; the other two need an OpenRouter key in the
environment they read.

---

Built by [@unclecode](https://x.com/unclecode), author of
[Crawl4AI](https://github.com/unclecode/crawl4ai)
![GitHub stars](https://img.shields.io/github/stars/unclecode/crawl4ai)

If this is useful, follow [@unclecode on X](https://x.com/unclecode) for the
next tool. MIT license: use it, change it, no need to ask.
