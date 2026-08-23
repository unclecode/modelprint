// name:        chinese paragraph
// description: prompt_tokens for fixed CJK text; segmentation differs most between labs
// author:      unclecode
// version:     1.0.0

import { describeFailure } from "./_failure.js";

export const meta = {
  id: "tok-chinese", name: "chinese paragraph", group: "tokenizer",
  why: "CJK segmentation differs most between labs",
  long: false, author: "unclecode", version: "1.0.0",
};

const TEXT = "机器学习模型将文本切分为词元，每个实验室的切分方式都不同。"
  + "上下文窗口、注意力机制与位置编码共同决定了模型如何理解长文档。"
  + "爬虫抓取网页时也面临同样的分词问题，尤其是中日韩文字混排的场景。";

export async function probe(ctx) {
  // Three cheap calls. TEXT twice: if the counts differ, a router is spreading
  // calls across hosts and no fingerprint exists ("unstable"). Then a one-char
  // baseline: the value reported is TEXT minus baseline, which cancels the
  // host's hidden template. Two hosts wrapping the SAME tokenizer then match,
  // which raw counts never would.
  const a = await ctx.chat({ messages: [{ role: "user", content: TEXT }], max_tokens: 1 });
  const b = await ctx.chat({ messages: [{ role: "user", content: TEXT }], max_tokens: 1 });
  const base = await ctx.chat({ messages: [{ role: "user", content: "a" }], max_tokens: 1 });
  if (!a.ok || !b.ok || !base.ok) {
    // Name the call that ACTUALLY failed. Picking the first truthy status
    // printed "probe-failed: 200" when call one succeeded and a later one
    // timed out, which hides the real cause.
    const bad = [a, b, base].find(r => !r.ok);
    return { value: describeFailure(bad), raw: { status: bad.status, error: bad.error } };
  }
  if (a.usage.prompt_tokens !== b.usage.prompt_tokens)
    return { value: "unstable (multi-host routing)",
             raw: { first: a.usage.prompt_tokens, second: b.usage.prompt_tokens } };
  const norm = a.usage.prompt_tokens - base.usage.prompt_tokens;
  return { value: norm, raw: { raw_count: a.usage.prompt_tokens, baseline: base.usage.prompt_tokens } };
}
