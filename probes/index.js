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
  "net-pathsplit.js",
  "cap-contextceiling.js",
  "lp-geometry.js",
];
