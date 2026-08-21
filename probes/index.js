// The approved probe set, in table order. A community probe joins this list
// only after review; the page loads exactly these files, nothing else.
export const REGISTRY = [
  "tok-english.js",
  "tok-chinese.js",
  "tok-code.js",
  "tok-emoji.js",
  "template-offset.js",
  "err-temperature.js",
  "err-maxtokens.js",
  "err-code-family.js",
  "finish-vocab.js",
  // community batch, Aug 2026: network forensics + capability + deep signals
  "net-region.js",
  "net-genrecord.js",
  "net-headerdna.js",
  "cap-contextceiling.js",
  "cap-cutoffdate.js",
  "leak-wrapper.js",
  "reason-trace.js",
  "lp-geometry.js",
  "stream-cadence.js",
  "behave-onetoken.js",
];
