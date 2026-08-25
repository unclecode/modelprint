---
name: release
description: Ship a modelprint release the same way every time - gates, version stamp, changelog, tag, GitHub release, deploy, verify. Use when the user says "release", "ship it", "deploy", "cut a version", or after merging pull requests that should reach the public page.
---

# Release modelprint

One command, one order, no step skipped. The public page and the GitHub
release must always agree, and a release must never carry an untested probe.

Repo: `/Users/unclecode/devs/modelprint`. The page is GitHub Pages from
`main`. The backend is a Cloudflare Worker in `worker/`, released separately.

## Before you start

Ask the user which kind of release this is, unless they already said:

- **patch** (0.7.3 to 0.7.4): only fixes.
- **minor** (0.7.3 to 0.8.0): anything new. New probes are minor, always.
- **major**: reserved for a break in the probe contract.

Never guess the number. Read `VERSION` for the current one.

## The order. Do not reorder.

### 1. Clean state

```bash
cd /Users/unclecode/devs/modelprint
git checkout main && git pull -q origin main
git status --short          # must be empty of surprises
```

If uncommitted work exists, STOP and ask. Committing someone's half-finished
work into a release is worse than a delayed release.

### 2. Both gates

```bash
node probe-check.mjs        # free, must end "0 failed"
node probe-bench.mjs        # live, costs money, read the HEALTH block
```

`probe-check` failing stops the release. In `probe-bench`, read:
- `crashed:` must be `none`
- `unstable (fluctuate on same model):` must be `none`

A probe that fluctuates creates false differences in the table. That is a
release blocker, not a note.

### 3. Stamp the version

```bash
node bump.mjs 0.8.0         # writes VERSION and stamps index.html
```

The script fails loudly if it cannot stamp both places. Never edit the
version by hand.

### 4. Write the changelog entry

Add a section at the top of `CHANGELOG.md`, under the header:

```
## [0.8.0] - YYYY-MM-DD

### Added
- What a user can now do, in plain words. Real numbers.

### Fixed
- What was wrong, and what it did to the user. Not the file name.

### Security
- Only when a real security property changed.
```

Rules for the text:
- Write for a reader who does not know the code. Say the effect, not the file.
- Credit every contributor by handle and pull request number:
  `by [@name](https://github.com/name) (#3)`.
- Use real numbers. "Waited up to 25 seconds" beats "was slow".
- No jargon, short sentences.

### 5. Commit, tag, push

```bash
git add -A
git commit -m "release 0.8.0

<the changelog entry body, plain text>"
git tag -a v0.8.0 -m "0.8.0"
git push origin main
git push origin v0.8.0
```

The tag is annotated (`-a`), never lightweight.

### 6. GitHub release

```bash
gh release create v0.8.0 \
  --title "0.8.0 - <three or four words>" \
  --notes "<the changelog entry, markdown>"
```

Add `--latest`. The notes are the same words as the changelog, so a reader
never sees two versions of the truth.

### 7. Verify the deploy, do not assume it

GitHub Pages takes about a minute. Poll until the live page reports the new
version, then confirm the engine really changed:

```bash
for i in $(seq 1 12); do
  LIVE=$(curl -s https://modelprint.ai/index.html | grep -o 'v0\.[0-9.]*' | head -1)
  [ "$LIVE" = "v0.8.0" ] && break
  sleep 10
done
echo "live: $LIVE"
curl -s "https://modelprint.ai/probes/index.js" | grep -c '\.js"'
```

If the live version does not match after two minutes, say so plainly. Do not
report a release as done on hope.

### 8. Worker, only if `worker/` changed

```bash
cd worker && npx wrangler deploy
curl -s https://modelprint-api.unclecode.workers.dev/proxy/status
```

The worker version is not the page version. Say which one you deployed.

### 9. Tell the user

Report, short:
- version and tag
- what a user gets, in one or two sentences
- contributors credited, by name
- the live page confirmed at the new version
- whether the worker was deployed too

## Rules that do not bend

- **Never release with a failing or unstable gate.** The whole product is
  trust in the comparison table.
- **Never hand-edit the version.** Use `bump.mjs`.
- **Never write release notes that differ from the changelog.**
- **Always credit contributors**, in the changelog, in `CONTRIBUTORS.md`, and
  in the release notes.
- **Never claim the deploy worked without checking the live URL.**
- If a community probe is in this release, confirm both gates named in
  `CONTRIBUTING.md` passed for it: security (no direct network access) and
  determinism (same model, same value).

## After the release

If the release is worth telling people about, say so, but do not post
anything. Posting is the user's decision and needs his exact words.
