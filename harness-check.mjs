import assert from "node:assert/strict";
import { addProviderHeaders, parseJsonResponse } from "./response-utils.mjs";

const json = parseJsonResponse('{"choices":[]}', "application/json; charset=utf-8");
assert.deepEqual(json, { ok: true, json: { choices: [] } });

const problem = parseJsonResponse('{"error":"bad request"}', "application/problem+json");
assert.equal(problem.ok, true);

const missingType = parseJsonResponse('{"choices":[]}', "");
assert.deepEqual(missingType, { ok: true, json: { choices: [] } });

const html = parseJsonResponse("<!doctype html>", "text/html; charset=utf-8");
assert.equal(html.ok, false);
assert.match(html.error, /non-json response/);

const invalid = parseJsonResponse("not json", "application/json");
assert.deepEqual(invalid, { ok: false, error: "invalid JSON response" });

// SSE is handled by the existing streaming parser, not the JSON path.
const sse = parseJsonResponse("data: {}\n\n", "text/event-stream");
assert.equal(sse.ok, false);

const provider = { sessionHeader: true };
const firstLane = {};
const firstHeaders = addProviderHeaders({}, firstLane, provider, () => "session-1");
const secondHeaders = addProviderHeaders({}, firstLane, provider, () => "session-2");
assert.equal(firstHeaders["x-opencode-session"], "session-1");
assert.equal(secondHeaders["x-opencode-session"], "session-1");

const secondLane = {};
const otherHeaders = addProviderHeaders({}, secondLane, provider, () => "session-2");
assert.equal(otherHeaders["x-opencode-session"], "session-2");

console.log("harness-check: all response cases passed");
