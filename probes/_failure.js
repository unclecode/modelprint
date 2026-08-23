// name:        failure helper (shared, not a probe)
// description: turns a failed call into a message a human can act on,
//              and separates "the model is busy" from "the probe is wrong"
// author:      unclecode
// version:     1.0.0

// A provider under heavy load answers in ways that are NOT probe failures:
// 429 means it is rate limiting, 503/502/504 mean it is overloaded or the
// gateway gave up, and status 0 is our own timeout waiting for it. Naming
// these plainly stops a reader from thinking the probe is broken when the
// model is simply busy. The mystery-model week is exactly this case.
export function describeFailure(res) {
  const s = res?.status ?? 0;
  const body = String(res?.error || "");
  if (s === 429) return "model busy (rate limited)";
  if (s === 503 || s === 502 || s === 504) return "model overloaded (" + s + ")";
  if (s === 408) return "model timed out";
  if (s === 0) {
    if (/timeout|abort/i.test(body)) return "model too slow (no answer in time)";
    return "network error (no answer)";
  }
  if (s === 401 || s === 403) return "key rejected (" + s + ")";
  if (/overload|capacity|busy|try again/i.test(body)) return "model overloaded";
  return "probe-failed: " + s;
}

// True when a value came from the provider being busy rather than from the
// model's own behaviour. The page uses this to keep such cells OUT of the
// comparison, because "busy" is not a fingerprint.
export function isBusy(value) {
  return typeof value === "string" &&
    /^(model busy|model overloaded|model timed out|model too slow|network error)/.test(value);
}
