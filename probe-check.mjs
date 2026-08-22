#!/usr/bin/env node
/* probe-check: the free CI gate. No API key, runs in a second.
 *
 * Two gates every probe must pass before a human even looks at behavior:
 *   1. CONTRACT  — id equals filename, valid group, exports meta + probe,
 *                  runs against a mock without throwing, returns a value.
 *   2. SAFETY    — the source file uses no dangerous capability. A probe is a
 *                  stranger's code that receives the user's API key, so it may
 *                  reach the network ONLY through ctx.chat / ctx.http and must
 *                  not touch raw fetch, eval, node builtins, or the DOM.
 *
 * Exit non-zero on any failure, so a GitHub Action fails the PR.
 */
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, basename } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBES = join(HERE, "probes");
const GROUPS = new Set(["tokenizer", "errors", "shape", "network", "capability",
  "leak", "reasoning", "logits", "timing", "behavior"]);

// Patterns forbidden in a probe's source. Each is a real exfiltration or
// escape route. ctx.chat / ctx.http are the only sanctioned network paths.
const FORBIDDEN = [
  [/\bfetch\s*\(/, "raw fetch() — use ctx.chat or ctx.http"],
  [/\beval\s*\(/, "eval()"],
  [/new\s+Function\s*\(/, "new Function()"],
  [/\bFunction\s*\(/, "Function() constructor"],
  [/\brequire\s*\(/, "require()"],
  [/\bimport\s*\(/, "dynamic import()"],
  [/\bprocess\b/, "process (no env or filesystem)"],
  [/\bglobalThis\b/, "globalThis"],
  [/\bwindow\b/, "window"],
  [/\bdocument\b/, "document"],
  [/\blocalStorage\b/, "localStorage"],
  [/\bsessionStorage\b/, "sessionStorage"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bnavigator\b/, "navigator"],
  [/\bchild_process\b/, "child_process"],
  [/\bimport\s+.*\s+from\s+["'](?!\.\/)[^"']+["']/, "import from outside ./ (siblings only)"],
];

const files = readdirSync(PROBES).filter(f => f.endsWith(".js") && f !== "index.js" && !f.startsWith("_"));
let failures = 0;
const rows = [];

for (const file of files) {
  const id = basename(file, ".js");
  const problems = [];

  // ---- SAFETY: scan source ----
  const src = readFileSync(join(PROBES, file), "utf8");
  // Strip comments AND string/template literals before scanning, so a word
  // like "window" inside a description or a prompt is not a false positive.
  // Only real code tokens should trigger a safety flag.
  const code = src
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  for (const [re, why] of FORBIDDEN) {
    if (re.test(code)) problems.push(`unsafe: ${why}`);
  }

  // ---- CONTRACT: import + shape ----
  let mod;
  try {
    mod = await import(join(PROBES, file));
  } catch (e) { problems.push(`import failed: ${e.message}`); }
  if (mod) {
    const m = mod.meta;
    if (!m) problems.push("no meta export");
    else {
      if (m.id !== id) problems.push(`meta.id "${m.id}" != filename "${id}"`);
      if (!GROUPS.has(m.group)) problems.push(`unknown group "${m.group}"`);
      for (const field of ["name", "why", "author", "version"])
        if (!m[field]) problems.push(`meta.${field} missing`);
    }
    if (typeof mod.probe !== "function") problems.push("no probe() function");

    // ---- CONTRACT: runs against a mock without throwing ----
    if (typeof mod.probe === "function") {
      const mockCtx = {
        model: "mock/model",
        chat: async () => ({ ok: true, status: 200, text: "ok",
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          finish: "stop", headers: {}, ms: 100, id: "gen-x",
          reportedModel: "mock/model", logprobs: [], chunks: [] }),
        http: async () => ({ ok: true, status: 200, text: "{}", json: {} }),
      };
      try {
        const out = await mod.probe(mockCtx);
        if (out == null || out.value === undefined) problems.push("probe returned no value");
      } catch (e) { problems.push(`probe threw on mock: ${e.message}`); }
    }
  }

  if (problems.length) { failures++; rows.push([id, "FAIL", problems.join("; ")]); }
  else rows.push([id, "ok", ""]);
}

for (const [id, status, detail] of rows)
  console.log(`  ${status === "ok" ? "ok  " : "FAIL"} ${id.padEnd(22)} ${detail}`);
console.log(`\n  ${files.length} probes, ${failures} failed`);
process.exit(failures ? 1 : 0);
