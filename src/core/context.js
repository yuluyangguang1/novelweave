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
 *        + NWStyleFit / NWStylePack（风格样例那一节的指纹与本书禁词包）
 *        + NWVolume（前情摘要的卷级分层，口径只写在 volumes.js）
 *        + NWRelationGraph（活跃关系那一节，判据只写在 relationgraph.js）
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWBible, root.NWStory, root.NWStyleFit, root.NWStylePack,
    root.NWVolume, root.NWRelationGraph);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWContext = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, Bible, Story, StyleFit, StylePack, Vol, Rel) {
  'use strict';

  const DEFAULTS = {
    contextBytes: 12288,   // 整份派生上下文；汉字 3 字节，12KB ≈ 4000 字
    loreBytes: 4096,
    prevTailChars: 1200,
    currentTailChars: 1500,
    // 风格样例的软预算；opts.style 开启后才参与。1600 是 2026-09-24 之前的旧值，
    // 那个数字从来没被任何人读过（两章 400 字的节选实际约 2900 字节），
    // 现在它真的参与收样了，就按真实产出量重设 —— 写一个没人读的常量比不写更糟。
    styleBytes: 3000,
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

  /** 出场角色：优先用作者声明，没声明时按名字命中兜底。
   *  扫描面含本章摘要 —— 空章节（待生成）还没正文，拍点摘要就是它的人物声明。 */
  function activeCharacters(ctx, current, prev) {
    const declared = new Set([...(current?.characters || []), ...(prev?.characters || [])]);
    const scan = [prev?.body, current?.body, current?.summary].filter(Boolean).join('\n');
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

  // 值在 volumes.js：rules.js 算「还剩几章没人盖」时要同一个数，而它排在 context.js 之前、
  // 够不着这份文件。数字写第二处就会有两处对不上 —— 这两个名字只是别名。
  const RECAP_ITEMS = Vol.RECAP_FINE;   // 长篇的细摘要窗口；短篇（format:short）不封顶，见 recapBlock
  const RECAP_MID = Vol.RECAP_MID;      // 细摘要之外再往前的"章名层"数量
  const RECAP_CHARS = 80;

  /** 摘要若是 buildSummarizePrompt 的四行结构，只取「核心事件」：位置/伤势/持有物
   *  由「分章状态快照」承载，伏笔由「未结线索」承载。12 章各 200 字会挤爆整份预算。 */
  function recapLine(summary) {
    const raw = String(summary).trim();
    const m = raw.match(/核心事件[:：][ \t]*([^\n]+)/);
    const text = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
    return text.length > RECAP_CHARS ? text.slice(0, RECAP_CHARS) + '…' : text;
  }

  /**
   * 前情摘要：目标章之前的 summary，长篇做三级衰减 + 卷级压缩，不再硬切"更早 N 章未列出"：
   *  - 最近 12 章：核心事件行（80 字）
   *  - 再往前 24 章：章名一行列出（网文章名通常自带事件，成本极低）
   *  - 更早：建了卷的书改出一行行卷摘要（一卷一行，替掉几十章的逐章出场）；
   *          卷没盖住的章照旧降级，并且如实说清为什么没压上
   *  短篇（cap=Infinity）体量小，全量细摘要 —— 连"回读"都省了。
   *  语义检索上线前的过渡方案：把"完全召回不了"变成"至少锚点可见"。
   *
   * 分层本身一律交给 NWVolume.recapPlan：口径写两遍就会有两遍对不上，
   * 而 rules.js 和侧栏面板问的也是这一份。返回 plan 是给 usage 报层数用的。
   */
  function recapText(chapters, current, cap = RECAP_ITEMS, volumes = []) {
    const upto = current ? chapters.findIndex((c) => c.id === current.id) : chapters.length;
    const withSummary = chapters.slice(0, Math.max(0, upto)).filter((c) => (c.summary || '').trim());
    if (!withSummary.length) {
      return { text: '（各章摘要尚未填写 —— 长篇里它替代"回读全文"）', plan: null };
    }
    const fullLine = (c) => `- ${Bible.chapterLabel(c)}：${recapLine(c.summary)}`;
    // 短篇全量注入，卷层没有意义（那一段本来就是零），所以不喂卷
    const plan = Vol.recapPlan({
      chapters, currentId: current?.id || null,
      volumes: cap === Infinity ? [] : (volumes || []), fine: cap, mid: RECAP_MID,
    });
    const lines = [];
    const notice = Vol.gapNotice(plan);
    if (notice) lines.push(`（卷级压缩的缺口：${notice}）`);
    if (plan.uncovered.length) lines.push(`（更早 ${plan.uncovered.length} 章，需要时回读原章）`);
    const fold = Vol.foldedText(plan.folded);
    if (fold) lines.push(fold);
    for (const s of plan.volumes) lines.push(Vol.lineOf(s, plan.chapters));
    if (plan.titles.length) {
      let titles = plan.titles.map((c) => Bible.chapterLabel(c)).join('、');
      if (titles.length > 420) titles = titles.slice(0, 420) + '…';
      lines.push(`（更早 ${plan.titles.length} 章：${titles}）`);
    }
    lines.push(...plan.fine.map(fullLine));
    return { text: lines.join('\n'), plan };
  }

  function recapBlock(chapters, current, cap = RECAP_ITEMS, volumes = []) {
    return recapText(chapters, current, cap, volumes).text;
  }

  /**
   * 分层计划的唯一对外入口：侧栏「卷」面板与 R33 要知道「这一卷到底盖没盖住」，
   * 用的必须是同一批窗口常量。窗口在界面里再抄一遍字面量，两边就会从此对不上。
   */
  function recapPlanOf(ctx, currentId = null) {
    const isShort = ctx.book?.format === 'short';
    return Vol.recapPlan({
      chapters: ctx.chapters || [], currentId,
      volumes: isShort ? [] : (ctx.volumes || []),
      fine: RECAP_ITEMS, mid: RECAP_MID,
    });
  }

  // ═══════════════ 相关旧章：按出场分量召回滚动窗口之外的历史章节 ═══════════════
  // 章名锚点解决"忘了吗"，这里解决"要写重逢，第 5 章他们怎么认识的"——
  // 本章出场角色在各旧章正文中被提及的次数就是相关度，纯词频、无模型、无索引。
  // 只召回细摘要窗口之外的章（窗口内的已在"前情摘要"里）；短篇全量注入，不走这里。

  const RELATED_CAP = 3;
  const RELATED_SNIPPET = 60;

  function nameHits(body, forms) {
    let n = 0;
    for (const f of forms) {
      if (!f || f.length < 2) continue;
      n += body.split(f).length - 1;
    }
    return n;
  }

  function relatedPastChapters(ctx, current, prev, cast, embedHits) {
    if (!cast.length) return [];
    const chapters = ctx.chapters || [];
    const upto = current ? chapters.findIndex((c) => c.id === current.id) : chapters.length;
    const older = chapters.slice(0, Math.max(0, upto - RECAP_ITEMS)) // 细摘要窗口内的不算"旧"
      .filter((c) => c.id !== prev?.id && (c.body || '').length > 50);
    if (embedHits && embedHits.length) {
      return embedHits.map((h) => ({ id: h.chapterId, label: Bible.chapterLabel(chapters.find((x) => x.id === h.chapterId) || { number: '?', title: h.chapterTitle }), score: h.score, who: ['语义'], snippet: (h.text || '').slice(0, RELATED_SNIPPET) }));
    }
    const scored = older.map((c) => {
      let score = 0;
      const who = [];
      for (const ch of cast) {
        const forms = [ch.name, ...(ch.aliases || []).map((a) => (typeof a === 'string' ? a : a.text))]
          .filter((f) => (f || '').length >= 2);
        const hits = nameHits(c.body || '', forms);
        if (hits > 0) { score += hits; who.push(ch.name); }
      }
      return { chapter: c, score, who };
    }).filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, RELATED_CAP);
    return scored.map(({ chapter, score, who }) => {
      const summary = (chapter.summary || '').replace(/\s+/g, ' ');
      const snippet = summary.length > RELATED_SNIPPET ? summary.slice(0, RELATED_SNIPPET) + '…' : summary;
      return { id: chapter.id, label: Bible.chapterLabel(chapter), score, who, snippet };
    });
  }

  function relatedBlock(related) {
    if (!related.length) return null;
    return '【与本章人物相关的旧章 —— 涉及同一角色的往事，避免写重或写矛盾】\n'
      + related.map((r) => `- ${r.label}（与${r.who.join('、')}相关）：${r.snippet || '（该章摘要未填）'}`).join('\n');
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

  // ═══════════════ 活跃关系:登记的关系边约束续写中的称谓与互动 ═══════════════
  // 只列与本章出场角色相关的边。称谓(address)是 R19 的检查依据，写之前让模型看到，
  // 比写完再报 R19 便宜。
  //
  // 「哪条边还活着」一律问 NWRelationGraph —— 侧栏那张图、检查器 R15/R31/R34 与这里的 prompt
  // 用的是同一份判据。这一句从前是自己算的，而且算反了：`if (e.until) return false`
  // 把「到第 20 章结束」读成「永远不再约束」，于是决裂之后两人再没被同框约束过；
  // 端点存的是角色名的那些老边（AI 抽关系从前存的正是名字）也被这一句顺手丢掉。
  // 区间读不出来的边照样列：那条关系是真的，只是起止章被删了 —— 从 prompt 里删掉它
  // 等于让模型忘掉一段还在成立的事实，而修账本是作者的事（R15 已经在报它了）。

  function relationBlock(ctx, chars, cut) {
    const edges = ctx.relations?.edges || [];
    if (!edges.length || !chars.length) return null;
    const g = Rel.build({
      characters: ctx.characters || [], edges, chapters: ctx.chapters || [], cut: cut ?? null,
    });
    const lines = Rel.activeLines(g, new Set(chars.map((c) => c.id)), ctx.chapters || []);
    return lines.length ? lines.join('\n') : null;
  }

  // ═══════════════ 信息差账本:未揭的秘密是硬约束,到期的是任务 ═══════════════
  // R20 是事后机检；这一节让它变成事前约束 —— 模型写之前就该知道「玄冰令」不能在这一章点破。
  // 只喂账本里真登记过的排期，没登记的不猜（宁缺勿错，错一次模型就学会无视这一节）。
  const SECRET_LINES = 8;

  function secretLines(ctx, chapters, targetN) {
    const rows = (ctx.secrets || []).filter((s) => s && s.enabled !== false && String(s.term || '').trim());
    if (!rows.length || targetN == null) return [];
    const num = (id) => {
      const c = chapters.find((x) => x.id === id);
      return c ? (c.number ?? c.order) : ctx.chapterNumbers?.get(id);
    };
    const byId = new Map((ctx.characters || []).map((c) => [c.id, c.name]));
    const cut = (t, n = 60) => {
      const s = String(t || '').replace(/\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) + '…' : s;
    };
    const hide = [], hint = [], due = [];
    for (const s of rows) {
      if (s.revealed_at) continue; // 已经写出来了，不再约束
      const planN = s.reveal_chapter ? num(s.reveal_chapter) : null;
      if (planN == null || planN < targetN) continue; // 无排期交给 R20 催；排期已过不约束当下
      const firstN = s.first_chapter ? num(s.first_chapter) : null;
      const truth = cut(s.truth);
      const tail = `${truth ? `：${truth}` : ''}${(s.informed || []).length
        ? `（已知情：${s.informed.slice(0, 6).map((id) => byId.get(id) || id).join('、')}）` : ''}`;
      if (planN === targetN) due.push(`「${s.term}」是本章的计划揭示内容，可以正面写出来${tail}`);
      else if (firstN != null && targetN >= firstN) hint.push(`「${s.term}」本章只能铺垫、不可点破（揭示排在第 ${planN} 章）${tail}`);
      else hide.push(`「${s.term}」不得点破（揭示排在第 ${planN} 章）${tail}`);
    }
    const ordered = [...hide, ...due, ...hint];
    if (!ordered.length) return [];
    const shown = ordered.slice(0, SECRET_LINES).map((t) => `  · ${t}`);
    if (ordered.length > SECRET_LINES) shown.push(`  · …另有 ${ordered.length - SECRET_LINES} 条信息差登记未列出`);
    return ['- 信息差账本（以作者登记的揭示排期为准，与本节冲突的写法一律算剧透）：', ...shown];
  }

  function hardBanBlock(ctx, chapters, targetN, current) {
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
    // 信息控制(悬念字段):目标章的 mustHide/onlyHint 是硬约束
    const target = current || chapters[chapters.length - 1];
    const ic = target?.infoControl;
    if (ic) {
      if (ic.mustHide) lines.push(`- 【必须隐瞒】本章不得揭示：${ic.mustHide}`);
      if (ic.onlyHint) lines.push(`- 【只能暗示】本章可暗示但不可点破：${ic.onlyHint}`);
    }
    lines.push(...secretLines(ctx, chapters, targetN));
    return lines.length ? lines.join('\n') : null;
  }

  // ═══════════════ 创作决策:为什么走到今天,写作时要尊重这些决定 ═══════════════
  // 只列未推翻的;已推翻(supersededBy)的历史决策不约束当下。

  function decisionBlock(ctx) {
    const decisions = (ctx.decisions || []).filter((d) => d.title && !d.supersededBy);
    if (!decisions.length) return null;
    return decisions.slice(0, 8).map((d) => {
      const risk = d.risk ? `（风险：${d.risk}）` : '';
      return `- ${d.title}：${d.reason}${risk}`;
    }).join('\n');
  }

  // ═══════════════ 风格样例：模仿作者自己的笔法，而不是模板文 ═══════════════
  // 默认从目标章之前、正文足量的最近章节取中段节选 —— 中段是叙述稳定区，
  // 开头常带承接、结尾常带钩子，都不代表作者的日常笔触。
  // 作者也可以在「文体规则」页勾定基准章（book.styleAnchor）：长篇写到 60 章时，
  // 「最近两章」恰好是漂移最远的那两章，用它当样例等于把漂移当标准。勾了就以勾的为准，
  // 位置不限（第 1 章回填的锚点也认）。
  // 只在 opts.style 开启时参与；预算再紧也只裁它自己，不动其他节。

  const STYLE_EXCERPT = 400;      // 单个节选的字数上限
  const STYLE_MIN_CHARS = 120;    // 再往下压就不成样例了，宁可如实超预算
  const STYLE_MAX = 2;            // 一次最多注入几章

  function anchorIds(book) {
    const ids = book && book.styleAnchor && book.styleAnchor.chapterIds;
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [];
  }

  /** 够格进样例的章：正文够不够长只问 stylefit 那一份判据（与指纹同一个口径）。 */
  function eligible(chapters, current) {
    const upto = current ? chapters.findIndex((c) => c.id === current.id) : chapters.length;
    return chapters.slice(0, Math.max(0, upto)).filter(isEligible);
  }

  function isEligible(c) {
    // 读不到 stylefit 时（模块没加载全）退回字符数兜底，判据仍写在 stylefit 里，界面上不许再抄一份。
    return StyleFit && StyleFit.qualifies ? StyleFit.qualifies(c?.body)
      : String(c?.body || '').trim().length >= 600;
  }

  /**
   * 选基准章 → 定注入量。返回 { source, list }：
   * source 是 'anchor'（作者勾的）/ 'auto'（就近取）/ 'anchor-lost'（勾了但都不合格，已退回 auto）。
   */
  function stylePool(chapters, current, book) {
    const wanted = anchorIds(book);
    if (!wanted.length) return { source: 'auto', list: eligible(chapters, current) };
    const picked = chapters.filter((c) => wanted.includes(c.id));
    const usable = picked.filter(isEligible);
    if (!usable.length) return { source: 'anchor-lost', list: eligible(chapters, current) };
    return { source: 'anchor', list: usable };
  }

  function excerptOf(c, chars) {
    const body = String(c.body).trim();
    const start = Math.floor(body.length * 0.3);
    let excerpt = body.slice(start, start + chars);
    if (start + chars < body.length) excerpt += '…';
    return { id: c.id, label: Bible.chapterLabel(c), excerpt };
  }

  /**
   * styleBytes 是软上限：先按「丢较远的那一章」收，收到只剩一章还超，就缩节选字数，
   * 缩到 STYLE_MIN_CHARS 仍超就如实带着超预算走 —— 压成碎片比超预算更没用。
   */
  function fitExcerpts(list, budgetBytes) {
    let items = list.slice(-STYLE_MAX);
    let chars = STYLE_EXCERPT;
    for (;;) {
      const ex = items.map((c) => excerptOf(c, chars));
      if (!ex.length || T.bytesOf(styleBlock(ex)) <= budgetBytes) return ex;
      if (items.length > 1) { items = items.slice(1); continue; }
      if (chars <= STYLE_MIN_CHARS) return ex;
      chars = Math.max(STYLE_MIN_CHARS, chars - 40);
    }
  }

  /**
   * 选基准章 → 按预算收样 → 用**实际注入了的那几章**算指纹。
   * 顺序不能反过来：先算指纹再收样，就会出现「样例只剩一章、那一行却说 2 章 / 1746 字」
   * —— 数字描述不到作者眼前读到的东西，这行就只是装饰。
   * 指纹行自己也要占预算，所以先扣一个固定余量再收样。
   */
  const FIT_LINE_RESERVE = 300;

  function pickStyleExemplars(chapters, current, book, budgetBytes) {
    const pool = stylePool(chapters, current, book);
    const items = fitExcerpts(pool.list, budgetBytes - FIT_LINE_RESERVE);
    const basis = pool.list.filter((c) => items.some((e) => e.id === c.id));
    const fitLine = StyleFit ? StyleFit.lines(StyleFit.fingerprint(basis, styleOpts(book))) : '';
    return { source: pool.source, fitLine, list: items };
  }

  /** 禁词密度那一格要按作者自己的包算：他整包关掉时不许还报密度。 */
  function styleOpts(book) {
    return StylePack && book ? StylePack.optsFrom(book) : {};
  }

  function styleBlock(exemplars, fitLine) {
    if (!exemplars.length) return null;
    const head = '【模仿以下段落的句长、叙述节奏与用词密度——只学笔法，不得复述其中情节】'
      + (fitLine ? `\n${fitLine}` : '');
    return head + '\n' + exemplars.map((e) => `（${e.label}）${e.excerpt}`).join('\n———\n');
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
    const related = isShort ? [] : relatedPastChapters(ctx, current, prev, chars, opts.embedHits);

    const hasBody = !!(current?.body || '').trim();
    const tail = (text, n) => '…' + String(text).slice(-n);

    // 硬禁令的"到期"以目标章为准：续写下一章时，期限 ≤ 最后一章即视为已到期
    const targetN = current
      ? (current.number ?? current.order)
      : (chapters.length ? (chapters[chapters.length - 1].number ?? chapters[chapters.length - 1].order) : null);
    const banText = hardBanBlock(ctx, chapters, targetN, current);
    // 关系的「活着」看的是**目标章**：写第 3 章时，到第 3 章结束的关系还在约束这一章
    // （那一章正是决裂本身）；续写下一章 = 排到全书末尾之后。
    const relText = relationBlock(ctx, chars, wantNext ? chapters.length : idx);

    const useStyle = !!opts.style;
    const stylePick = useStyle
      ? pickStyleExemplars(chapters, current, ctx.book, b.styleBytes)
      : { source: null, fitLine: '', list: [] };
    const exemplars = stylePick.list;
    const styleText = styleBlock(exemplars, stylePick.fitLine);

    // 前情分层算一次：文本给 section，层数给 usage（CLI 要说「这次吃到哪一层」）
    const recap = recapText(chapters, current, isShort ? Infinity : RECAP_ITEMS, ctx.volumes || []);

    const core = [
      { name: '书目', text: [
        `# ${ctx.book.title}`,
        `类型：${ctx.book.genre || ''}`,
        ctx.book.description ? `概述：${ctx.book.description}` : '',
        ctx.book.voice?.person ? `人称：${ctx.book.voice.person}` : '',
        ctx.book.voice?.notes ? `笔法：${ctx.book.voice.notes}` : '',
      ].filter(Boolean).join('\n') },
      { name: '出场角色', text: characterBlock(chars) },
      ...(relText ? [{ name: '活跃关系', text: relText }] : []),
      { name: '分章状态快照', text: stateBlock(ctx.states, prev, ctx.characters) },
      { name: '未结线索', text: promiseBlock(ctx.promises) },
      ...(decisionBlock(ctx) ? [{ name: '创作决策', text: decisionBlock(ctx) }] : []),
      { name: '前情摘要', text: recap.text },
      ...(related.length ? [{ name: '相关旧章', text: relatedBlock(related) }] : []),
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
    // 但它带 prose 标记：renderPrompt 会把它提到所有约束之后（见「动笔前最后读到的
    // 必须是正文语态文字」）。裁切顺序与注入顺序在这里是两件事，故意分开。
    const ordered = [
      ...(banText ? [{ name: '硬禁令', text: banText }] : []),
      ...core,
      ...tails.filter(Boolean),
      ...(styleText ? [{ name: '风格样例', text: styleText, prose: true }] : []),
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
          ...(s.name === '相关旧章' ? { included: related.map((r) => r.label) } : {}),
          ...(s.name === '活跃关系' ? { included: ['登记关系边'] } : {}),
          // 卷名列表要能报出来：「这一节里那些行是哪些卷给的」只有 buildSections 知道；
          // 层数在 usage.recapTiers 那一份里报，节上不再抄一遍（抄两遍就有两遍对不上）
          ...(s.name === '前情摘要' ? {
            included: recap.plan ? recap.plan.volumes.map((v) => v.vol.title || '未命名卷') : [],
          } : {}),
        })),
        loreIncluded: lore.entries.map((e) => e.name),
        loreDropped: lore.dropped,
        hasPrevChapter: !!prev?.body,
        hasCurrentBody: hasBody,
        droppedSections: dropped,
        // 样式样例的来源要能说出来：作者勾的基准 / 就近自动 / 勾了但都不合格已退回自动。
        // 第三种最容易骗人 —— 界面显示「已按我指定的基准」，实际注入的是别的章。
        styleSource: useStyle ? stylePick.source : null,
        recapTiers: recap.plan ? recap.plan.counts : null,
        truncated: dropped.length > 0 || lore.dropped.length > 0,
      },
    };
  }

  /**
   * 正文语态块永远压尾。理由不是审美：模型接着往下写时，模仿的是它读到的最后一段文字。
   * 禁词清单和配额是约束，读完就该让位给「这一段才是这本书的声音」。
   * 裁切顺序不看这个标记（风格样例仍旧末 = 先被裁），只看注入顺序 —— 两件事故意分开。
   */
  function splitProse(sections) {
    const body = [], prose = [];
    for (const s of sections) (s.prose ? prose : body).push(s);
    return { body, prose };
  }

  /** CLI 用：派生上下文文档 */
  function renderDocument({ sections }) {
    const { body, prose } = splitProse(sections);
    return `<!-- NovelWeave 派生上下文，勿手改；权威数据在 book.json / bible/ / manuscript/ -->\n\n`
      + [...body, ...prose].map((s) => s.block).join('\n\n') + '\n';
  }

  /** Web 用：拼成 prompt 正文。与 renderDocument 遍历同一批 section。 */
  function renderPrompt({ sections }, extra = '') {
    const { body, prose } = splitProse(sections);
    return body.map((s) => s.block).join('\n\n')
      + (extra ? `\n\n${extra}` : '')
      + prose.map((s) => `\n\n${s.block}`).join('');
  }

  return { buildSections, renderDocument, renderPrompt, splitProse, DEFAULTS, RECAP_ITEMS, RECAP_MID, characterBlock, promiseBlock, recapBlock, recapText, recapPlanOf, stateBlock, activeCharacters, hardBanBlock, pickStyleExemplars, stylePool, styleBlock, styleOpts, relatedPastChapters, relatedBlock };
});
