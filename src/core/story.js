/**
 * NovelWeave · 织文 — DB 行 ⇄ Story Bible 记录的单一转换层（UMD）
 *
 * 存在的理由：连续性面板要 ctx、导出要文件、导入要写回库，
 * 三处都需要「IndexedDB 那 7 张表」与「Story Bible v1 的形状」之间的映射。
 * 映射写两遍必然分叉，所以只有这一份。
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWBible);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWStory = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, Bible) {
  'use strict';

  /** DB 行 → 角色卡。appearance 在库里是字符串，这里拆成 schema 的 {summary, tokens}。 */
  function toCharacter(c) {
    const status = Bible.CHARACTER_STATUS.includes(c.status) ? c.status : 'alive';
    // c.role 可能是中文定位（库里存的），也可能是导出过的英文枚举；两种都要还原
    const roleEn = Bible.ROLE_MAP[c.role] || (Bible.CHARACTER_ROLES.includes(c.role) ? c.role : null) || 'supporting';
    const roleZh = c.role_zh || (Bible.ROLE_MAP[c.role] ? c.role : '') || zhRole(roleEn);
    return {
      schemaVersion: Bible.SCHEMA_VERSION,
      id: c.id,
      slug: c.slug || T.slugify(c.name),
      name: c.name,
      role: roleEn,
      role_zh: roleZh,
      status,
      'died-in': c['died-in'] ?? (status === 'deceased' ? (c.died_in || null) : null),
      first: c.first ?? null,
      aliases: (c.aliases || []).map((a) => (typeof a === 'string' ? { text: a, kind: 'nickname' } : a)),
      appearance: { summary: c.appearance || '', tokens: c.appearance_tokens || [] },
      personality: c.personality || '', background: c.background || '',
      goals: c.goals || '', notes: c.notes || '',
      enabled: c.enabled !== false,
      created: T.toISO(c.created_at),
    };
  }

  /** 角色卡 → DB 行（导入方向；appearance 要合回字符串 + 平行存 tokens）。 */
  function fromCharacter(rec, novelId) {
    return {
      id: rec.id, novel_id: novelId, name: rec.name,
      role: rec.role_zh || zhRole(rec.role),
      personality: rec.personality || '',
      appearance: (rec.appearance && rec.appearance.summary) || (typeof rec.appearance === 'string' ? rec.appearance : ''),
      appearance_tokens: (rec.appearance && rec.appearance.tokens) || [],
      background: rec.background || '', notes: rec.notes || '',
      status: rec.status || 'alive', 'died-in': rec['died-in'] ?? null, first: rec.first ?? null,
      aliases: rec.aliases || [], enabled: rec.enabled !== false,
      created_at: T.fromISO(rec.created) ?? null,
    };
  }

  function zhRole(en) {
    return ({ protagonist: '主角', antagonist: '反派', deuteragonist: '导师', supporting: '配角', minor: '龙套', narrator: '配角' })[en] || '配角';
  }

  /** 文件里的锚点是嵌套 at:{day,clock}，库里是平行两列。不显式转就会静默丢字段。 */
  function fromAnchor(a) {
    return {
      id: a.id, chapter: a.chapter ?? null, label: a.label || '',
      day: a.at?.day ?? null, clock: a.at?.clock ?? '', thread: a.thread || '',
      entities: a.entities || [], confidence: a.confidence || 'author',
      created_at: null,
    };
  }

  /** 文件里的伏笔 → 库行（原样保留 id 与时间戳，导入不走 save 的默认值逻辑）。 */
  function fromPromise(p) {
    return {
      id: p.id, type: p.type === 'question' ? 'question' : 'promise',
      title: p.title, status: p.status, weight: p.weight || 'minor',
      setup: { chapter: p.setup?.chapter ?? null, evidence: p.setup?.evidence ?? '' },
      payoff: { chapter: p.payoff?.chapter ?? null, due: p.payoff?.due ?? null },
      characters: p.characters || [], notes: p.notes || '',
      created_at: T.fromISO(p.created), updated_at: T.fromISO(p.updated),
    };
  }

  function fromDecision(d) {
    return {
      id: d.id, title: d.title || '', reason: d.reason || '', risk: d.risk || '',
      supersededBy: d.supersededBy ?? null,
      created_at: T.fromISO(d.created), updated_at: null,
    };
  }

  /** 关系边：relations.json 一直是把库行原样写出去的（没有 ISO 化），
   *  所以两种口径都得能吃 —— 老文件里是毫秒 created_at，新写的可能带 ISO created。 */
  function fromRelation(e) {
    return {
      id: e.id, from: e.from, to: e.to, kind: e.kind || '',
      address: e.address || '', since: e.since ?? null, until: e.until ?? null,
      notes: e.notes || '',
      created_at: T.fromISO(e.created) ?? e.created_at ?? null, updated_at: e.updated_at ?? null,
    };
  }

  /** 信息差登记：文件侧 created 是 ISO，库侧 created_at 是毫秒（缺省时由 saveSecret 补）。 */
  function fromSecret(s) {
    return {
      id: s.id, novel_id: null, term: s.term || '', truth: s.truth || '',
      first_chapter: s.first_chapter ?? null, reveal_chapter: s.reveal_chapter ?? null,
      revealed_at: s.revealed_at ?? null,
      informed: Array.isArray(s.informed) ? s.informed : [],
      promise_id: s.promise_id ?? null, notes: s.notes || '',
      enabled: s.enabled !== false,
      created_at: T.fromISO(s.created) ?? s.created_at ?? null, updated_at: s.updated_at ?? null,
    };
  }

  function toWorld(w) {
    const keys = (w.keys && w.keys.length ? w.keys : [w.name]).filter(Boolean);
    const type = w.type || 'custom';
    return {
      schemaVersion: Bible.SCHEMA_VERSION,
      id: w.id, slug: w.slug || T.slugify(w.name),
      comment: w.name, name: w.name, type,
      keys, secondary_keys: w.secondary_keys || [],
      selective: !!w.selective,
      constant: w.constant ?? (type === 'rule' || type === 'system'),
      position: w.position || 'before_character_definition',
      insertion_order: w.insertion_order ?? 100,
      priority: w.priority ?? 0, enabled: w.enabled !== false, case_sensitive: !!w.case_sensitive,
      content: w.content ?? w.description ?? '', details: w.details || {},
      lifecycle: w.lifecycle || { 'destroyed-in': null, 'revealed-in': null },
      created: T.toISO(w.created_at),
    };
  }

  /**
   * 递归扫描的开关与层数上限。这是「书级世界书配置」的唯一真源：
   * 导出到 `bible/world/_index.json` 的 scan_depth / recursive_scanning 一律从这里派生，
   * 不要再抄一份字面量 —— 那三个字段曾经写着 `true` 而引擎只做单层，属于骗人的声明。
   * 上限 2 层：第 1 层按正文命中，第 2 层只从已注入条目的正文里再命中一次。
   * 更深就会把整本世界书顺着一条「灵脉」全拖进 prompt。
   */
  const LORE_RECURSION = { recursive: true, rounds: 2 };

  /**
   * `bible/world/_index.json` 里那三个书级扫描字段的唯一出处（Web 导出与 CLI 存盘共用）。
   * 以前两处各写一份字面量 `scan_depth: 6, token_budget: 1400, recursive_scanning: true`，
   * 而引擎只做单层 —— 声明与实现分家。现在导出值一律由这里的常量算出，
   * 有守卫测试钉住「文件里写的 == 引擎真做的」，改常量不用改文案，改文案不改行为会红。
   * 字段名沿用 Character Card V2，但按本引擎的语义取值：
   * 织文没有「聊天条数」可扫，`scan_depth` 记的是**扫几层**；
   * `token_budget` 是把引擎真正在用的字节额度换成 token（汉字 3 字节 ≈ 1 token）。
   */
  function loreIndexConfig() {
    return {
      scan_depth: LORE_RECURSION.rounds,
      token_budget: Math.round(DEFAULT_BUDGET.loreBytes / 3),
      recursive_scanning: LORE_RECURSION.recursive,
    };
  }

  /** 上下文字节预算。长篇必爆的第一原因就是无脑塞全文，这里默认按字节硬截。 */
  const DEFAULT_BUDGET = {
    contextBytes: 12288,   // 整份派生上下文
    loreBytes: 4096,       // 其中分给世界设定的额度
    prevTailChars: 2000,   // 前文结尾
    currentTailChars: 3000, // 本章已有正文
    recursive: LORE_RECURSION.recursive,
    loreRounds: LORE_RECURSION.rounds,
  };

  // ═══════════════════ 世界书关键词触发 ═══════════════════
  // 语义参考 SillyTavern World Info / Character Card V2 的 character_book.entries[]，
  // 字段名对齐，便于日后「导出为 lorebook」只是搬字段。

  /** 把 IndexedDB 里的 worldbuilding 行归一成 lorebook 条目。 */
  function toLoreEntry(wb, index = 0) {
    const keys = Array.isArray(wb.keys) && wb.keys.length ? wb.keys : [wb.name].filter(Boolean);
    return {
      id: wb.id,
      name: wb.name,
      comment: wb.comment ?? wb.name,
      type: wb.type || 'custom',
      content: wb.content ?? wb.description ?? '',
      keys: keys.map(String),
      secondary_keys: (wb.secondary_keys || []).map(String),
      selective: wb.selective ?? false,
      constant: wb.constant ?? (wb.type === 'rule' || wb.type === 'system'),
      position: wb.position || 'before_character_definition',
      insertion_order: wb.insertion_order ?? (100 + index * 10),
      priority: wb.priority ?? 0,
      enabled: wb.enabled !== false,
      case_sensitive: wb.case_sensitive ?? false,
    };
  }

  function hasKey(text, key, caseSensitive) {
    if (!key) return false;
    if (caseSensitive) return text.includes(key);
    return text.toLowerCase().includes(key.toLowerCase());
  }

  /**
   * 按扫描窗口内出现的关键词挑选世界条目，最多 `loreRounds` 层。
   * 第 1 层扫的是正文本身；之后每层只扫「上一层真正注入的那几条的正文」——
   * 递归的语义是「已经决定要给作者的设定，把它的同乡带进来」，不是「把全库关键词再过一遍」。
   * 只扫真正注入的那几条：被额度裁掉的内容模型根本看不到，拿它去带同乡会凭空多出设定。
   * constant 条目无条件注入（第 1 层就把它们全收进来，后面几层不再有「无条件」这一说）。
   * 每层内排序 priority 降序 → insertion_order 升序；额度跨层共享、前层先占，
   * 超额即截断（不静默：返回 dropped）。关到 1 层就是本来的单层扫描行为。
   */
  function loreTrigger(text, entries, opts = {}) {
    const budget = Object.assign({}, DEFAULT_BUDGET, opts);
    const hay = String(text || '');
    const scanWindow = budget.scanDepthChars
      ? hay.slice(-budget.scanDepthChars)
      : hay;
    const pool = (entries || []).map(toLoreEntry).filter((e) => e.enabled && e.content);
    const maxRounds = budget.recursive ? Math.max(1, budget.loreRounds || 1) : 1;

    const included = [], dropped = [];
    // 只有「本层命中过」的条目才退出后续层（要么注入、要么被额度裁掉并报出去）；
    // 本层没命中的必须留下 —— 下一层扫的是别的文本，它可能在那一层才被带出来。
    const consumed = new Set();
    let bytes = 0;
    let frontier = scanWindow;
    let sources = [];

    for (let round = 1; round <= maxRounds && frontier; round++) {
      const matched = [];
      for (const e of pool) {
        if (consumed.has(e.id)) continue;
        const primary = e.keys.some((k) => hasKey(frontier, k, e.case_sensitive));
        const secondaryOk = !e.selective || !e.secondary_keys.length
          ? true
          : e.secondary_keys.some((k) => hasKey(frontier, k, e.case_sensitive));
        if (e.constant || (primary && secondaryOk)) {
          consumed.add(e.id);
          matched.push(e);
        }
      }
      matched.sort((a, b) => (b.priority - a.priority) || (a.insertion_order - b.insertion_order));

      const injectedNow = [];
      for (const e of matched) {
        const line = `【${e.name}】${e.content}`;
        const size = NWText.bytesOf(line);
        if (bytes + size > budget.loreBytes) { dropped.push(e.id); continue; }
        bytes += size;
        e.loreRound = round;
        if (round > 1) e.draggedBy = sources.slice();
        included.push(e);
        injectedNow.push(e);
      }
      // 层数上限只有这一处（循环条件里的 round <= maxRounds）；
      // 再补一句 if (round === maxRounds) break 是同一道闸门的第二份代码 —— 删不掉也测不出。
      sources = injectedNow.map((e) => e.name);
      frontier = injectedNow.map((e) => String(e.content)).join('\n');
    }
    return { entries: included, dropped, bytes };
  }

  /**
   * book.json → 小说库行。章节、角色、设定……每张表都有 from*，只有这本书是导入
   * 现场手拼一个字面量 —— 于是「文件里写着 format:short、库里那格却是空的」这种断口
   * 没有任何一处测试够得着。短篇靠 format 换上下文与规则阈值，进度条读 target_words，
   * 这两个键丢了不报错，只会悄悄变成长篇。
   */
  function fromBook(b) {
    return {
      id: b.id, title: b.title || '', genre: b.genre || '玄幻', description: b.description || '',
      format: b.format === 'short' ? 'short' : 'long',
      target_words: Number(b.target_words) || null,
      stylePack: b.stylePack || null,
      created_at: T.fromISO(b.created) ?? null,
      updated_at: T.fromISO(b.updated) ?? null,
    };
  }

  function fromWorld(e, novelId) {
    return {
      id: e.id, novel_id: novelId, type: e.type || 'location', name: e.name,
      description: e.content || '', details: e.details || {},
      keys: e.keys || [e.name], secondary_keys: e.secondary_keys || [],
      selective: !!e.selective, constant: !!e.constant,
      insertion_order: e.insertion_order ?? 100, priority: e.priority ?? 0,
      enabled: e.enabled !== false, lifecycle: e.lifecycle || {},
      created_at: T.fromISO(e.created) ?? null,
    };
  }

  /**
   * 章节 → 规则用的形状。
   * 库里目前没有「本章出场角色」这一栏，所以 mentions 按名字命中推导，
   * characters 留空 —— 那是作者显式声明的语义（见 schema 文档），
   * 脚本不能替作者声明。R1 在 characters 为空时退回动作邻近扫描，仍然有效。
   */
  function toChapter(ch, characters) {
    const body = ch.content || '';
    const forms = (characters || []).flatMap((c) => {
      const card = toCharacter(c);
      return [card.name, ...card.aliases.map((a) => a.text)].filter((s) => (s || '').trim().length >= 2).map((s) => [s, card.id]);
    });
    const derived = [...new Set(forms.filter(([name]) => body.includes(name)).map(([, id]) => id))];
    // declaredMentions = 作者/agent 真写下的声明；derived 只为规则服务，绝不允许被导出成声明
    const declared = Array.isArray(ch.mentions) ? ch.mentions : [];
    return {
      id: ch.id, number: ch.order, title: ch.title, status: ch.status || (body.trim() ? 'draft' : 'outline'),
      slug: ch.slug || T.slugify(ch.title), pov: ch.pov ?? null, time_anchor: ch.time_anchor ?? null,
      characters: ch.characters || [],
      declaredMentions: declared,
      mentions: declared.length ? declared : derived,
      locations: ch.locations || [], flags: ch.flags || [],
      summary: ch.summary || '', xWords: ch.word_count ?? null, body, meta: null,
      infoControl: ch.info_control || null,
    };
  }

  function toPromise(p) {
    return {
      id: p.id, type: p.type === 'question' ? 'question' : 'promise',
      title: p.title, status: p.status, weight: p.weight || 'minor',
      setup: p.setup || { chapter: null, evidence: '' },
      payoff: p.payoff || { chapter: null, due: null },
      characters: p.characters || [], notes: p.notes || '',
      created: T.toISO(p.created_at), updated: T.toISO(p.updated_at),
    };
  }

  function toTimeline(rows) {
    return {
      schemaVersion: Bible.SCHEMA_VERSION, unit: 'day',
      anchors: rows.map((r) => ({
        id: r.id, chapter: r.chapter || null, label: r.label || '',
        thread: r.thread || null,
        at: { day: r.day ?? null, clock: r.clock || null }, kind: 'story',
        entities: r.entities || [], confidence: r.confidence || 'author',
      })),
      backstory: [],
    };
  }

  function toSuppressions(rows) {
    return { items: rows.map((r) => ({ fingerprint: r.fingerprint, reason: r.reason, by: 'author', at: T.toISO(r.at) })) };
  }

  const LIST_STATE_DIMS = ['injury', 'items', 'knows'];

  /** 多行文本或数组 → 去空去重后的数组。规则只在这里定义一次。 */
  function toLines(v) {
    if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
    return String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** 只保留非空维度：空串与空数组不是事实，写进快照会让 R2 拿「空」去比角色卡。 */
  function dimsOf(src) {
    const dims = {};
    for (const d of Bible.STATE_DIMS) {
      const v = src?.[d];
      if (v === '' || v == null) continue;
      if (Array.isArray(v) && !v.length) continue;
      dims[d] = v;
    }
    return dims;
  }

  /** 库行（一行一个 章节×实体）→ schema 的 states.byChapter */
  function statesFromRows(rows) {
    const byChapter = {};
    for (const r of rows || []) {
      if (!r.chapter || !r.entity) continue;
      byChapter[r.chapter] = byChapter[r.chapter] || {};
      byChapter[r.chapter][r.entity] = dimsOf(r);
    }
    return { schemaVersion: Bible.SCHEMA_VERSION, budgetPerChapter: Bible.MAX_STATE_BYTES_PER_CHAPTER, byChapter };
  }

  /** schema 的 states → 库行，供导入按原样落库（不重新生成主键） */
  function stateRowsFromFile(states, novelId) {
    const out = [];
    for (const [chapter, entities] of Object.entries(states?.byChapter || {})) {
      for (const [entity, dims] of Object.entries(entities || {})) {
        const row = { id: `${chapter}|${entity}`, novel_id: novelId, chapter, entity };
        for (const d of Bible.STATE_DIMS) {
          const v = dims?.[d];
          if (v == null) row[d] = LIST_STATE_DIMS.includes(d) ? [] : '';
          else row[d] = v;
        }
        out.push(row);
      }
    }
    return out;
  }

  /** 组装 rules.js 需要的 ctx。schema 传 null：浏览器不跑结构校验，由 CLI 负责。 */
  function buildCtx(rows) {
    const characters = (rows.characters || []).map(toCharacter);
    const chapters = (rows.chapters || []).map((c) => toChapter(c, rows.characters));
    const lexicon = { schemaVersion: Bible.SCHEMA_VERSION, names: {}, terms: {}, forbidden: {}, allowlist: [] };
    for (const c of characters) {
      lexicon.names[c.name] = c.id;
      for (const a of c.aliases) if (a.text) lexicon.names[a.text] = c.id;
    }
    return {
      book: { id: rows.novel.id, slug: T.slugify(rows.novel.title), title: rows.novel.title,
        genre: rows.novel.genre, description: rows.novel.description,
        format: rows.novel.format === 'short' ? 'short' : 'long',
        targetWords: rows.novel.target_words || null,
        // 去 AI 味包必须原样过桥：R22 与 prompt 都只认 ctx.book.stylePack，
        // 这里漏掉一项，作者在设置里关掉的词组就只是看起来生效
        stylePack: rows.novel.stylePack || null,
        // 建档/改稿时间必须过桥。project.js 写 book.json 时读的就是这两个键，
        // 而 buildCtx 以前不给 —— 于是导出的目录里压根没有 created：
        // 导入端只能把书重新写成「今天建的」，agent 侧看到的「上次更新」也跟着丢。
        created: rows.novel.created || T.toISO(rows.novel.created_at),
        updated: rows.novel.updated || T.toISO(rows.novel.updated_at),
        _derived: { words: rows.novel.word_count, chapters: rows.novel.chapter_count } },
      chapters, characters,
      world: (rows.world || []).map(toWorld),
      promises: { schemaVersion: Bible.SCHEMA_VERSION, items: (rows.promises || []).map(toPromise) },
      // rows.states 传「库行数组」；已是聚合形状（CLI 的 loadBook 产物）就直接用
      states: Array.isArray(rows.states) ? statesFromRows(rows.states) : (rows.states || statesFromRows([])),
      timeline: toTimeline(rows.timeline || []),
      lexicon,
      suppressions: toSuppressions(rows.suppressions || []),
      relations: rows.relations || { edges: [] },
      // 决策原样带过：app.js 查询后传进来，context.js 的「创作决策」节和导出都要用
      decisions: rows.decisions || [],
      // 信息差账本同理：R20/R21 只看这一个字段，CLI 侧的 loadBook 也按同名键给
      secrets: rows.secrets || [],
      chapterNumbers: new Map(chapters.map((c) => [c.id, c.number])),
    };
  }

  return { LORE_BUDGET: DEFAULT_BUDGET, LORE_RECURSION, loreIndexConfig, toCharacter, fromCharacter, toWorld, fromWorld, fromBook, toLoreEntry, loreTrigger, toChapter, toPromise, fromAnchor, fromPromise,
    fromDecision, fromRelation, fromSecret,
    toTimeline, toSuppressions, statesFromRows, stateRowsFromFile, dimsOf, toLines, buildCtx, zhRole };
});
