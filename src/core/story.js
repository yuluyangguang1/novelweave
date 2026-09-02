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

  /** 上下文字节预算。长篇必爆的第一原因就是无脑塞全文，这里默认按字节硬截。 */
  const DEFAULT_BUDGET = {
    contextBytes: 12288,   // 整份派生上下文
    loreBytes: 4096,       // 其中分给世界设定的额度
    prevTailChars: 2000,   // 前文结尾
    currentTailChars: 3000, // 本章已有正文
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
   * 按扫描窗口内出现的关键词挑选世界条目。
   * constant 条目无条件注入；selective 条目要求主键与副键同时命中。
   * 排序：priority 降序 → insertion_order 升序；超额即截断（不静默：返回 dropped）。
   */
  function loreTrigger(text, entries, opts = {}) {
    const budget = Object.assign({}, DEFAULT_BUDGET, opts);
    const hay = String(text || '');
    const scanWindow = budget.scanDepthChars
      ? hay.slice(-budget.scanDepthChars)
      : hay;
    const pool = (entries || []).map(toLoreEntry).filter((e) => e.enabled && e.content);

    const matched = [];
    for (const e of pool) {
      const primary = e.keys.some((k) => hasKey(scanWindow, k, e.case_sensitive));
      const secondaryOk = !e.selective || !e.secondary_keys.length
        ? true
        : e.secondary_keys.some((k) => hasKey(scanWindow, k, e.case_sensitive));
      if (e.constant || (primary && secondaryOk)) matched.push(e);
    }

    matched.sort((a, b) => (b.priority - a.priority) || (a.insertion_order - b.insertion_order));

    const included = [], dropped = [];
    let bytes = 0;
    for (const e of matched) {
      const line = `【${e.name}】${e.content}`;
      const size = NWText.bytesOf(line);
      if (bytes + size > budget.loreBytes) { dropped.push(e.id); continue; }
      bytes += size;
      included.push(e);
    }
    return { entries: included, dropped, bytes };
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
        _derived: { words: rows.novel.word_count, chapters: rows.novel.chapter_count } },
      chapters, characters,
      world: (rows.world || []).map(toWorld),
      promises: { schemaVersion: Bible.SCHEMA_VERSION, items: (rows.promises || []).map(toPromise) },
      // rows.states 传「库行数组」；已是聚合形状（CLI 的 loadBook 产物）就直接用
      states: Array.isArray(rows.states) ? statesFromRows(rows.states) : (rows.states || statesFromRows([])),
      timeline: toTimeline(rows.timeline || []),
      lexicon,
      suppressions: toSuppressions(rows.suppressions || []),
      chapterNumbers: new Map(chapters.map((c) => [c.id, c.number])),
    };
  }

  return { LORE_BUDGET: DEFAULT_BUDGET, toCharacter, fromCharacter, toWorld, fromWorld, toLoreEntry, loreTrigger, toChapter, toPromise, fromAnchor, fromPromise,
    toTimeline, toSuppressions, statesFromRows, stateRowsFromFile, dimsOf, toLines, buildCtx, zhRole };
});
