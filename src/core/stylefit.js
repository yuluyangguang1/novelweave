/**
 * NovelWeave · 织文 — 文风指纹（UMD：浏览器与 Node 共用）
 *
 * 定位：把「这本书自己的笔法」变成四个数。它不评价写得好不好 ——
 * 那句只有作者能说；它只回答「这一章和基准章像不像、差在哪一格」。
 *
 * 为什么要数字而不是只喂样例段：样例段是隐含信号，模型学到什么无人能查；
 * 数字既能写进 prompt（「你的基准是句均 21 字」），也能在机检里回查
 * （R32 拿逐章指纹跟基准比）。两边算的是同一个函数，不会出现
 * 「prompt 里承诺的基准，检查器按另一套口径查」。
 *
 * 依赖：NWText / NWStylePack（句段切分与禁词计数）/ NWTension（对话占比）。
 * 刻意不做的事：不做语义相似度、不判「文笔高低」、不给一个总分。
 * 四个数各说各话，作者才有处置权 —— 合成一个分数就是把判断权交给统计。
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWStylePack, root.NWTension);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWStyleFit = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, StylePack, Tension) {
  'use strict';

  const FIT_VERSION = '1.0.0';

  /** 够不够格进指纹：跟「风格样例」的正文门槛同一出处，两处不许各写一个数。 */
  const MIN_BODY = 600;

  /**
   * 这一格是整个能力唯一的「够不够长」判据，只此一份：指纹、注入样例、界面清单、
   * R32 与 CLI 问的都是它。用的是 NWText.countWords —— 与库里 word_count、界面「N 字」
   * 同一个口径。以前拿 body.length 判，而话术写的是「600 字」：标点也计进了长度，
   * 于是界面上会出现「480 字却能勾」，作者看见的数字与他听见的门槛是两个数。
   */
  function qualifies(body) {
    const s = String(body ?? '').trim();
    return (T ? T.countWords(s) : s.length) >= MIN_BODY;
  }

  /**
   * 四个键就是这张指纹的全部。门槛的来路都写在注释里，不是拍的：
   * - 句均字数、段均句数按**相对**偏离：这两格的本底因人而异（短句流 12 字、长句流 40 字），
   *   绝对差不通用；本底 12 字涨到 16 字（+33%）比本底 40 字涨到 44 字（+10%）严重得多。
   * - 对话占比按**百分点**：占比接近 0 时相对偏离会爆炸（1%→4% 就是 +300%，但没人会觉得这叫漂移）。
   * - 禁词密度用绝对差 1.5，与 NWStylePack.verdict 的 info 档同值（那边的门槛已有出处：千字 1.5 处）。
   */
  const KEYS = [
    { id: 'sentAvg', label: '句均字数', kind: 'rel', dev: 0.3, fmt: (v) => `${v.toFixed(1)} 字` },
    { id: 'dialogue', label: '对话占比', kind: 'pp', dev: 12, fmt: (v) => `${Math.round(v * 100)}%` },
    { id: 'paraSent', label: '段均句数', kind: 'rel', dev: 0.4, fmt: (v) => `${v.toFixed(1)} 句` },
    { id: 'cliche', label: '禁词密度', kind: 'abs', dev: 1.5, fmt: (v) => `${v.toFixed(2)} 处/千字` },
  ];

  /** 一篇正文的原始计数。基准章与待查章都走这里，口径不可能分叉。 */
  function count(body, opts = {}) {
    const s = String(body || '');
    const words = T ? T.countWords(s) : s.length;
    const paras = StylePack.paragraphs(s);
    const sentWords = { v: 0, n: 0 };
    for (const p of paras) {
      for (const sent of StylePack.sentences(p)) {
        sentWords.n += 1;
        sentWords.v += T ? T.countWords(sent.text) : sent.text.length;
      }
    }
    const st = Tension.stats(s);
    const lint = StylePack.lint(s, opts);
    return {
      words,
      paragraphs: paras.length,
      sentences: sentWords.n,
      sentWords: sentWords.v,
      dialogueWords: st.dialogueWords,
      clicheHits: lint.banned.length,
    };
  }

  function ratio(a, b) { return b > 0 ? a / b : 0; }

  /**
   * 若干章合成一份指纹。计数先相加再相除 —— 先平均各章的比值会让一章短正文
   * 和一章六千字正文同权，那就不叫这本书的笔法了。
   */
  function fingerprint(chapters, opts = {}) {
    const pool = (chapters || []).filter((c) => qualifies(c?.body));
    const sum = { words: 0, paragraphs: 0, sentences: 0, sentWords: 0, dialogueWords: 0, clicheHits: 0 };
    for (const c of pool) {
      const n = count(c.body, opts);
      for (const k of Object.keys(sum)) sum[k] += n[k];
    }
    return {
      version: FIT_VERSION,
      chapters: pool.length,
      words: sum.words,
      sentAvg: +ratio(sum.sentWords, sum.sentences).toFixed(1),
      dialogue: +ratio(sum.dialogueWords, sum.words).toFixed(3),
      paraSent: +ratio(sum.sentences, sum.paragraphs).toFixed(1),
      cliche: +ratio(sum.clicheHits, sum.words / 1000).toFixed(2),
    };
  }

  function keyOf(id) { return KEYS.find((k) => k.id === id) || null; }

  /** 单键偏离量与「是否越界」。kind 决定用相对差、百分点差还是绝对差。 */
  function deviation(key, base, cur) {
    if (key.kind === 'pp') return { amount: Math.abs(cur - base) * 100, unit: '个百分点' };
    if (key.kind === 'abs') return { amount: Math.abs(cur - base), unit: key.id === 'cliche' ? '处/千字' : '' };
    if (!base) return { amount: cur ? Infinity : 0, unit: '倍' };
    return { amount: Math.abs(cur - base) / base, unit: '' };
  }

  /**
   * 基准 vs 一份指纹。只输出越界的键；一条都没越就返回空数组。
   * deltaText 是「越了多少」的人话，方向另给 —— 报出来要说得出「变长还是变短」。
   */
  function compare(base, cur) {
    if (!base || !cur || !base.words || !cur.words) return [];
    const out = [];
    for (const k of KEYS) {
      const d = deviation(k, base[k.id], cur[k.id]);
      if (!(d.amount > k.dev)) continue;
      const deltaText = !isFinite(d.amount) ? '本底为 0'
        : k.kind === 'pp' ? `${Math.round(d.amount)} 个百分点`
        : k.kind === 'abs' ? `${d.amount.toFixed(2)} ${d.unit}`
        : `${Math.round(d.amount * 100)}%`;
      out.push({
        id: k.id, label: k.label,
        base: base[k.id], cur: cur[k.id],
        text: `${k.label} ${k.fmt(base[k.id])}→${k.fmt(cur[k.id])}`,
        deltaText,
        direction: cur[k.id] > base[k.id] ? '升' : '降',
      });
    }
    return out;
  }

  /** 这一份是要进 prompt 的：给数字，不给形容词。 */
  function lines(fp) {
    if (!fp || !fp.words) return '';
    const parts = KEYS.map((k) => `${k.label} ${k.fmt(fp[k.id])}`).join(' · ');
    return `【基准指纹】${fp.chapters} 章 / ${fp.words} 字的实测值：${parts}。这一章照着这个量级写。`;
  }

  /** R32 与 CLI 共用的一句人话。两个键以上才报，见 rules.js 的门槛说明。 */
  function driftText(base, cur) {
    return compare(base, cur).map((d) => `${d.text}（${d.direction} ${d.deltaText}）`).join('、');
  }

  return { FIT_VERSION, MIN_BODY, KEYS, qualifies, count, fingerprint, compare, deviation, keyOf, lines, driftText };
});
