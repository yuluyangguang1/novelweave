/**
 * NovelWeave · 织文 — 卷级滚动压缩的覆盖判据（UMD：浏览器与 Node 共用）
 *
 * 前情摘要是三级衰减：最近 12 章给核心事件行、再往前 24 章给章名、更早的只报一个数。
 * 前两级的量写死了，第三级却跟着章数长 —— 180 章的书里「更早 144 章」那一行背后
 * 是一百多次彻底召回不到的锚点：作者要么手动回读，要么让模型在没有前情的下一章上动笔。
 * 卷摘要填的就是这一段：一卷一行，替掉那一卷里几十章的逐章出场。
 *
 * 这份文件只回答一件事：**哪些章被哪一卷盖住了**。渲染在 context.js，编辑在 app.js，
 * 检查在 rules.js，三处都问这一份 —— 覆盖口径写两遍，就会有一遍和另一遍对不上，
 * 而这个项目反复犯的病正是「阈值在第二处出现，两处从此再也没对上过」。
 *
 * 三条不可让的判据（每条都有反向夹具钉着）：
 * 1. **没写摘要的卷不盖章**。空卷行把几十章从上下文里删掉，等于把「记不全」
 *    伪装成「压缩过了」；宁可那些章退回章名层，也要让缺口看得见。
 * 2. **越过目标章的卷不注入**。一卷的终点落在要写的那章之后，它的摘要必然剧透后半卷；
 *    也不替作者裁一句「只说前半卷」—— 那是拿别人的稿子猜情节。
 * 3. **起止章找不到就判坏，不按 order 猜**。删过章以后 order 会重排，
 *    按序号硬凑出来的区间可能盖住完全不同的几十章。
 *
 * 刻意不做的事：不自动生成卷摘要（要模型来写，写出来的东西进上下文得先过作者的眼），
 * 也不动「最近 12 章 / 再往前 24 章」这两级的**行为** —— 这一批只接管「更早」那一段。
 * 那两个窗口本身的**值**写在这里（RECAP_FINE / RECAP_MID），因为 rules.js 算缺口时要同一个数。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWVolume = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VOLUME_VERSION = '1.0.0';

  /** 卷行比章行宽：章行只说一件事，卷行要替几十章说话。120 字 ≈ 两三层情节。 */
  const VOL_LINE_CHARS = 120;

  /**
   * 最多注入几卷。留这个上限是因为斜率降下来不等于没长：
   * 30 章一卷、900 章的书仍是 30 行，所以再往前的卷折成一行计数（如实说折了几卷几章）。
   */
  const VOL_WINDOW = 12;

  /**
   * 前情摘要那两级窗口的值。放在这份文件里是因为 **两个消费方要同一个数**：
   * context.js 用它裁层，rules.js（R33）用它算「还剩几章没人盖」。
   * rules.js 排在 context.js 之前加载，够不着那边的常量；数字一旦出现在第二处，
   * 两处迟早对不上 —— 所以值在这里，context.js 的 RECAP_ITEMS / RECAP_MID 是别名。
   */
  const RECAP_FINE = 12;
  const RECAP_MID = 24;

  const summaryOf = (vol) => String(vol?.summary || '').trim();

  function clip(text, max = VOL_LINE_CHARS) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  /** 阅读序 = 数组序，与 context.js 的假定一致（列表按 order 取回），这里不再排第二遍。 */
  function indexOf(chapters, id) {
    return (chapters || []).findIndex((c) => c.id === id);
  }

  /**
   * 卷的起止落成章下标。判坏的两种情形分开说，因为修法不同：
   * missing 是边界章被删了（作者得重挑起止），reversed 是起止填反了。
   */
  function boundsOf(vol, chapters) {
    const from = indexOf(chapters, vol?.fromChapter);
    const to = indexOf(chapters, vol?.toChapter);
    if (from === -1 || to === -1) return { ok: false, reason: 'missing', from: -1, to: -1 };
    if (to < from) return { ok: false, reason: 'reversed', from, to };
    return { ok: true, from, to };
  }

  /** 每卷一条区间，按卷序排一次；坏卷留在表里（要能说出口），不静默丢。 */
  function spans(volumes, chapters) {
    return (volumes || []).slice()
      .sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0))
      .map((vol) => Object.assign({ vol }, boundsOf(vol, chapters)));
  }

  /** 「第 1–30 章」；只有章号断过（删过章）时这句话依然老实：它说的是起止，不是章数。
   *  章号取 number（buildCtx 与 CLI 给的都是这个键），库里原始 order 只做兜底。 */
  function rangeText(span, chapters) {
    const a = chapters?.[span.from], b = chapters?.[span.to];
    if (!a || !b) return '起止章不在书里';
    const na = a.number ?? a.order, nb = b.number ?? b.order;
    return na === nb ? `第 ${na} 章` : `第 ${na}–${nb} 章`;
  }

  /** 这一卷盖住几章 —— 按区间实际长度算，不按章号相减（章号会断）。 */
  const coveredCount = (span) => (span.ok ? span.to - span.from + 1 : 0);

  /**
   * 两卷盖住同一章：那段往事在上下文里出现两遍，而且「压掉了多少章」从此是个吹出来的数
   * （covered 是集合，重叠部分只算一次，两卷各自却都宣称盖住它）。
   * 起止读不出来的卷不参与 —— 它连区间都没有，重叠无从谈起。
   */
  function overlaps(spanList) {
    const ok = (spanList || []).filter((s) => s.ok);
    const out = [];
    for (let i = 0; i < ok.length; i++) {
      for (let j = i + 1; j < ok.length; j++) {
        const from = Math.max(ok[i].from, ok[j].from);
        const to = Math.min(ok[i].to, ok[j].to);
        if (to < from) continue;
        out.push({ a: ok[i], b: ok[j], from, to, chapters: to - from + 1 });
      }
    }
    return out;
  }

  /**
   * 分层。fine / mid 默认取上面那一对窗口（context.js 与 rules.js 共用同一个数），
   * 调用方可以覆盖 —— 短篇的「摘要不封顶」就是把它传成 Infinity。
   *
   * 返回的桶都要能说出口：volumes 真进了上下文，folded 是太早被折掉的卷，
   * empty 是没写摘要所以没资格盖章的卷，deferred 会剧透，bad 是起止章读不出来，
   * partial 压在细窗口那一段上（那几十章本来就逐章列着，卷行说了是重复），
   * overlaps 是起止打架的卷对（覆盖数里那几章被算了两遍）。
   */
  function recapPlan({ chapters = [], currentId = null, volumes = [], fine = RECAP_FINE, mid = RECAP_MID, volumeWindow = VOL_WINDOW } = {}) {
    const cut = currentId ? indexOf(chapters, currentId) : chapters.length;
    const head = chapters.slice(0, Math.max(0, cut));
    const all = spans(volumes, chapters);
    const bad = all.filter((s) => !s.ok);
    const empty = all.filter((s) => s.ok && !summaryOf(s.vol));
    const overlapped = overlaps(all);
    // 盖住目标章或它之后的卷，一律不注入
    const ahead = all.filter((s) => s.ok && summaryOf(s.vol) && s.to >= Math.max(0, cut));
    const usable = all.filter((s) => s.ok && summaryOf(s.vol) && !ahead.includes(s));
    const hasSummary = (c) => (c.summary || '').trim().length > 0;
    const withSummary = head.filter(hasSummary);
    const recent = withSummary.slice(-fine);
    const rest = withSummary.slice(0, withSummary.length - recent.length);
    // 细窗口的起点：一卷只要压着这一段，就不当它是「更早的东西」
    const fineStart = recent.length ? head.indexOf(recent[0]) : head.length;
    const whole = usable.filter((s) => s.to < fineStart);
    const partial = usable.filter((s) => s.to >= fineStart);
    const sorted = whole.slice().sort((a, b) => a.from - b.from);
    const kept = sorted.slice(-Math.max(1, volumeWindow));
    const folded = sorted.slice(0, sorted.length - kept.length);
    // 盖住与否看**全部参与的卷**（含被折掉那几卷）：折掉的卷只是不逐卷出行，
    // 它盖住的章已经由那句「已折」交代了，再列一遍章名等于同一件事说两遍。
    const covered = new Set();
    for (const s of sorted) for (let i = s.from; i <= s.to; i++) covered.add(head[i].id);
    const residual = rest.filter((c) => !covered.has(c.id));
    const titles = residual.slice(-mid);
    const uncovered = residual.slice(0, residual.length - titles.length);
    const counts = {
      head: head.length,
      book: all.length,
      fine: recent.length,
      titles: titles.length,
      volumes: kept.length,
      folded: folded.length,
      // 「压掉了多少」是这一层存在的唯一理由，也是它最容易被夸大的地方 —— 跟着层数一起报
      covered: covered.size,
      uncovered: uncovered.length,
      empty: empty.length,
      bad: bad.length,
      deferred: ahead.length,
      overlaps: overlapped.length,
    };
    return {
      version: VOLUME_VERSION,
      chapters: head,
      fine: recent,
      titles,
      uncovered,
      volumes: kept,
      folded,
      partial,
      deferred: ahead,
      empty,
      bad,
      overlaps: overlapped,
      covered,
      counts,
      compressed: covered.size,
    };
  }

  /** 一卷进上下文的那一行。卷名与区间都在，摘要空的话压根不该走到这里（empty 桶）。 */
  function lineOf(span, chapters) {
    return `- ${span.vol.title || '未命名卷'}（${rangeText(span, chapters)}·${coveredCount(span)} 章）：${clip(summaryOf(span.vol))}`;
  }

  /** 折掉那几卷的说法：说清折了几卷几章，别说成「更早 N 章没提」。 */
  function foldedText(folded) {
    if (!folded.length) return '';
    const chapters = folded.reduce((n, s) => n + coveredCount(s), 0);
    return `（更早 ${folded.length} 卷、约 ${chapters} 章已折）`;
  }

  /**
   * 缺口那一句。五种「为什么没压」各有各的修法，混成一句「有缺口」等于什么都没说：
   * 空卷要去补摘要、坏卷要重挑起止、重叠的卷要挪边界、越前的卷本来就不该用、
   * 剩下的章是没卷盖的。
   */
  function gapNotice(plan) {
    if (!plan) return '';
    const parts = [];
    // 一本还没建卷的书不是「有缺口」，是「还没开始用这套东西」—— 那句要说给已经建了卷的人
    const free = plan.chapters.length - plan.covered.size - plan.fine.length - plan.titles.length;
    if (plan.counts.book > 0 && free > 0) parts.push(`${free} 章不在任何卷里`);
    if (plan.empty.length) parts.push(`${plan.empty.length} 卷还没写摘要，它盖住的章没被压缩`);
    if (plan.bad.length) parts.push(`${plan.bad.length} 卷的起止章在书里读不出来`);
    if (plan.overlaps.length) parts.push(`${plan.overlaps.length} 对卷的起止重叠，那几章被算了两遍`);
    if (plan.deferred.length) parts.push(`${plan.deferred.length} 卷越过本章，没用它（用了就是剧透）`);
    return parts.join(' · ');
  }

  return {
    VOLUME_VERSION, VOL_LINE_CHARS, VOL_WINDOW, RECAP_FINE, RECAP_MID,
    clip, boundsOf, spans, rangeText, coveredCount, overlaps, recapPlan, lineOf, foldedText, gapNotice, summaryOf,
  };
});
