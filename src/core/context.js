/**
 * NovelWeave · 织文 — 写作上下文的唯一实现（UMD：浏览器与 Node 共用）
 *
 * 为什么单独一个文件：Web 点"续写"和 agent 跑 nw-context 必须喂给模型同一批内容。
 * 之前两边各写一遍拼装逻辑，结果 Web 少注入了「状态快照」与「未结线索」两节 ——
 * 作者录进矩阵和伏笔表的事实，在浏览器里根本没进 prompt，一致性只能事后检查。
 *
 * 这里只产出 section 列表；renderDocument() 给 CLI 出 md，renderPrompt() 给 Web 出
 * prompt，两者遍历的是同一批对象，内容不可能再分叉。
 *
 * 依赖：NWText / NWBible / NWStory.loreTrigger（世界书匹配在 story.js，故无环）
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWBible, root.NWStory);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWContext = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, Bible, Story) {
  'use strict';

  const DEFAULTS = {
    contextBytes: 12288,   // 整份派生上下文；汉字 3 字节，12KB ≈ 4000 字
    loreBytes: 4096,
    prevTailChars: 1200,
    currentTailChars: 1500,
  };

  const STATUS_ZH = { deceased: '已死亡', missing: '下落不明', unknown: '状态未知' };

  function characterBlock(list) {
    if (!list.length) return '（无角色）';
    return list.map((c) => {
      const bits = [`- ${c.name}（${c.role}${c.status !== 'alive' ? '，' + (STATUS_ZH[c.status] || c.status) : ''}）`];
      if (c.personality) bits.push(`  性格：${c.personality}`);
      if (c.appearance?.summary) bits.push(`  外貌：${c.appearance.summary}`);
      if (c.goals) bits.push(`  目标：${c.goals}`);
      if (c.status === 'deceased') bits.push(`  ⚠️ 已死亡，只可被提及，不得行动`);
      const toks = (c.appearance?.tokens || []).filter((t) => t.key);
      if (toks.length) {
        bits.push(`  特征区间：${toks.map((t) => `${t.key}${t.since ? `(自 ${t.since}` : ''}${t.until ? `; 至 ${t.until}` : ''}${t.since || t.until ? ')' : ''}`).join('、')}`);
      }
      const als = (c.aliases || []).map((a) => (typeof a === 'string' ? a : a.text)).filter(Boolean);
      if (als.length) bits.push(`  别称：${als.join('、')}`);
      return bits.join('\n');
    }).join('\n');
  }

  /** 出场角色：优先用作者声明，没声明时按名字命中兜底。 */
  function activeCharacters(ctx, current, prev) {
    const declared = new Set([...(current?.characters || []), ...(prev?.characters || [])]);
    const scan = [prev?.body, current?.body].filter(Boolean).join('\n');
    return ctx.characters.filter((c) => {
      if (c.enabled === false) return false;
      if (declared.has(c.id)) return true;
      const forms = [c.name, ...(c.aliases || []).map((a) => (typeof a === 'string' ? a : a.text))];
      return forms.some((f) => (f || '').length >= 2 && scan.includes(f));
    });
  }

  function promiseBlock(promises) {
    const items = promises?.items || [];
    const open = items.filter((i) => i.type === 'promise' && ['planned', 'planted'].includes(i.status));
    const questions = items.filter((i) => i.type === 'question' && i.status === 'open');
    if (!open.length && !questions.length) return '（无未结线索）';
    return [
      ...open.map((i) => `- [${i.weight || 'major'}] ${i.title}｜埋于 ${i.setup?.chapter || '?'}${i.payoff?.due ? `｜期限 ${i.payoff.due}` : ''}｜${i.setup?.evidence || ''}`),
      ...questions.map((i) => `- [悬念] ${i.title}`),
    ].join('\n');
  }

  const RECAP_ITEMS = 12;
  const RECAP_CHARS = 80;

  /** 摘要若是 buildSummarizePrompt 的四行结构，只取「核心事件」：位置/伤势/持有物
   *  由「分章状态快照」承载，伏笔由「未结线索」承载。12 章各 200 字会挤爆整份预算。 */
  function recapLine(summary) {
    const raw = String(summary).trim();
    const m = raw.match(/核心事件[:：][ \t]*([^\n]+)/);
    const text = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
    return text.length > RECAP_CHARS ? text.slice(0, RECAP_CHARS) + '…' : text;
  }

  /** 前情摘要：目标章之前、最近 12 章的 summary。更早的章由摘要本身承载。 */
  function recapBlock(chapters, current) {
    const upto = current ? chapters.findIndex((c) => c.id === current.id) : chapters.length;
    const withSummary = chapters.slice(0, Math.max(0, upto)).filter((c) => (c.summary || '').trim());
    if (!withSummary.length) return '（各章摘要尚未填写 —— 长篇里它替代"回读全文"）';
    const shown = withSummary.slice(-RECAP_ITEMS);
    const lines = shown.map((c) => `- ${Bible.chapterLabel(c)}：${recapLine(c.summary)}`);
    const folded = withSummary.length - shown.length;
    if (folded > 0) lines.unshift(`（更早 ${folded} 章的摘要未列出，需要时回读原章）`);
    return lines.join('\n');
  }

  function stateBlock(states, prev, characters = []) {
    const snap = prev ? states?.byChapter?.[prev.id] : null;
    if (!snap) return `（${prev ? prev.id + ' 没有状态快照' : '无上一章，无需快照'}）`;
    return Object.entries(snap).map(([id, dims]) => {
      const c = characters.find((x) => x.id === id);
      const fmt = (v) => Array.isArray(v) ? (v.join('/') || '无') : (v || '无');
      return `- ${c?.name || id}：位置 ${fmt(dims.loc)}｜状态 ${fmt(dims.alive)}｜伤 ${fmt(dims.injury)}｜持 ${fmt(dims.items)}｜已知 ${fmt(dims.knows)}｜目标 ${fmt(dims.goal)}`;
    }).join('\n');
  }

  /**
   * @param ctx  Story-Bible 形状（NWStory.buildCtx 或 CLI loadBook 的产物）
   * @param opts { chapterId: 'ch-003' | 'next', budget }
   */
  function buildSections(ctx, opts = {}) {
    const b = Object.assign({}, DEFAULTS, opts.budget);
    const chapters = ctx.chapters || [];
    const wantNext = !opts.chapterId || opts.chapterId === 'next';
    const current = wantNext ? null : chapters.find((c) => c.id === opts.chapterId) || null;
    // 找不到就直接说找不到：往下走会在 current.id 上抛裸 TypeError，
    // 而 CLI 那边只会显示成一句看不出原因的堆栈。
    if (!wantNext && !current) throw new Error(`章节「${opts.chapterId}」不在本书中（共 ${chapters.length} 章）`);
    const idx = wantNext ? chapters.length - 1 : chapters.findIndex((c) => c.id === current.id);
    // 'next' 时上一章就是最后一章；指定章节时 prev 是它的前一本，不是它自己
    const prev = wantNext ? (chapters[idx] || null) : (chapters[idx - 1] || null);

    const chars = activeCharacters(ctx, current, prev);
    const scanText = [prev?.body, current?.body].filter(Boolean).join('\n');
    const lore = Story.loreTrigger(scanText, ctx.world, { loreBytes: b.loreBytes });

    const hasBody = !!(current?.body || '').trim();
    const tail = (text, n) => '…' + String(text).slice(-n);

    const core = [
      { name: '书目', text: [
        `# ${ctx.book.title}`,
        `类型：${ctx.book.genre || ''}`,
        ctx.book.description ? `概述：${ctx.book.description}` : '',
        ctx.book.voice?.person ? `人称：${ctx.book.voice.person}` : '',
        ctx.book.voice?.notes ? `笔法：${ctx.book.voice.notes}` : '',
      ].filter(Boolean).join('\n') },
      { name: '出场角色', text: characterBlock(chars) },
      { name: '分章状态快照', text: stateBlock(ctx.states, prev, ctx.characters) },
      { name: '未结线索', text: promiseBlock(ctx.promises) },
      { name: '前情摘要', text: recapBlock(chapters, current) },
      { name: '相关世界设定', text: lore.entries.length
        ? lore.entries.map((e) => `- ${e.name}：${e.content}`).join('\n') : '（未触发任何世界条目）' },
    ];

    // 接着写已有正文时，"本章已写"比"上章尾部"更重要 —— 顺序按此排，
    // 否则预算一紧被裁掉的恰好是最需要的那部分（旧实现固定把本章排最后）
    const tails = hasBody
      ? [{ name: '本章已有正文', text: `【《${current.title}》已写正文】\n${tail(current.body, b.currentTailChars)}\n请从上面正文的末尾接着写下去，不要重复已有内容。` },
         prev ? { name: '上章尾部', text: `【上一章《${prev.title}》结尾】\n${tail(prev.body, b.prevTailChars)}` } : null]
      : [prev ? { name: '上章尾部', text: `【上一章《${prev.title}》结尾】\n${tail(prev.body, b.prevTailChars)}` } : null,
         { name: '本章', text: `本章《${current?.title || opts.nextTitle || '下一章'}》尚未开始，请接着上一章写。` }];

    const ordered = [...core, ...tails.filter(Boolean)];

    // 按字节预算裁切，且如实记录被裁掉的节
    const kept = [], dropped = [];
    let used = 0;
    for (const sec of ordered) {
      const block = `## ${sec.name}\n${sec.text}`;
      const bytes = T.bytesOf(block);
      const cost = bytes + (kept.length ? 2 : 0);
      if (used + cost > b.contextBytes) { dropped.push({ name: sec.name, bytes }); continue; }
      used += cost;
      kept.push({ ...sec, block, bytes });
    }

    return {
      sections: kept,
      current, prev,
      usage: {
        bytes: used,
        budgetBytes: b.contextBytes,
        // 被裁掉的节也要出现在这里（present:false），界面才能说清"这节没进 prompt"
        sections: ordered.map((s) => ({
          name: s.name,
          present: kept.some((k) => k.name === s.name),
          bytes: T.bytesOf(`## ${s.name}\n${s.text}`),
          ...(s.name === '相关世界设定' ? { included: lore.entries.map((e) => e.name) } : {}),
        })),
        loreIncluded: lore.entries.map((e) => e.name),
        loreDropped: lore.dropped,
        hasPrevChapter: !!prev?.body,
        hasCurrentBody: hasBody,
        droppedSections: dropped,
        truncated: dropped.length > 0 || lore.dropped.length > 0,
      },
    };
  }

  /** CLI 用：派生上下文文档 */
  function renderDocument({ sections }) {
    return `<!-- NovelWeave 派生上下文，勿手改；权威数据在 book.json / bible/ / manuscript/ -->\n\n`
      + sections.map((s) => s.block).join('\n\n') + '\n';
  }

  /** Web 用：拼成 prompt 正文。与 renderDocument 遍历同一批 section。 */
  function renderPrompt({ sections }, extra = '') {
    return sections.map((s) => s.block).join('\n\n') + (extra ? `\n\n${extra}` : '');
  }

  return { buildSections, renderDocument, renderPrompt, DEFAULTS, characterBlock, promiseBlock, recapBlock, stateBlock, activeCharacters };
});
