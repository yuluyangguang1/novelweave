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
    styleBytes: 1600,      // 风格样例的软预算；opts.style 开启后才参与
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

  const RECAP_ITEMS = 12;   // 长篇的细摘要窗口；短篇（format:short）不封顶，见 recapBlock
  const RECAP_MID = 24;     // 细摘要之外再往前的"章名层"数量
  const RECAP_CHARS = 80;

  /** 摘要若是 buildSummarizePrompt 的四行结构，只取「核心事件」：位置/伤势/持有物
   *  由「分章状态快照」承载，伏笔由「未结线索」承载。12 章各 200 字会挤爆整份预算。 */
  function recapLine(summary) {
    const raw = String(summary).trim();
    const m = raw.match(/核心事件[:：][ \t]*([^\n]+)/);
    const text = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
    return text.length > RECAP_CHARS ? text.slice(0, RECAP_CHARS) + '…' : text;
  }

  /** 前情摘要：目标章之前的 summary，长篇做三级衰减，不再硬切"更早 N 章未列出"：
   *  - 最近 12 章：核心事件行（80 字）
   *  - 再往前 24 章：章名一行列出（网文章名通常自带事件，成本极低）
   *  - 更早：只报数量（章节名列表超长时也折叠）
   *  短篇（cap=Infinity）体量小，全量细摘要 —— 连"回读"都省了。
   *  语义检索上线前的过渡方案：把"完全召回不了"变成"至少锚点可见"。 */
  function recapBlock(chapters, current, cap = RECAP_ITEMS) {
    const upto = current ? chapters.findIndex((c) => c.id === current.id) : chapters.length;
    const withSummary = chapters.slice(0, Math.max(0, upto)).filter((c) => (c.summary || '').trim());
    if (!withSummary.length) return '（各章摘要尚未填写 —— 长篇里它替代"回读全文"）';
    const fullLine = (c) => `- ${Bible.chapterLabel(c)}：${recapLine(c.summary)}`;
    if (cap === Infinity) return withSummary.map(fullLine).join('\n');

    const recent = withSummary.slice(-cap);
    const rest = withSummary.slice(0, withSummary.length - recent.length);
    const lines = recent.map(fullLine);
    const mid = rest.slice(-RECAP_MID);
    if (mid.length) {
      let titles = mid.map((c) => Bible.chapterLabel(c)).join('、');
      if (titles.length > 420) titles = titles.slice(0, 420) + '…';
      lines.unshift(`（更早 ${mid.length} 章：${titles}）`);
    }
    const older = rest.length - mid.length;
    if (older > 0) lines.unshift(`（更早 ${older} 章，需要时回读原章）`);
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

  // ═══════════════ 硬禁令：违反即为连续性事故的事实，生成前钉在最前 ═══════════════
  // 与「出场角色」「未结线索」不同，这一节不是给模型参考的资料，而是约束。
  // 所以它排在第一节，预算再紧也先保它 —— 事后机检能抓到越界，但那一轮改写的
  // 成本比一开始就别说错要高得多。

  function hardBanBlock(ctx, chapters, targetN) {
    const lines = [];
    const dead = (ctx.characters || []).filter((c) => c.status === 'deceased' && c.enabled !== false);
    if (dead.length) {
      lines.push('- 已死亡角色，本章不得让其行动或开口，只可作为回忆/提及：'
        + dead.map((c) => `${c.name}${c['died-in'] ? `（卒于 ${c['died-in']}）` : ''}`).join('、'));
    }
    const items = ctx.promises?.items || [];
    const due = items.filter((i) => {
      if (i.type !== 'promise' || i.status !== 'planted' || !i.payoff?.due) return false;
      const dueCh = chapters.find((c) => c.id === i.payoff.due);
      return dueCh && targetN != null && (dueCh.number ?? dueCh.order) <= targetN;
    });
    if (due.length) {
      lines.push('- 以下伏笔已到回收期限，本章应收束或明确写出推迟理由：'
        + due.map((i) => `${i.title}（埋于 ${i.setup?.chapter || '?'}，期限 ${i.payoff.due}）`).join('、'));
    }
    return lines.length ? lines.join('\n') : null;
  }

  // ═══════════════ 风格样例：模仿作者自己的笔法，而不是模板文 ═══════════════
  // 从目标章之前、正文足量的最近章节取中段节选 —— 中段是叙述稳定区，
  // 开头常带承接、结尾常带钩子，都不代表作者的日常笔触。
  // 只在 opts.style 开启时参与；预算再紧也只裁它自己，不动其他节。

  const STYLE_MIN_BODY = 600;
  const STYLE_EXCERPT = 400;

  function pickStyleExemplars(chapters, current) {
    const upto = current ? chapters.findIndex((c) => c.id === current.id) : chapters.length;
    const pool = chapters.slice(0, Math.max(0, upto))
      .filter((c) => (c.body || '').trim().length >= STYLE_MIN_BODY);
    return pool.slice(-2).map((c) => {
      const body = c.body.trim();
      const start = Math.floor(body.length * 0.3);
      let excerpt = body.slice(start, start + STYLE_EXCERPT);
      if (start + STYLE_EXCERPT < body.length) excerpt += '…';
      return { id: c.id, label: Bible.chapterLabel(c), excerpt };
    });
  }

  function styleBlock(exemplars) {
    if (!exemplars.length) return null;
    return '【模仿以下段落的句长、叙述节奏与用词密度——只学笔法，不得复述其中情节】\n'
      + exemplars.map((e) => `（${e.label}）${e.excerpt}`).join('\n———\n');
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
    // 短篇换挡：体量小（几千至三万字），前情摘要全量列出，不做滚动窗口
    const isShort = ctx.book?.format === 'short';

    const hasBody = !!(current?.body || '').trim();
    const tail = (text, n) => '…' + String(text).slice(-n);

    // 硬禁令的"到期"以目标章为准：续写下一章时，期限 ≤ 最后一章即视为已到期
    const targetN = current
      ? (current.number ?? current.order)
      : (chapters.length ? (chapters[chapters.length - 1].number ?? chapters[chapters.length - 1].order) : null);
    const banText = hardBanBlock(ctx, chapters, targetN);

    const useStyle = !!opts.style;
    const exemplars = useStyle ? pickStyleExemplars(chapters, current) : [];
    const styleText = styleBlock(exemplars);

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
      { name: '前情摘要', text: recapBlock(chapters, current, isShort ? Infinity : RECAP_ITEMS) },
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

    // 硬禁令排第一节：它是约束不是资料，预算再紧也最后才轮到它被裁。
    // 风格样例是软上下文，排最末 —— 预算一紧第一个被裁的应该是它。
    const ordered = [
      ...(banText ? [{ name: '硬禁令', text: banText }] : []),
      ...core,
      ...tails.filter(Boolean),
      ...(styleText ? [{ name: '风格样例', text: styleText }] : []),
    ];

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
          ...(s.name === '风格样例' ? { included: exemplars.map((e) => e.label) } : {}),
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

  return { buildSections, renderDocument, renderPrompt, DEFAULTS, characterBlock, promiseBlock, recapBlock, stateBlock, activeCharacters, hardBanBlock, pickStyleExemplars, styleBlock };
});
