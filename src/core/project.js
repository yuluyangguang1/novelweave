/**
 * NovelWeave · 织文 — .novelweave/ 文件树的双向装配（UMD：浏览器与 Node 共用）
 *
 * 这是「网页导出的目录，CLI 必须能原样读回」这条契约的唯一实现。
 * 之所以放浏览器侧而不是只在脚本里，是因为导出由 Web 端发起：两边各写一套
 * 文件布局，迟早会变成导出的书 agent 读不懂。
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWBible, root.NWStory);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWProject = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, Bible, Story) {
  'use strict';

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const hashOf = async (record) => 'sha256:' + await sha256Hex(T.canonicalJson(Bible.authorFields(record)));

  /** 只保留 schema 声明的字段。库里那些 novel_id / created_at 之类属于存储细节，
   *  带进文件会被 additionalProperties:false 判成违规。 */
  function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
    return out;
  }

  function chapterFrontmatter(ch) {
    const base = {
      schemaVersion: Bible.SCHEMA_VERSION,
      id: ch.id, number: ch.number, slug: ch.slug, title: ch.title, status: ch.status,
      pov: ch.pov, time_anchor: ch.time_anchor, locations: ch.locations,
      characters: ch.characters, mentions: ch.declaredMentions ?? ch.mentions ?? [], flags: ch.flags, summary: ch.summary,
    };
    base['x-words'] = T.countWords(ch.body);
    base['x-updated'] = ch.updated_at ? T.toISO(ch.updated_at) : null;
    return Bible.serializeChapterFile(pick(base, Object.keys(base)), ch.body || '');
  }

  /**
   * @param ctx NWStory.buildCtx 的产物（或 CLI 的 loadBook 产物）
   * @returns { [相对路径]: 文本 }
   */
  async function buildFileMap(ctx) {
    const slug = ctx.book.slug || T.slugify(ctx.book.title);
    const p = (rel) => `${slug}/${rel}`;
    const files = {};

    const book = pick({
      schemaVersion: Bible.SCHEMA_VERSION, id: ctx.book.id, slug, title: ctx.book.title,
      genre: ctx.book.genre, language: ctx.book.language || 'zh-CN', description: ctx.book.description || '',
      audience: ctx.book.audience || '', target: ctx.book.target || { chapters: 0, wordsPerChapter: 3000 },
      voice: ctx.book.voice || { person: '', tense: '', povDefault: null, notes: '' },
      created: ctx.book.created || T.toISO(ctx.book.created_at),
      updated: ctx.book.updated || T.toISO(ctx.book.updated_at),
    }, ['schemaVersion', 'id', 'slug', 'title', 'genre', 'language', 'description', 'audience', 'target', 'voice', 'created', 'updated']);
    book._derived = {
      chapters: ctx.chapters.length,
      words: ctx.chapters.reduce((s, c) => s + T.countWords(c.body), 0),
      characters: ctx.characters.length,
    };
    files[p('book.json')] = JSON.stringify(book, null, 2) + '\n';

    for (const ch of ctx.chapters) {
      files[p(`manuscript/chapters/${Bible.chapterFileName(ch)}`)] = chapterFrontmatter(ch);
    }

    const syncRecords = {};
    for (const ch of ctx.chapters) {
      syncRecords[tagFor('chapter', ch.id)] = { hash: await hashRecord('chapter', ch), source: 'web' };
    }
    for (const c of ctx.characters) {
      const rec = pick(c, ['schemaVersion', 'id', 'slug', 'name', 'role', 'role_zh', 'status', 'died-in', 'first',
        'aliases', 'appearance', 'personality', 'background', 'goals', 'notes', 'voice', 'gender', 'age', 'enabled', 'created']);
      rec.slug = c.slug || T.slugify(c.name);
      files[p(`bible/characters/${c.id}.json`)] = JSON.stringify(rec, null, 2) + '\n';
      syncRecords[tagFor('character', c.id)] = { hash: await hashRecord('character', rec), source: 'web' };
    }
    files[p('bible/characters/_index.json')] = JSON.stringify(
      { schemaVersion: Bible.SCHEMA_VERSION, ids: ctx.characters.map((c) => c.id), order: ctx.characters.map((_, i) => i) }, null, 2) + '\n';

    for (const w of ctx.world) {
      const rec = pick(w, ['schemaVersion', 'id', 'slug', 'comment', 'name', 'type', 'keys', 'secondary_keys',
        'selective', 'constant', 'position', 'insertion_order', 'priority', 'enabled', 'case_sensitive',
        'content', 'details', 'constraints', 'lifecycle', 'created']);
      rec.slug = w.slug || T.slugify(w.name);
      files[p(`bible/world/${w.id}.json`)] = JSON.stringify(rec, null, 2) + '\n';
      syncRecords[tagFor('world', w.id)] = { hash: await hashRecord('world', rec), source: 'web' };
    }
    files[p('bible/world/_index.json')] = JSON.stringify({
      schemaVersion: Bible.SCHEMA_VERSION, ids: ctx.world.map((w) => w.id), order: ctx.world.map((_, i) => i),
      scan_depth: 6, token_budget: 1400, recursive_scanning: true,
    }, null, 2) + '\n';

    const promises = { schemaVersion: Bible.SCHEMA_VERSION, items: ctx.promises.items.map((i) => pick(i,
      ['id', 'type', 'title', 'status', 'setup', 'payoff', 'characters', 'weight', 'notes', 'created', 'updated'])) };
    files[p('bible/promises.json')] = JSON.stringify(promises, null, 2) + '\n';
    for (const item of promises.items) {
      syncRecords[tagFor('promise', item.id)] = { hash: await hashRecord('promise', item), source: 'web' };
    }

    files[p('bible/states.json')] = JSON.stringify(ctx.states || Bible.emptyStates(), null, 2) + '\n';
    files[p('bible/relations.json')] = JSON.stringify(ctx.relations || { schemaVersion: Bible.SCHEMA_VERSION, edges: [] }, null, 2) + '\n';

    const tl = ctx.timeline || Bible.emptyTimeline();
    const cleanAnchor = (a) => pick(a, ['id', 'chapter', 'label', 'at', 'thread', 'kind', 'entities', 'confidence', 'evidence']);
    const tlOut = {
      schemaVersion: Bible.SCHEMA_VERSION, unit: tl.unit || 'day',
      anchors: (tl.anchors || []).map(cleanAnchor),
      backstory: (tl.backstory || []).map(cleanAnchor),
    };
    files[p('bible/timeline.json')] = JSON.stringify(tlOut, null, 2) + '\n';
    for (const a of tlOut.anchors) {
      syncRecords[tagFor('anchor', a.id)] = { hash: await hashRecord('anchor', a), source: 'web' };
    }

    files[p('bible/lexicon.json')] = JSON.stringify(ctx.lexicon || Bible.emptyLexicon(), null, 2) + '\n';
    files[p('continuity/suppressions.json')] = JSON.stringify(ctx.suppressions || { items: [] }, null, 2) + '\n';

    files[p('manuscript/outline.md')] = `# ${ctx.book.title} · 大纲\n\n类型：${ctx.book.genre || ''}\n\n${ctx.book.description || ''}\n`;
    files[p('_index.md')] = `# ${ctx.book.title} · 文件索引\n\n由织文导出。权威数据在 book.json / bible/ / manuscript/chapters/。\n\n- 章节 ${book._derived.chapters}\n- 字数 ${book._derived.words}\n- 角色 ${book._derived.characters}\n`;

    files[p('meta/sync.json')] = JSON.stringify({
      schemaVersion: Bible.SCHEMA_VERSION, novelId: ctx.book.id, bookSlug: slug,
      exportedAt: new Date().toISOString(), baseTreeHash: null,
      records: syncRecords,
    }, null, 2) + '\n';

    const root = {
      schemaVersion: Bible.SCHEMA_VERSION, updatedAt: new Date().toISOString(),
      books: [{ slug, id: ctx.book.id, title: ctx.book.title, path: slug }],
    };
    return { files, slug, projectJson: root };
  }

  /** project.json + 书目录一起铺平成完整文件树，便于写盘或塞进单个 JSON 备份。 */
  async function buildProjectTree(ctx) {
    const { files, projectJson } = await buildFileMap(ctx);
    return { ...files, 'project.json': JSON.stringify(projectJson, null, 2) + '\n' };
  }

  /**
   * 「什么算作者写的内容」的唯一投影。库里一行和文件里一条记录形状不同
   * （库行带 word_count/updated_at/novel_id，文件记录带 status/flags/summary），
   * 不先归一就直接哈希，会把没改过的东西全判成冲突。
   * 两种形状都要能吃：导出时传文件记录，导入比较时传库行。
   */
  function authorProjection(kind, row) {
    switch (kind) {
      case 'chapter': {
        const c = row.content !== undefined ? row : { ...row, content: row.body };
        const body = c.content ?? '';
        return {
          id: c.id, number: c.order ?? c.number ?? null, title: c.title ?? '',
          // 与 toChapter 用同一条默认规则，否则「导入过一次」的章节会算出另一个哈希
          status: c.status || (body.trim() ? 'draft' : 'outline'),
          summary: c.summary || '',
          characters: c.characters || [], mentions: c.declaredMentions ?? c.mentions ?? [],
          locations: c.locations || [], flags: c.flags || [],
          pov: c.pov ?? null, time_anchor: c.time_anchor ?? null,
          content: c.content ?? '',
        };
      }
      case 'character': {
        const nested = row.appearance && typeof row.appearance === 'object';
        const c = nested ? row : Story.toCharacter(row);
        return {
          id: c.id, name: c.name, role: c.role, status: c.status,
          'died-in': c['died-in'] ?? null, first: c.first ?? null,
          aliases: (c.aliases || []).map((a) => (typeof a === 'string' ? a : a.text)),
          appearance: c.appearance?.summary || '',
          tokens: (c.appearance?.tokens || []).map((t) => `${t.key}|${t.since || ''}|${t.until || ''}`),
          personality: c.personality || '', background: c.background || '', notes: c.notes || '',
        };
      }
      case 'world': {
        const w = typeof row.content === 'string' ? row : Story.toWorld(row);
        return {
          id: w.id, name: w.name, type: w.type || 'custom',
          keys: w.keys || [w.name], secondary_keys: w.secondary_keys || [],
          constant: !!w.constant, selective: !!w.selective, content: w.content || '',
        };
      }
      case 'promise': {
        const p = row.setup ? row : Story.toPromise(row);
        return {
          id: p.id, type: p.type, title: p.title, status: p.status, weight: p.weight || 'minor',
          setup: { chapter: p.setup?.chapter ?? null, evidence: p.setup?.evidence ?? '' },
          payoff: { chapter: p.payoff?.chapter ?? null, due: p.payoff?.due ?? null },
          characters: p.characters || [], notes: p.notes || '',
        };
      }
      case 'anchor': {
        const a = row.at ? row : { ...row, at: { day: row.day ?? null, clock: row.clock || null } };
        return { id: a.id, chapter: a.chapter ?? null, label: a.label || '', day: a.at?.day ?? null, clock: a.at?.clock ?? null };
      }
      default: throw new Error(`未知投影类型 ${kind}`);
    }
  }

  const KIND_OF_STORE = { chapters: 'chapter', characters: 'character', world: 'world', promises: 'promise', timeline: 'anchor' };
  const tagFor = (kind, id) => `${kind}:${id}`;

  async function hashRecord(kind, row) {
    return hashOf(authorProjection(kind, row));
  }

  /** 目录树 → 数据库行。返回的每个集合都是「库行」形状，不混文件记录 ——
   * 形状不统一时调用方只能逐字段猜，时间锚点的 day/clock 就是这样被静默丢过的。
   * 文件里的 id 一律尊重，不重新生成。
   */
  function parseFileMap(files) {
    const json = (map, key) => (map[key] ? JSON.parse(map[key]) : null);
    const project = json(files, 'project.json');
    const slug = project?.books?.[0]?.slug;
    if (!slug) throw new Error('文件树里找不到 project.json 或它没有 books[0]');
    const book = json(files, `${slug}/book.json`);
    const novelId = book?.id || project.books[0].id;

    const chapters = Object.entries(files)
      .filter(([k]) => k.startsWith(`${slug}/manuscript/chapters/`) && k.endsWith('.md'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, text]) => {
        let parsedFm;
        try {
          parsedFm = Bible.parseFrontmatter(text);
        } catch (e) {
          throw new Error(`${path}：${e.message}`);   // 必须指名是哪个文件，否则十几个文件里无从下手
        }
        const { data, body } = parsedFm;
        return { id: data.id, title: data.title, content: body, order: data.number,
          status: data.status, summary: data.summary || '', flags: data.flags || [],
          characters: data.characters || [], mentions: data.mentions || [], locations: data.locations || [],
          pov: data.pov ?? null, time_anchor: data.time_anchor ?? null,
          // 派生值一律重算：agent 改正文时通常不会同步 x-words，而 Web 端没有 recount 命令可修
          word_count: T.countWords(body) };
      });

    const readDir = (sub) => Object.entries(files)
      .filter(([k]) => k.startsWith(`${slug}/bible/${sub}/`) && k.endsWith('.json') && !k.endsWith('_index.json'))
      .map(([, text]) => JSON.parse(text));

    return {
      slug, novelId, book,
      chapters,
      characters: readDir('characters').map((rec) => Story.fromCharacter(rec, novelId)),
      world: readDir('world').map((rec) => Story.fromWorld(rec, novelId)),
      promises: (json(files, `${slug}/bible/promises.json`)?.items || []).map((rec) => Story.fromPromise(rec)),
      timeline: (json(files, `${slug}/bible/timeline.json`)?.anchors || []).map((rec) => Story.fromAnchor(rec)),
      suppressions: json(files, `${slug}/continuity/suppressions.json`)?.items || [],
      sync: json(files, `${slug}/meta/sync.json`),
    };
  }

  /**
   * 三方比较：base = 上次导出的 sync.json，file = 目录里的现在值，local = 库里的现在值。
   * 只有一边动过就取那一边；两边都动过才算冲突 —— 谁都不许被静默覆盖。
   */
  function classify(baseHash, fileHash, localHash) {
    const fileChanged = fileHash !== baseHash;
    const localChanged = localHash !== baseHash;
    if (!fileChanged && !localChanged) return 'same';
    if (fileChanged && !localChanged) return 'take-file';
    if (!fileChanged && localChanged) return 'take-local';
    return 'conflict';
  }

  return { buildFileMap, buildProjectTree, parseFileMap, classify, hashOf, hashRecord,
    authorProjection, KIND_OF_STORE, tagFor, chapterFrontmatter };
});
