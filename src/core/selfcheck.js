/**
 * NovelWeave · 织文 — 生成后自检（UMD：浏览器与 Node 共用）
 *
 * 定位：AI 续写/润色的草稿先在内存里过一遍机器规则，error/warn 的诊断
 * 转成"修订指令"再喂回模型自修一轮，最终连同诊断一起交给作者。
 * 它不裁决文笔，也不改作者已定稿的任何内容 —— 输入是草稿，输出是诊断与修订 prompt。
 *
 * 三个刻意决定：
 * - schema 校验关掉（ctx.schema = null）：草稿是内存对象，库里既有数据在保存时
 *   已经校验过；草稿章（next 模式）没有 meta，留着 schema 只会产出一堆与
 *   草稿质量无关的结构噪音。结构校验的职责在保存与导出时的 nw-validate。
 * - 自检跑两遍取基线：先对"没有草稿的书"跑一遍规则，只有基线里没有的
 *   新诊断才算草稿的账 —— 书里本来就有的陈年问题（比如一条早该回收的
 *   伏笔）不该触发这一章的自修轮，那是作者在连续性面板里另行处理的事。
 * - info 不算 actionable：R17 这类提示不该触发一整轮自修补写，那是在烧
 *   用户的 API 额度去修一条"机器看不出钩子"。
 */
(function (root, factory) {
  const mod = factory(root.NWRules);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWSelfCheck = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (NWRules) {
  'use strict';

  function actionable(diags) {
    return (diags || []).filter((d) => !d.suppressedBy && (d.severity === 'error' || d.severity === 'warn'));
  }

  /**
   * @param ctx  装配好的书（NWStory.buildCtx / scripts/lib loadBook 产物）
   * @param opts {
   *   chapterId: 'ch-003' | 'next'   —— 草稿归属：改写既有章，还是接着最后一章往下写
   *   draft:      草稿正文
   *   nextTitle?: 草稿章标题（next 模式的临时章名，只存在于预览 ctx 里）
   *   only?:      规则名白名单（默认跑全部连续性规则）
   * }
   * @returns { diags, actionable, draftChapterId, baseline }
   *   diags      —— 塞入草稿后的全书诊断（如实保留，界面可展示）
   *   actionable —— 草稿引入的新问题（error/warn、未被豁免、基线外），自修轮只修这些
   *   baseline   —— 基线诊断的指纹列表（排查用）
   */
  function runSelfCheck(ctx, opts = {}) {
    const draft = String(opts.draft || '');
    if (!draft.trim()) return { diags: [], actionable: [], draftChapterId: null, baseline: [] };
    const chapters = ctx.chapters || [];
    const target = opts.chapterId && opts.chapterId !== 'next'
      ? chapters.find((c) => c.id === opts.chapterId) : null;
    const last = chapters[chapters.length - 1];
    const nextNum = (last?.number ?? last?.order ?? 0) + 1;
    const draftChapter = target
      ? { ...target, body: draft }
      : {
          id: 'ch-draft', number: nextNum, order: nextNum,
          title: opts.nextTitle || '草稿',
          flags: [], characters: [], mentions: [], locations: [],
          body: draft,
        };
    const preview = {
      ...ctx,
      schema: null,
      chapters: target
        ? chapters.map((c) => (c.id === target.id ? draftChapter : c))
        : [...chapters, draftChapter],
    };
    const only = { only: opts.only };
    const baseline = new Set(
      NWRules.runRules({ ...ctx, schema: null }, only).map((d) => d.fingerprint),
    );
    const diags = NWRules.runRules(preview, only);
    return {
      diags,
      actionable: actionable(diags).filter((d) => !baseline.has(d.fingerprint)),
      draftChapterId: draftChapter.id,
      baseline: [...baseline],
    };
  }

  /** 修订 prompt：把机检诊断变成可执行的改写指令。只做消除矛盾的最小改动，不重写全文。 */
  function buildRevisePrompt(draft, diags) {
    const list = (diags || []).map((d, i) =>
      `${i + 1}. [${d.rule}] ${d.message}${d.suggestion ? `（建议：${d.suggestion}）` : ''}`,
    ).join('\n');
    return `下面是一章小说草稿，以及机器连续性检查发现的问题。

【问题清单】
${list}

【修改要求】
- 只针对上述问题做最小改动：调整或删改相关句子，使矛盾消除
- 不得改动其他情节、对白信息量与叙事顺序
- 保持字数大致不变
- 只输出修改后的完整正文，不要任何解释

【草稿】
${String(draft || '').slice(0, 8000)}`;
  }

  return { runSelfCheck, buildRevisePrompt, actionable };
});
