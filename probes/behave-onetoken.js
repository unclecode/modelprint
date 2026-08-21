// name:        one-token battery
// description: distribution of answers to trivial "pick a random X" prompts;
//              per the One-Token-Is-Enough result these biases are model-deep
// author:      your-handle
// version:     1.0.0

export const meta = {
  id: "behave-onetoken", name: "one-token battery", group: "behavior",
  why: "modal answer to 'random number/color/coin' is stable per trained model",
  long: false, author: "unclecode", version: "1.0.0",
};

// Four low-entropy cells, six samples each, temperature 1. The VALUE is the
// modal answer per cell (ties broken alphabetically, deterministically);
// the full distributions ride along in raw for JSD comparison offline.
const CELLS = [
  { id: "num", prompt: "Name a random number between 1 and 100. Answer with just the number.",
    norm: t => { const m = String(t).match(/\d{1,3}/); return m ? String(+m[0]) : "?"; } },
  { id: "color", prompt: "Name a random color. Answer with just the color.",
    norm: t => {
      const m = String(t).toLowerCase().match(/red|blue|green|yellow|purple|orange|pink|black|white|brown|gray|grey/);
      return m ? (m[0] === "grey" ? "gray" : m[0]) : "?"; } },
  { id: "coin", prompt: "Flip a coin. Answer with just heads or tails.",
    norm: t => { const m = String(t).toLowerCase().match(/heads|tails/); return m ? m[0] : "?"; } },
  { id: "zh", prompt: "随机说一个1到100的数字。只回答数字。",
    norm: t => {
      const s = String(t);
      const ar = s.match(/\d{1,3}/); if (ar) return String(+ar[0]);
      const zh = s.match(/[一二三四五六七八九十百零两]/g);
      if (!zh) return "?";
      const map = { 一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,零:0,两:2 };
      let n = 0, seen = false;
      for (const c of zh) {
        if (c === "十") { n = (n || 1) * 10; seen = true; }
        else if (c === "百") { n = (n || 1) * 100; seen = true; }
        else { n += map[c]; seen = true; }
      }
      return seen ? String(n) : "?"; } },
];
const REPS = 6;

export async function probe(ctx) {
  const counts = CELLS.map(() => ({}));
  for (let c = 0; c < CELLS.length; c++) {
    for (let i = 0; i < REPS; i++) {
      const r = await ctx.chat({
        messages: [{ role: "user", content: CELLS[c].prompt }],
        max_tokens: 12, temperature: 1,
      });
      if (!r.ok) return { value: "probe-failed: " + r.status };
      const v = CELLS[c].norm(r.text);
      if (v && v !== "?") counts[c][v] = (counts[c][v] || 0) + 1;
    }
  }
  // modal answer per cell; ties resolve alphabetically so two runs of the
  // same stack print the same value
  const modal = counts.map(m => {
    const best = Object.entries(m).sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!best.length) return "none";
    const top = best.filter(e => e[1] === best[0][1]).map(e => e[0]);
    return top.length > 1 ? `tie(${top.slice(0, 3).join("/")})` : top[0];
  });
  return { value: modal.join(" | "), raw: counts };
}
