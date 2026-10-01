/**
 * NovelWeave · 织文 — 选题评分卡（UMD：浏览器与 Node 共用）
 *
 * 机检查的是「写出来的东西哪里错了」，这一张卡查的是动笔之前：这个选题本身立不立得住。
 * 借自竞品 bookflow 的 seed 评分思路，但只保留机器真算得出来的四维 ——
 * 「题材热度」「爽点强度」这类要联网查榜单的东西这里一个都没有，本机没有榜单数据源，
 * 写出来就是拿一个写死的词表冒充热度，那是骗作者。
 *
 * 分数永远是建议，不是门禁：没有任何一处的执行路径会因为分低而拒绝生成或拒绝建档。
 * 判据全部公开在这里，改判据就是改这个文件，界面和 CLI 都从这里取数（与 tension.js 同构）。
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWTension);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWPitch = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, Tension) {
  'use strict';

  const PACK_VERSION = '1.0.0';
  const MAX_PER_DIM = 3;

  /**
   * 套路词表。**手写的，不是任何平台的榜单数据**，代表的是「这三个字一出现在梗概里，
   * 编辑就知道作者是照着模板填的」。命中越多越像批量生产，与写得好不好无关。
   * 词表按「标题党级套路」收，不收类型词（修仙/悬疑本身不是套路）。
   */
  const CLICHE_WORDS = [
    '退婚', '废柴', '赘婿', '龙王', '战神', '兵王', '神医', '下山', '离婚', '替嫁', '闪婚',
    '带球跑', '马甲', '团宠', '霸总', '打脸', '开局签到', '开局获得', '金手指', '系统流',
    '穿越成', '重生后', '魂穿', '契约', '复仇', '流三年',
  ];

  /** 撞车判据：两句话的大字符重合到这个比例，就是同一个选题换了层皮。 */
  const SIMILAR_CUT = 0.5;

  /**
   * 单章字数的合理区间（含端点）—— **不在这里定，也不在这里抄**：
   * 出处是 `NWTension.CHAPTER_RANGE`（同一份数字还要喂 prompt 与机检 R35，写第二遍就会各说各话）。
   * 这里只是评分卡那一路的别名（同一个对象，不是复制）。区间外但没超出 2 倍/低到 0.5 倍的，算「能调」而不是「崩了」。
   * 短篇那一档的 `hi` 是 null = 上不封顶，`LENGTH_LABEL` 负责把这一档说成人话。
   */
  const LENGTH_RANGE = Tension.CHAPTER_RANGE;
  const LENGTH_LABEL = { long: Tension.rangeLabel('long'), short: Tension.rangeLabel('short') };
  /** 张力来源：梗概里出现这些词，说明作者至少写清了「谁跟谁拧着」。 */
  const CONFLICT_RE = /但|却|然而|被迫|只能|必须|只剩|倒计时|秘密|隐瞒|追杀|对决|赌|欠|誓|不肯|无法|错过|来不及/;
  /** 首章正文要够长才值得按「成稿结尾」判钩子，否则拿大纲尾巴凑数。 */
  const BODY_MIN_FOR_HOOK = 200;

  function txt(s) {
    return String(s == null ? '' : s).trim();
  }

  function words(s) {
    return T ? T.countWords(s) : String(s || '').length;
  }

  /**
   * 两种入参长成一个形状：向导生成的 concept，和已成一本书的 ctx。
   * 判据只写一份 —— 分成两套必然自相矛盾，那是这个项目最常见的病。
   */
  function viewOf(input) {
    const src = input && typeof input === 'object' ? input : {};
    const isCtx = !!(src.book || src.promises || src.characters && src.characters.some((c) => c && c.role_zh !== undefined));
    const book = src.book || {};
    const chapters = (Array.isArray(src.chapters) ? src.chapters : []).map((c) => ({
      title: txt(c && c.title),
      beat: txt((c && (c.beat ?? c.summary)) || ''),
      body: txt((c && (c.body ?? c.content)) || ''),
    }));
    const characters = (Array.isArray(src.characters) ? src.characters : []).map((c) => ({
      name: txt(c && c.name),
      role: txt(c && (c.role_zh || c.role) || ''),
      personality: txt(c && c.personality),
    }));
    const world = (Array.isArray(src.world) ? src.world : []).map((w) => ({
      name: txt(w && (w.comment || w.name) || ''), content: txt(w && w.content),
    }));
    const openPromises = isCtx && Tension ? Tension.tally(src).open : 0;
    return {
      kind: isCtx ? 'ctx' : 'concept',
      title: txt(src.title || book.title),
      logline: txt(src.logline || book.description),
      genre: txt(src.genre || book.genre),
      // 与对照书取更短的那一档：两边都算长篇才按长篇评
      format: Tension.minFormat([book, src]),
      // 两种入参问的是两件事，这里必须分开：ctx 读的是**这本书库里那一格**（长篇没有那一格，
      // 低于下限的数算没设），concept 读的是**作者当场打算写多少**（那是规划：向导的平台档与
      // CLI 的 --words 都能给长篇一个数，它从来不是库里那一格）。以前两边都拿原值算，
      // 于是长篇库里那个遗留数画不出进度条、面板说「没设」，而这张卡按它给分。
      targetWords: isCtx ? Tension.targetOf(book) : Number(src.targetWords ?? src.target_words) || null,
      chapters, characters, world, openPromises,
    };
  }

  function bigrams(s) {
    const t = txt(s).replace(/[\s，。、；：！？“”「」『』（）()《》\-—·]/g, '');
    const out = new Set();
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
    return out;
  }

  /** 大字符 Jaccard。不做分词，中文短句子够用；真要做语义查重那是 embedding 的活。 */
  function similarity(a, b) {
    const A = bigrams(a); const B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let both = 0;
    for (const g of A) if (B.has(g)) both += 1;
    return +(both / (A.size + B.size - both)).toFixed(3);
  }

  /** 钩子有几处可判：一句话梗概、首章拍点、首章成稿的结尾（后两者按版式取）。 */
  function hookSources(v) {
    const out = [];
    if (v.logline) out.push({ at: '一句话梗概', text: v.logline });
    const first = v.chapters[0];
    if (first && first.beat) out.push({ at: '首章拍点', text: first.beat });
    if (first && words(first.body) >= BODY_MIN_FOR_HOOK) out.push({ at: '首章结尾', text: Tension.tailOf(first.body) });
    return out;
  }

  function scoreHook(v) {
    const src = hookSources(v);
    if (!src.length) {
      return { score: 0, reason: '没有可判的梗概文字', advice: '先写一句话梗概：谁、被什么逼到、必须做什么' };
    }
    const hit = src.filter((s) => Tension && Tension.hookKind(s.text));
    if (!hit.length) {
      return { score: 1, reason: `${src.map((s) => s.at).join('、')}里没有一个钩子`,
        advice: '把梗概或首章拍点的末尾改成问句，或收在一次突转上' };
    }
    if (hit.length >= 2) {
      return { score: 3, reason: `${hit.map((s) => `${s.at}：${Tension.HOOK_LABEL[Tension.hookKind(s.text)]}`).join('，')}` };
    }
    return { score: 2, reason: `只有「${hit[0].at}」一处收在钩子上（${Tension.HOOK_LABEL[Tension.hookKind(hit[0].text)]}）`,
      advice: '另一处也留个钩子，读者往下翻的理由不能只有一个' };
  }

  function clicheHits(v) {
    const hay = [v.title, v.logline, v.genre, v.chapters[0] && v.chapters[0].beat].filter(Boolean).join('\n');
    return CLICHE_WORDS.filter((w) => hay.includes(w));
  }

  function scoreDiff(v, others) {
    const hits = clicheHits(v);
    let top = 0; let near = null;
    for (const o of others) {
      const s = typeof o === 'string' ? o : txt(o && (o.logline || o.description || o.title));
      if (!s) continue;
      const sim = similarity(v.logline || v.title, s);
      if (sim > top) { top = sim; near = typeof o === 'string' ? o : txt(o.title) || o.logline; }
    }
    const collided = top >= SIMILAR_CUT;
    const n = hits.length + (collided ? 1 : 0);
    const score = n === 0 ? 3 : n === 1 ? 2 : n === 2 ? 1 : 0;
    const parts = [];
    if (hits.length) parts.push(`套路词 ${hits.length} 个：${hits.join('、')}`);
    if (collided) parts.push(`梗概与「${String(near).slice(0, 20)}」重合 ${(top * 100).toFixed(0)}%`);
    if (!parts.length) return { score: 3, reason: '梗概里没有一个套路词，也没撞车' };
    return { score, reason: parts.join('；'),
      advice: collided && !hits.length ? '换个切入角度，别在同一个设定上换皮' : '把套路词换成你这个选题独有的那个具体处境' };
  }

  function hasProtagonist(v) {
    return v.characters.find((c) => /主|protagonist/i.test(c.role) && c.name);
  }

  function scoreStructure(v) {
    const got = [];
    const lost = [];
    const chs = v.chapters;
    if (chs.length && chs.every((c) => c.beat || c.body)) got.push('每章都有拍点');
    else lost.push('有章没写拍点');
    const hero = hasProtagonist(v);
    if (hero && hero.personality) got.push(`主角${hero.name}立得住`);
    else if (hero) lost.push('主角只写了定位，没写性格');
    else lost.push('没有标出主角');
    const conflict = v.openPromises > 0 || v.characters.some((c) => /反|antagonist/i.test(c.role))
      || CONFLICT_RE.test(v.logline);
    if (conflict) got.push(v.openPromises > 0 ? `未收伏笔 ${v.openPromises} 条` : '有明确的对抗方或未解的债');
    else lost.push('梗概里看不出谁跟谁拧着');
    const score = got.length;
    if (!lost.length) return { score, reason: got.join('，') };
    return { score, reason: `三项里缺了 ${lost.length} 项：${lost.join('；')}`,
      advice: lost[0] === '没有标出主角' ? '人物表里给一个角色标上「主角」，并写清他想要什么、怕什么' : '先把缺的那项补上：' + lost[0] };
  }

  function scoreLength(v) {
    const range = Tension.chapterRange({ format: v.format });
    if (!v.targetWords) {
      return { score: 0, reason: '没填目标字数', advice: '短篇在向导里选投放平台，长篇自己定一个总字数' };
    }
    if (!v.chapters.length) {
      return { score: 0, reason: `目标 ${v.targetWords} 字却一章都没有`, advice: '先出章纲，字数才有落点' };
    }
    const per = Math.round(v.targetWords / v.chapters.length);
    const capped = range[1] != null;
    if (per >= range[0] && (!capped || per <= range[1])) {
      const hint = capped ? `${range[0]}–${range[1]}` : `${range[0]} 字以上`;
      return { score: 3, reason: `${v.chapters.length} 章摊 ${v.targetWords} 字，单章约 ${per} 字，落在 ${hint} 的合理区间` };
    }
    // 短篇那一档不封顶：走到这里只可能是「低于下限」（那一档的章是节，长度跟着总字数与投放平台走）
    const over = capped && per > range[1];
    const outside = over ? per / range[1] : range[0] / per;
    return { score: outside <= 2 ? 2 : 1,
      reason: over ? `单章约 ${per} 字，超出合理区间上限 ${range[1]}` : `单章约 ${per} 字，低于合理区间下限 ${range[0]} 字`,
      advice: over ? '拆细章纲：把一章要做的事分成两三章，每章各留一个钩子' : '合并章纲：现在的章数撑不起这个字数' };
  }

  const DIMS = [
    { id: 'hook', label: '开篇钩子', fn: scoreHook },
    { id: 'diff', label: '题材差异', fn: scoreDiff },
    { id: 'structure', label: '结构完整', fn: scoreStructure },
    { id: 'length', label: '篇幅匹配', fn: scoreLength },
  ];

  /**
   * 出卡。input 可以是向导产出的 concept，也可以是 buildCtx 的结果。
   * @param {{genre?: string, targetWords?: number, others?: Array<string|{title?:string,logline?:string}>}} opts
   *   genre/targetWords 是 concept 里没有、只有界面当场知道的字段；others 用来查撞车，可选。
   */
  function scorePitch(input, opts = {}) {
    const v = viewOf(input);
    const others = Array.isArray(opts.others) ? opts.others : [];
    if (opts.genre && !v.genre) v.genre = String(opts.genre);
    if (opts.targetWords && !v.targetWords) {
      v.targetWords = Number(opts.targetWords) || null;
      if (opts.format) v.format = Tension.formatKey(opts.format);
    }
    const dims = DIMS.map((d) => {
      const r = d.fn(v, others);
      const score = Math.max(0, Math.min(MAX_PER_DIM, Number(r.score) || 0));
      return { id: d.id, label: d.label, score, max: MAX_PER_DIM, reason: r.reason || '', advice: r.advice || '' };
    });
    const total = dims.reduce((s, d) => s + d.score, 0);
    const max = dims.length * MAX_PER_DIM;
    return { version: PACK_VERSION, total, max, verdict: verdictOf(total, max), dims, basis: basisOf(v, others) };
  }

  /**
   * 分档只是话术，任何调用方都不许拿它当门禁。
   * 界面与 CLI 要展示「几分算哪档」，所以这张表也导出 —— 阈值一旦在别处抄第二份，
   * core 改了那边不会跟着改（guards 里有一条盯着）。
   */
  const VERDICTS = [[0.85, '可以动笔'], [0.6, '先改弱项再动笔'], [0, '这个选题还没立住，建议换角度']];

  function verdictOf(total, max) {
    const r = max ? total / max : 0;
    return (VERDICTS.find(([cut]) => r >= cut) || VERDICTS[VERDICTS.length - 1])[1];
  }

  /** 打的是哪几种字、跟谁比过 —— 界面和 CLI 都要原样报出来，不许让作者猜。 */
  function basisOf(v, others) {
    return {
      kind: v.kind, format: v.format,
      chapterCount: v.chapters.length,
      comparedWith: others.length,
      clicheListSize: CLICHE_WORDS.length,
    };
  }

  /** 一张卡的人话渲染：界面与 CLI 共用，两处不会出现两种说法。 */
  function renderLines(result) {
    const lines = [`选题评分 ${result.total}/${result.max} —— ${result.verdict}`];
    for (const d of result.dims) {
      lines.push(`${d.label} ${d.score}/${d.max}${d.reason ? '：' + d.reason : ''}${d.advice ? '（改法：' + d.advice + '）' : ''}`);
    }
    if (result.basis.kind === 'concept') {
      lines.push(`注：套路词表为内置 ${result.basis.clicheListSize} 个手写词条，不是平台榜单数据。`);
    }
    return lines.join('\n');
  }

  return {
    PACK_VERSION, MAX_PER_DIM, CLICHE_WORDS, SIMILAR_CUT, LENGTH_RANGE, LENGTH_LABEL, CONFLICT_RE,
    BODY_MIN_FOR_HOOK, VERDICTS,
    viewOf, similarity, scorePitch, verdictOf, renderLines,
  };
});
