# Changelog

All notable changes to modelprint. Newest first.
Versions follow [semantic versioning](https://semver.org): the middle number
moves when the tool gains something, the last when it only fixes things.

## [0.7.3] - 2026-08-23

### Fixed
- A failed probe printed the first status number it could find, so a probe
  whose first call succeeded and whose second timed out reported
  `probe-failed: 200`. Failures now name the call that actually failed.
- Failure text is now written for a human: `model busy (rate limited)`,
  `model overloaded (503)`, `model too slow (no answer in time)`,
  `key rejected (401)`.

### Added
- A busy provider is no longer treated as evidence. Cells that failed because
  the model was overloaded are marked, left out of the match colouring, and
  removed from both sides of the verdict score. The card says how many probes
  were skipped. Before this, two unrelated models that were both busy counted
  as a match.
- A running lane reports a long wait every 3 seconds: `waiting 33s, this model
  is busy`. A lane stuck on one slow call used to look frozen.
- `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and a `VERSION` file with
  `bump.mjs` so the page can no longer disagree with the release.

## [0.7.2] - 2026-08-23

### Added
- `net-pathsplit` by [@pjperez](https://github.com/pjperez) (#3): measures the
  network distance to the real upstream provider behind a router, using two
  deliberately rejected calls so neither reaches a GPU. Timing and edge
  location stay out of the compared value, so the probe cannot create a false
  match or publish a visitor's location.
- `CONTRIBUTORS.md`, and credit for contributors in the README.

### Fixed
- `net-genrecord` by [@pjperez](https://github.com/pjperez) (#2): the probe
  could never return a record. It asked for a path that repeated `/api/v1`,
  and it did not wait for the router's ledger, which is written a few seconds
  after the call. It now returns real records, for example
  `DeepInfra · global · stop`, exits early on endpoints that have no ledger,
  and has a time limit.

## [0.7.1] - 2026-08-22

### Added
- Live presence: the page sends a heartbeat with `sendBeacon` every 45 seconds
  while visible, and the backend reports how many people are on the site now.
- All-time counters for runs and visits.

## [0.7.0] - 2026-08-22

### Added
- **Free credits.** Visitors with no key run on the project's key, for models
  priced under $1.50 per million input tokens. Limits are counted in real
  money from the provider's own per-call cost: $0.05 per visitor per day,
  $3.00 for everyone per day.
- Honest limits everywhere: a banner, a lane note, and a run message when
  credits are gone, plus a one-time note after a first free run explaining
  that a free key removes all limits.
- Star Repository button, and a Share button on the verdict cards.

### Fixed
- The page never declared its text encoding, so some browsers printed broken
  characters. The spinner now turns on its own centre.

## [0.6.0] - 2026-08-22

### Added
- Short share links: the result is stored under a six-character id, derived
  from the content, so the same result always gets the same link.
- Anonymous usage counters, and a dashboard fed by them.
- The share window opens at once with a loading state, and sharing before a
  run is blocked.

## [0.5.0] - 2026-08-21

### Added
- Probe opt-in: a checkbox per probe and per section.
- Shareable results, compressed into the link.
- The probe test system: a free check on every pull request, and a live bench
  for the maintainer.
- Ten community probes from [@ItIsCuthNotCup](https://github.com/ItIsCuthNotCup)
  (#1), five accepted, five held with a written list of changes.

### Security
- `ctx.http` locked to the lane's own origin, so a probe cannot send a
  visitor's key anywhere else.

## [0.3.0] - 2026-08-21

### Added
- Xiaomi MiMo as a provider. Its official API settled the last open question
  of the Ox Alpha day: MiMo matched the mystery model on 2 of 4 tokenizer
  probes, and the emoji probe missed by 33 tokens.

## [0.1.0] - 2026-08-21

First release, built and published the same day the stealth model "Ox Alpha"
appeared. Nine infrastructure probes, side-by-side lanes, verdict cards.
Fourteen models tested: only the GLM family matched on all four tokenizer
probes.
