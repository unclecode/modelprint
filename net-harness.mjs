// Shared OpenRouter harness for the Node suites. Mirrors the browser
// adapter's telemetry (headers, timing, router metadata, logprobs,
// reasoning tokens, stream timeline) so every probe behaves identically
// in CI and in the page.
import { readFileSync } from "fs";

export function loadKey() {
  return process.env.OPENROUTER_API_KEY
    || (() => { try {
      return Object.fromEntries(readFileSync(process.env.HOME + "/devs/x-reach/.env", "utf8")
        .split("\n").filter(l => l.includes("=") && !l.startsWith("#"))
        .map(l => l.split("=", 2))).OPENROUTER_API_KEY;
    } catch { return ""; } })();
}

function pickHeaders(r) {
  const h = {};
  try { r.headers.forEach((v, k) => { h[k] = v; }); } catch {}
  return h;
}

function summarizeStream(timeline) {
  if (!timeline.length) return null;
  const gaps = [];
  for (let i = 1; i < timeline.length; i++)
    gaps.push(+(timeline[i].at - timeline[i - 1].at).toFixed(1));
  const med = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
  return { chunks: timeline.length, ttftMs: timeline[0].at,
    gapMedianMs: med(gaps), charsMedian: med(timeline.map(c => c.chars)),
    totalMs: timeline[timeline.length - 1].at };
}

function parseSse(buf) {
  let text = "", usage = null, finish = null, meta = null, id = null, model = null;
  for (const line of buf.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const data = s.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.openrouter_metadata) meta = j.openrouter_metadata;
    if (j.usage) usage = j.usage;
    if (j.id) id = j.id;
    if (j.model) model = j.model;
    const ch = (j.choices || [])[0] || {};
    if (typeof ch.delta?.content === "string") text += ch.delta.content;
    if (ch.finish_reason) finish = ch.native_finish_reason || ch.finish_reason;
  }
  if (!id && !text && !usage && !finish) return { ok: false };
  return { ok: true,
    usage: { prompt_tokens: usage?.prompt_tokens, completion_tokens: usage?.completion_tokens },
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    finish, text, id, reportedModel: model, systemFingerprint: undefined,
    metadata: meta, logprobs: null };
}

export async function chat(model, payload) {
  const t0 = performance.now();
  try {
    const headers = { "content-type": "application/json",
      Authorization: "Bearer " + loadKey(),
      "X-OpenRouter-Metadata": "enabled" };
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", headers, body: JSON.stringify({ model, ...payload }),
      signal: AbortSignal.timeout(60_000),
    });
    const ttftMs = performance.now() - t0;
    const hdrs = pickHeaders(r);

    if (payload.stream && r.ok && r.body) {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "", timeline = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const at = performance.now() - t0;
        const s = dec.decode(value, { stream: true });
        timeline.push({ at: +at.toFixed(1), chars: s.length });
        buf += s;
      }
      const total = performance.now() - t0;
      const out = parseSse(buf);
      if (!out.ok) return { ok: false, status: r.status, error: buf.slice(0, 2000),
        ms: total, ttftMs, headers: hdrs };
      return { ...out, status: r.status, ms: total, ttftMs, headers: hdrs,
        stream: summarizeStream(timeline) };
    }

    const text = await r.text();
    const ms = performance.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, error: text, ms, ttftMs, headers: hdrs };
    const d = JSON.parse(text);
    const choice = (d.choices || [])[0] || {};
    return { ok: true, status: r.status, ms, ttftMs, headers: hdrs,
      id: d.id, reportedModel: d.model, systemFingerprint: d.system_fingerprint,
      metadata: d.openrouter_metadata,
      usage: { prompt_tokens: d.usage?.prompt_tokens, completion_tokens: d.usage?.completion_tokens },
      reasoningTokens: d.usage?.completion_tokens_details?.reasoning_tokens
        ?? d.usage?.output_tokens_details?.reasoning_tokens ?? null,
      logprobs: choice.logprobs?.content?.[0]?.top_logprobs ?? choice.logprobs ?? null,
      finish: choice.native_finish_reason || choice.finish_reason,
      text: choice.message?.content || "" };
  } catch (e) { return { ok: false, status: 0, error: String(e) }; }
}

/* authenticated GET (generation records) */
export async function httpGet(pathOrUrl) {
  try {
    const url = /^https?:/.test(pathOrUrl)
      ? pathOrUrl : "https://openrouter.ai/api/v1" + pathOrUrl;
    const r = await fetch(url, { headers: { Authorization: "Bearer " + loadKey() },
      signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, text, json, headers: pickHeaders(r) };
  } catch (e) { return { ok: false, status: 0, text: String(e), json: null }; }
}
