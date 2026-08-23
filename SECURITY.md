# Security policy

modelprint runs in your browser and asks you for API keys. Those keys are the
thing this project must protect. This page says what we guarantee, what we do
not, and how to report a problem privately.

## What the tool guarantees

- **Your key stays in your tab.** It is held in memory and in your own
  browser's local storage. It is never sent to any server of ours.
- **Calls go straight from your browser to the provider you chose.** There is
  no middleman for a keyed lane.
- **A probe cannot reach another address.** Probes are community code, so the
  harness gives them two calls only: one to the model, and one to the same
  origin as the lane. Any attempt to call a different host fails.
- **The free-credits path never sees your key.** It exists exactly for people
  who have none: the request goes to our small server, which adds the
  project's own key. If you paste your key, that path is not used at all.

## What the tool does NOT guarantee

- We cannot vouch for the providers you point the tool at.
- A probe you install yourself, outside a reviewed pull request, is your own
  responsibility.
- Shared result links contain the values your run produced. Read them before
  you share if you probed a private endpoint.

## Reporting a problem

**Please do not open a public issue for a security problem.**

Report it privately in either of these ways:

1. GitHub private reporting: the **Security** tab of this repository, then
   "Report a vulnerability". This is the preferred route.
2. Direct message [@unclecode](https://x.com/unclecode) on X.

Please include what you found, the steps to reproduce it, and what an
attacker could do with it. You will get a first answer within 72 hours.

If the problem lets a probe read or send a visitor's key, say so in the first
line. That case is treated as urgent and fixed before anything else.

## What we ask of contributors

Every probe passes two gates before it merges:

1. **Security.** No direct network access, no browser storage, no dynamic
   code. Only `ctx.chat` and `ctx.http`.
2. **Determinism.** The same model must give the same value twice. A value
   that changes between runs creates false matches in the comparison table.

A probe that fails either gate is held with a written list of changes, never
merged quietly.
