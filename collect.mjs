#!/usr/bin/env node
/* The daily fingerprint run.
 *
 * For every tracked model+host it runs the probe set, compares the result with
 * the last recorded fingerprint, and writes a NEW VERSION ONLY IF A VALUE
 * CHANGED. When nothing changed it just extends the current version's
 * last_seen date. So the file for a model is its whole identity history, and
 * because these files live in git, the commit log IS the timeline.
 *
 *   node collect.mjs                 run every tracked model
 *   node collect.mjs --only glm      run only models whose id contains "glm"
 *   node collect.mjs --dry           run and print, write nothing
 *
 * This script never writes a reason for a change. It records what changed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { REGISTRY } from "./probes/index.js";
import { chat as rawChat, loadKey } from "./net-harness.mjs";

const KEY = loadKey();
if (!KEY) { console.error("no OPENROUTER_API_KEY"); process.exit(1); }

const TRACKED = JSON.parse(readFileSync("./fingerprints/tracked.json", "utf8"));
const DIR = "./fingerprints";
const TODAY = (process.env.RUN_DATE || new Date().toISOString().slice(0, 10));
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

/* Probes that cost real money on every run are not worth a daily bill. The
 * context ceiling ladder alone sends ~600k tokens per model. It runs weekly,
 * on Mondays, and keeps its previous value on other days. */
const WEEKLY = new Set(["cap-contextceiling"]);
const isWeeklyDay = new Date(TODAY).getUTCDay() === 1;

/* Some probe values describe WHERE THE CALLER IS, not what the model is.
 * net-region returns the router's region for the caller, so it reads "KUL"
 * from Kuala Lumpur and something else from a machine in the United States.
 * If the daily run ever moves to a different machine, every tracked model
 * would appear to change on the same day, and every one of those changes
 * would be false.
 *
 * These probes are still RECORDED, because the information is useful. They
 * are simply left out of the comparison that decides "did this change". */
const CALLER_DEPENDENT = new Set(["net-region"]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* A provider under load answers 429 or 503. That is not a fingerprint, so a
 * busy probe is retried, and if it stays busy its value is left OUT of the
 * comparison entirely rather than recorded as a change. */
const MODEL_BUDGET_MS = +(process.env.BUDGET_MS || 150_000);  // patience per model,
                                        // raise it with BUDGET_MS for a small retry run

function makeCtx(model, host, deadline) {
  const chat = async (payload) => {
    // Patience is a budget for the WHOLE model, not for each call. Giving
    // every call its own long retry let one rate-limited model spend over an
    // hour: 14 probes x 3 calls x 2 minutes. Now the model gets 2.5 minutes
    // in total, and whatever is unmeasured is recorded as unavailable.
    for (let i = 0; i < 4; i++) {
      if (Date.now() > deadline) return { ok: false, status: 429, error: "model budget spent" };
      const body = { ...payload };
      if (host) body.provider = { order: [host], allow_fallbacks: false };
      const r = await rawChat(model, body);
      if (r.ok || (r.status !== 429 && r.status !== 503 && r.status !== 0)) return r;
      await sleep(Math.min(8000, 2500 + i * 2500));
    }
    return { ok: false, status: 429, error: "busy after retries" };
  };
  const http = async (path) => {
    const r = await fetch("https://openrouter.ai/api/v1" + path,
      { headers: { Authorization: "Bearer " + KEY } });
    let json = null; try { json = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json };
  };
  return { chat, http, model, host };
}

/* A value is only a value if it MEASURES something. Everything else is a
 * diagnosis: the provider was busy, the pin did not hold, the run ran out of
 * time, the host hid the numbers. Storing a diagnosis as a value made the next
 * run report a change that was never in the model. */
const NOT_A_MEASUREMENT = [
  /^model busy/, /^model overloaded/, /^model timed out/, /^model too slow/,
  /^network error/, /^probe-failed/, /^key rejected/,
  /^unstable/,                 // the pin did not hold: two calls, two answers
  /^model budget spent/,       // our own time limit, not the model
  /^usage not reported/,       // the host answers but hides the token counts
  /^busy after retries/, /^harness-lacks/, /^probe budget/,
];
const isBusy = v => typeof v === "string" && NOT_A_MEASUREMENT.some(re => re.test(v));

async function fingerprint(model, host, probes) {
  const deadline = Date.now() + MODEL_BUDGET_MS;
  const ctx = makeCtx(model, host, deadline);
  const values = {}, unavailable = [];
  for (const { meta, probe } of probes) {
    if (WEEKLY.has(meta.id) && !isWeeklyDay) continue;
    if (Date.now() > deadline) { unavailable.push({ probe: meta.id, why: "time budget spent" }); continue; }
    let v;
    try { v = String((await probe(ctx)).value); }
    catch (e) { v = "probe-failed: " + String(e.message || e).slice(0, 40); }
    // A value we could not measure is NOT part of the fingerprint. Writing it
    // in would make a busy afternoon look like a model change tomorrow.
    // A value containing NaN or undefined is not a measurement. It must never
    // enter a record, or it compares as a change on the next run.
    if (/NaN|undefined/.test(v)) unavailable.push({ probe: meta.id, why: "value not computable" });
    else if (isBusy(v)) unavailable.push({ probe: meta.id, why: v });
    else values[meta.id] = v;
    await sleep(200);
  }
  return { values, unavailable };
}

/* Compare two fingerprints. Busy or failed values on either side are skipped,
 * so a bad afternoon never shows up as a model change. */
function diff(before, after) {
  const moved = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) continue;
    if (CALLER_DEPENDENT.has(k)) continue;
    if (isBusy(after[k]) || isBusy(before[k])) continue;
    if (before[k] !== after[k]) moved.push({ probe: k, from: before[k], to: after[k] });
  }
  return moved;
}

const slug = (model, host) =>
  (model + "__" + (host || "any")).replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();

async function main() {
  const probes = [];
  for (const f of REGISTRY) probes.push(await import("./probes/" + f));
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

  const targets = TRACKED.models.filter(m => !ONLY || m.model.includes(ONLY));
  console.log(`run date ${TODAY} · ${targets.length} targets · ${probes.length} probes`
    + (isWeeklyDay ? " (weekly probes included)" : ""));

  let changed = 0, created = 0, steady = 0;
  /* Every model is locked to its own provider, and the rate limit lives at the
   * provider, not at the account. So all models can run side by side, and the
   * whole run takes as long as the single slowest model instead of the sum. */
  const LANES = +(process.env.LANES || 21);
  const queue = targets.slice();
  await Promise.all(Array.from({ length: LANES }, async () => {
    while (queue.length) { const t = queue.shift(); await one(t); }
  }));

  async function one(t) {
    const file = `${DIR}/${slug(t.model, t.host)}.json`;
    const rec = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))
      : { model: t.model, host: t.host || null, first_tracked: TODAY, versions: [] };

    const { values, unavailable } = await fingerprint(t.model, t.host, probes);
    if (Object.keys(values).length === 0) {
      console.log(`  ${t.model} · ${t.host || "any"} — every probe was busy, nothing recorded`);
      return;
    }
    const note = unavailable.length ? ` (${unavailable.length} unavailable)` : "";

    const cur = rec.versions[rec.versions.length - 1];
    if (!cur) {
      rec.versions.push({ v: 1, first_seen: TODAY, last_seen: TODAY,
        probe_set: readFileSync("./VERSION", "utf8").trim(),
        values, unavailable, moved: [] });
      created++;
      console.log(`  ${t.model} · ${t.host || "any"} — v1 recorded${note}`);
    } else {
      const moved = diff(cur.values, values);
      if (moved.length === 0) {
        cur.last_seen = TODAY;
        // fill in any value that was missing before and could be read today
        for (const [k, v] of Object.entries(values)) if (!(k in cur.values)) cur.values[k] = v;
        steady++;
      } else {
        rec.versions.push({ v: cur.v + 1, first_seen: TODAY, last_seen: TODAY,
          probe_set: readFileSync("./VERSION", "utf8").trim(),
          values: { ...cur.values, ...values }, unavailable, moved });
        changed++;
        console.log(`  ${t.model} · ${t.host || "any"} — v${cur.v + 1}, ${moved.length} moved: `
          + moved.map(m => `${m.probe} ${m.from} -> ${m.to}`).join(", "));
      }
    }
    if (!DRY) writeFileSync(file, JSON.stringify(rec, null, 1) + "\n");
  }

  console.log(`\n${created} new · ${changed} changed · ${steady} unchanged`);
  if (!DRY) buildIndex();
}

/* One small file the page reads first, so it does not fetch 41 files to draw
 * the grid. */
export function buildIndex() {
  const rows = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json") || f === "tracked.json" || f === "index.json") continue;
    const r = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
    rows.push({
      file: f, model: r.model, host: r.host,
      first_tracked: r.first_tracked,
      versions: r.versions.map(v => ({ v: v.v, first_seen: v.first_seen,
        last_seen: v.last_seen, moved: v.moved.length })),
    });
  }
  rows.sort((a, b) => {
    const la = a.versions[a.versions.length - 1].first_seen;
    const lb = b.versions[b.versions.length - 1].first_seen;
    return lb.localeCompare(la);
  });
  writeFileSync(`${DIR}/index.json`, JSON.stringify({
    window_start: TRACKED.window_start, generated: TODAY, models: rows,
  }, null, 1) + "\n");
  console.log(`index.json written · ${rows.length} model+host pairs`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
