# Contributing to modelprint

The point of this project is a shared, growing kit of probes. One probe is one
small file, and a good probe is a real contribution to everyone who compares
models. Your name goes in [CONTRIBUTORS.md](CONTRIBUTORS.md) and on the page
itself, next to the probe you wrote.

## Write a probe

1. Copy [`probes/_template.js`](probes/_template.js).
2. Keep the header comment: name, description, author, version.
3. Export `meta` (the `id` must equal the file name) and an async `probe(ctx)`.
4. Return `{ value }`, and put anything else in `raw`.
5. Add your file to [`probes/index.js`](probes/index.js).
6. Run `node probe-check.mjs` before you open the pull request.

## The two rules that decide if a probe is accepted

**1. Security. A probe runs in a stranger's browser with their API key in
scope.**

Allowed: `ctx.chat(...)` and `ctx.http(...)`.
Not allowed: `fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `new Function`,
dynamic `import()`, `localStorage`, `document`, `navigator`, or any other way
to reach outside the lane. A probe that can talk to a second address is a key
leak waiting to happen, and it will not be merged.

**2. Determinism. The value is compared, so it must be stable.**

`value` must be the same for the same model on the same host, every run. It
must describe the MODEL, not the visitor and not the moment.

Put in `value`: token counts, error wording, limit numbers, provider name,
finish-reason vocabulary.
Never put in `value`: timings, latency bands, timestamps, random ids, request
ids, the visitor's location or region, anything that varies per call.

Those all belong in `raw`, where the JSON export keeps them for analysis.

Why this is strict: equal values mean "these two endpoints look like the same
family". A value that flips between runs shows a false difference. A value
with no model information in it shows a false match between unrelated models.
Both destroy the only thing this tool sells, which is trust in the table.

Also: a probe must never throw, and must keep `max_tokens` small. A huge
`max_tokens` is allowed only when it can produce an error and never billed
output.

## What happens to your pull request

It is accepted, or it is held with a written list of exact changes. It is
never rejected in silence. Both gates run first:

- `probe-check.mjs` runs free on every pull request through GitHub Actions.
- `probe-bench.mjs` runs against live models, by the maintainer, before merge.

## Ideas waiting for an author

- Streaming chunk pacing
- Stop-sequence limits
- System-role handling differences
- Tool-call format quirks
- Adversarial tokenizer strings

Open an issue if you want to claim one.
