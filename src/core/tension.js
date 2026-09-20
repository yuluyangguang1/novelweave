/**
 * NovelWeave · 织文 — 正向张力统计（UMD：浏览器与 Node 共用）
 *
 * R1–R22 查的都是「不能错 / 别这么写」。这个包管另一半：一章读下来该有而没有的
 * 东西到位了没有 —— 有没有人开口、有没有连续一大段纯叙述、结尾是不是每章同一种钩子。
 *
 * 只数数，不裁判。「冲突强度」「爽点」「这章精不精彩」数不出来，就不写进规则 ——
 * 一条会误报的节奏规则，作者的处置是把它连带整包关掉，等于没有。
 *
 * 和 stylepack.js 同构：同一份数字要喂三处 —— 写之前的 prompt（llm.js）、
 * 写之后的机检（rules.js R23/R25）、命令行兜底（nw-prose）。分成三份必然自相矛盾。
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWStylePack);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWTension = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, StylePack) {
  'use strict';

  const PACK_VERSION = '1.0.0';

  /**
   * 每书配额。按版式分两档：一章 3000 字和一章 800 字不能用同一个绝对数。
   * minWords —— 对话占比的评审门槛：占比要整章体量撑得起来，几百字的片段不评。
   * minBody —— 变化点的评审门槛：章子基本成形就可以问「这章改变了什么」。
   * ratioLow —— 对话字数占比低于此值算「整章没人开口」；plainInfo —— 连续多少字纯叙述要提示。
   * hookRun —— 连续几章同一种结尾钩子算偷懒。
   * 这里没有 warn 门槛：本包三条规则恒为 info，理由写在 rules.js 的 detail 里。
   */
  const QUOTAS = {
    long: { minWords: 1500, minBody: 800, ratioLow: 0.08, plainInfo: 800, hookRun: 3 },
    short: { minWords: 400, minBody: 300, ratioLow: 0.10, plainInfo: 600, hookRun: 3 },
  };

  /** 成对引号。只认前引号会把「他说：“……」之后的整段都算成台词，占比虚高。 */
  const QUOTE_PAIRS = [['“', '”'], ['「', '」'], ['『', '』']];
  /** 超过这个长度还没等到后引号，按漏写引号处理，不算对话 —— 否则一处漏引号能吃掉一整章。 */
  const MAX_SPAN = 600;

  const TAIL_WINDOW = 120;

  function words(s) {
    return T ? T.countWords(s) : String(s || '').length;
  }

  /**
   * 对话区间：成对引号包住的原文段，返回 [{start, end, text}]（end 含后引号）。
   * 同一处多个前引号取最先配对的；不嵌套（中文小说里引号套引号通常换字形）。
   */
  function dialogueSpans(text) {
    const body = String(text || '');
    const opens = [];
    for (const [o] of QUOTE_PAIRS) for (let i = body.indexOf(o); i >= 0; i = body.indexOf(o, i + 1)) opens.push({ at: i, o });
    opens.sort((a, b) => a.at - b.at);
    const out = [];
    let consumed = -1;
    for (const { at, o } of opens) {
      if (at < consumed) continue;
      const close = QUOTE_PAIRS.find((p) => p[0] === o)[1];
      let end = -1;
      for (let i = at + 1; i < body.length && i - at <= MAX_SPAN; i++) {
        const ch = body[i];
        // 遇到另一种前引号说明上一处忘了收尾，这段不算对话
        if (QUOTE_PAIRS.some((p) => p[0] === ch && p[0] !== o)) break;
        if (ch === close) { end = i; break; }
      }
      if (end < 0) continue;
      out.push({ start: at, end: end + 1, text: body.slice(at + 1, end) });
      consumed = end + 1;
    }
    return out;
  }

  function overlaps(a, b) {
    return a.start < b.end && b.start < a.end;
  }

  /**
   * 一篇正文的张力统计。纯函数，不读盘。
   * @returns { words, dialogueWords, ratio, plainRuns:{words,from,to}, sample }
   */
  function stats(text) {
    const body = String(text || '');
    const total = words(body);
    const spans = dialogueSpans(body);
    const dialogueWords = spans.reduce((s, sp) => s + words(sp.text), 0);

    const paras = StylePack ? StylePack.paragraphs(body) : [];
    let run = 0, runFrom = null;
    const best = { words: 0, from: 0, to: 0 };
    for (const p of paras) {
      const spoken = spans.some((sp) => overlaps({ start: p.start, end: p.end }, sp));
      if (spoken) { run = 0; runFrom = null; continue; }
      if (run === 0) runFrom = p.start;
      run += words(p.text);
      if (run > best.words) { best.words = run; best.from = runFrom; best.to = p.end; }
    }
    const mid = body.slice(best.from, best.from + 30).replace(/\s+/g, ' ');
    return {
      words: total,
      dialogueWords,
      ratio: total > 0 ? +(dialogueWords / total).toFixed(3) : 0,
      plainRuns: best,
      sample: mid,
    };
  }

  /**
   * 结尾钩子的类型。刻意只做两类判据确凿的：问句收尾、突转词收尾。
   * 其余一律 null —— 「留白」「悬念感」是修辞判断，机器认不出来就别装作认得。
   * 判据与 R17 用同一批词，两条规则不会一个说有钩子一个说没类型。
   */
  function hookKind(tail) {
    const s = String(tail || '');
    if (!s.trim()) return null;
    if (/[？?]/.test(s)) return 'question';
    if (TWIST_RE.test(s)) return 'twist';
    return null;
  }
  const TWIST_RE = /突然|没想到|只见|下一瞬|下一刻|话音未落|猛地|凭空|异变|还没等|未完待续|欲知后事/;

  const HOOK_LABEL = { question: '问句收尾', twist: '突转收尾' };

  function tailOf(text) {
    const s = String(text || '').trim();
    return s.length <= TAIL_WINDOW ? s : s.slice(-TAIL_WINDOW);
  }

  /** 一本书该用哪档配额。format 只有 long/short 两个值，认不出一律按长篇。 */
  function quotaFor(book) {
    const key = (book && book.format === 'short') ? 'short' : 'long';
    return QUOTAS[key];
  }

  /**
   * 未收伏笔的三个数字，喂给写之前的那段。
   * 「最久的一条已经多少章」是这句里唯一能让模型真停下来看一眼的东西 ——
   * 光说「你有伏笔没回收」等于没说。只算已登记的 promise，candidate（自动登记、作者未确认）不算债。
   */
  function tally(ctx) {
    const items = (ctx && ctx.promises && ctx.promises.items) || [];
    const chapters = (ctx && ctx.chapters) || [];
    const num = new Map(chapters.map((c) => [c.id, c.number]));
    const last = chapters.reduce((m, c) => Math.max(m, c.number || 0), 0);
    let open = 0, overdue = 0, oldest = 0;
    for (const it of items) {
      if (it.type !== 'promise' || it.weight === 'candidate') continue;
      if (it.status === 'paid-off' || it.status === 'dropped' || it.status === 'cancelled') continue;
      open += 1;
      const setupN = it.setup && it.setup.chapter != null ? num.get(it.setup.chapter) : null;
      if (setupN != null && last > setupN) oldest = Math.max(oldest, last - setupN);
      const dueN = it.payoff && it.payoff.due ? num.get(it.payoff.due) : null;
      if (dueN != null && last > dueN) overdue += 1;
    }
    return { open, overdue, oldest: oldest || 0 };
  }

  /**
   * 写之前那段「该有而没有」的清单。传 tally 是为了把未收伏笔的真实数字写进去 ——
   * 静态口号模型不会当回事，「你有 7 条伏笔没收，最久的已经 23 章」才会。
   */
  function promptBlock(book, tally_ = {}) {
    const q = quotaFor(book);
    const lines = ['节奏配额（这几样是本章该有而没有的，不是文笔要求）：'];
    lines.push(`- 让人开口：对话占到 ${Math.round(q.ratioLow * 100)}% 以上，连续 ${q.plainInfo} 字没有一句台词就得起新张力`);
    lines.push('- 造成一个可登记的变化：埋一条新伏笔、收一条旧的，或让某个角色的位置／伤势／持有／所知道的事真的变了');
    lines.push(`- 结尾别重复上一章那种钩子（问句、突转连续 ${q.hookRun} 章同一型就算偷懒）`);
    if (tally_ && tally_.open) {
      const over = tally_.overdue ? `，其中 ${tally_.overdue} 条已过你自设的回收期限` : '';
      const oldest = tally_.oldest ? `，最久的一条已经 ${tally_.oldest} 章` : '';
      lines.push(`- 当前未收伏笔 ${tally_.open} 条${over}${oldest}：本章先偿旧，再提新`);
    }
    return lines.join('\n');
  }

  return {
    PACK_VERSION, QUOTAS, HOOK_LABEL,
    dialogueSpans, stats, hookKind, tailOf, quotaFor, tally, promptBlock,
  };
});
