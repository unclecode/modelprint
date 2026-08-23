# Contributors

modelprint grows through community probes. Every probe is one file, and every
accepted probe is credited here and on the page itself.

## Probe authors

**[@ItIsCuthNotCup](https://github.com/ItIsCuthNotCup)** — the first community
contribution, [#1](https://github.com/unclecode/modelprint/pull/1).
Network forensics, capability ceilings and deep-signal probes:
`net-region`, `net-headerdna`, `net-genrecord`, `cap-contextceiling`,
`lp-geometry`.

**[@pjperez](https://github.com/pjperez)** —
[#2](https://github.com/unclecode/modelprint/pull/2),
[#3](https://github.com/unclecode/modelprint/pull/3).
Found and fixed a bug that stopped `net-genrecord` from ever returning a
record, and wrote `net-pathsplit`, which measures the network distance to the
real upstream provider behind a router using two deliberately rejected calls.

## Want your name here?

Copy [`probes/_template.js`](probes/_template.js), keep the header comment,
and open a pull request. Every probe passes two gates before it merges: a
security check (a probe must never be able to reach any origin but the lane's
own, so a visitor's key can never leak) and a determinism check (the same
model must always produce the same value, or the comparison table would show
false matches). See [`probes/`](probes/) for the contract.
