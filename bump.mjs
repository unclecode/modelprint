#!/usr/bin/env node
/* Single source of truth for the version.
 *
 * The version used to live only inside index.html, twice: the header badge and
 * the cache-busting query on the engine script. Changing one and forgetting the
 * other shipped a page that lied about itself. Now VERSION is the truth and this
 * script stamps the page from it.
 *
 *   node bump.mjs            stamp index.html from VERSION
 *   node bump.mjs 0.8.0      write VERSION, then stamp
 */
import { readFileSync, writeFileSync } from "fs";

const arg = process.argv[2];
if (arg) {
  if (!/^\d+\.\d+\.\d+$/.test(arg)) {
    console.error("version must look like 0.8.0");
    process.exit(1);
  }
  writeFileSync("VERSION", arg + "\n");
}
const v = readFileSync("VERSION", "utf8").trim();

let html = readFileSync("index.html", "utf8");
const before = html;
html = html.replace(/<span class="ver mono">v[\d.]+<\/span>/,
                    `<span class="ver mono">v${v}</span>`);
html = html.replace(/engine\.js\?v=[\d.]+/g, `engine.js?v=${v}`);

const esc = v.replace(/\./g, "\\.");
const okBadge = new RegExp(`<span class="ver mono">v${esc}</span>`).test(html);
const okScript = new RegExp(`engine\\.js\\?v=${esc}`).test(html);
if (!okBadge || !okScript) {
  console.error(`stamp failed: badge=${okBadge} script=${okScript}; index.html markup changed?`);
  process.exit(1);
}
if (html !== before) writeFileSync("index.html", html);
console.log(`v${v} stamped in index.html: header badge + engine cache-bust`);
