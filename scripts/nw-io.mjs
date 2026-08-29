#!/usr/bin/env node
/**
 * nw-io.mjs — 项目定位、建档、导入导出、迁移
 *
 * 用法：
 *   node scripts/nw-io.mjs locate [--dir PATH] [--json]
 *   node scripts/nw-io.mjs init --title 书名 [--genre 玄幻] [--slug s] [--dir PATH]
 *   node scripts/nw-io.mjs export [--out DIR] [--book DIR]
 *   node scripts/nw-io.mjs import --web --file backup.json [--dir PATH]
 *   node scripts/nw-io.mjs adopt <草稿目录> --title 书名 [--genre 玄幻] [--dry-run] [--json]
 *   node scripts/nw-io.mjs recount [bookDir]
 *   node scripts/nw-io.mjs migrate [--dry-run]
 *
 * 退出码：0 成功 · 2 用法错 · 4 需要迁移 · 5 IO 错
 *        · 6 有对象已存在（幂等提示），或 adopt 报告里有待人工确认项
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PROJECT_DIR, PROJECT_FILE, SCHEMA_VERSION, NWBible, NWText, NWDraft,
  findProject, bookDirs, resolveBookDir, readJson, writeJsonAtomic, writeFileAtomic,
  scaffoldBook, upsertProject, recomputeDerived, recountBook, saveChapter, emit, log, EXIT, authorHash,
} from './lib/book.mjs';

const sub = process.argv[2];
const rest = process.argv.slice(3);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[k] = rest[++i];
    else flags[k] = true;
  } else positional.push(a);
}
const json = !!flags.json;
const baseDir = flags.dir ? path.resolve(flags.dir) : process.cwd();

function fail(message, code = EXIT.USAGE) {
  log(message);
  process.exit(code);
}

const ISSUE_ZH = {
  'duplicate-number': (i) => `第${i.number}章重号：${i.files.join('、')}`,
  'gap-number': (i) => `缺第${i.number}章（跳号）`,
  'no-number': (i) => `判不出章号：${i.file}`,
  'no-title': (i) => `没有标题：${i.file}`,
  'suspiciously-short': (i) => `正文短到可疑：${i.file}（${i.words} 字）`,
};

function humanAdopt(report, dir) {
  const s = report.stats;
  const out = [
    `${dir ? '已建档' : '预演（--dry-run，未写任何文件）'}：${s.chapters} 章 / ${s.words} 字`
      + (s.positional ? `；${s.positional} 章按楔子/尾声定位（不占作者章号）` : '')
      + (s.unresolved ? `；${s.unresolved} 个文件判不出章号` : '')
      + (s.skippedStructured ? `；跳过 ${s.skippedStructured} 个已是 NovelWeave 的文件` : ''),
    `来源：${report.source}`,
  ];
  if (dir) out.push(`目录：${dir}`);
  out.push('', report.issues.length ? `待人工确认 ${report.issues.length} 项：` : '没有发现编号/标题问题。');
  out.push(...report.issues.slice(0, 30).map((i) => `  ! ${ISSUE_ZH[i.kind] ? ISSUE_ZH[i.kind](i) : i.kind}`));
  if (report.issues.length > 30) out.push(`  …另有 ${report.issues.length - 30} 项，见 meta/adopt-report.json`);
  out.push('', `人名候选 ${report.nameCandidates.length} 个（只是线索，不等于角色）：`,
    '  ' + (report.nameCandidates.slice(0, 20).map((c) => `${c.name}(${c.n})`).join('、') || '无'));
  out.push('', '下一步：',
    '  1. 处理上面的待确认项 —— 章节序错了，之后所有跨章规则都会稳定地报错',
    '  2. 给要长期管理的人名建角色卡（bible/characters/），其余杂名加进 lexicon.allowlist',
    '  3. 补 bible/world 的地点与规则条目；地名候选没有可靠抽取器，需人工列',
    '  4. 每章填 summary（前情摘要靠它），然后 node scripts/nw-validate.mjs 与 nw-continuity.mjs 各跑一遍');
  return out.join('\n');
}

/** 目录树哈希：path 排序 + 内容哈希，用于幂等判断与 sync 的 baseTreeHash。 */
function treeHash(dir) {
  const files = [];
  (function walk(d, rel = '') {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.tmp-')) continue;
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else files.push([r, fs.readFileSync(abs)]);
    }
  })(dir);
  const h = crypto.createHash('sha256');
  for (const [name, buf] of files) h.update(name).update('\0').update(buf).update('\0');
  return 'sha256:' + h.digest('hex');
}

switch (sub) {
  case 'locate': {
    const project = findProject(flags.dir ? path.resolve(flags.dir) : baseDir);
    if (!project) emit(json, { found: false, from: baseDir }, `未在 ${baseDir} 及其祖先找到 ${PROJECT_DIR}/${PROJECT_FILE}`);
    else {
      const books = bookDirs(project).map((b) => ({ slug: b.slug, id: b.id, title: b.title, dir: b.dir, exists: fs.existsSync(path.join(b.dir, 'book.json')) }));
      emit(json, { found: true, root: project.root, file: project.file, books },
        `项目根：${project.root}\n` + books.map((b) => `  ${b.exists ? '✓' : '✗'} ${b.slug}  ${b.dir}`).join('\n'));
    }
    process.exit(project ? EXIT.OK : EXIT.USAGE);
    break;
  }

  case 'init': {
    const title = flags.title;
    if (!title) fail('init 需要 --title');
    const slug = flags.slug || NWText.slugify(title);
    const root = path.join(baseDir, PROJECT_DIR);
    const id = flags.id || `novel_${crypto.randomUUID().slice(0, 8)}`;
    const existing = readJson(path.join(root, PROJECT_FILE), null);
    if (existing?.books?.some((b) => b.slug === slug)) {
      emit(json, { created: false, slug, dir: path.join(root, slug), reason: 'exists' }, `书 ${slug} 已存在，未做任何修改（init 幂等）`);
      process.exit(EXIT.PENDING);
    }
    fs.mkdirSync(root, { recursive: true });
    const dir = scaffoldBook(root, { slug, id, title, genre: flags.genre || '玄幻', description: flags.description || '' });
    upsertProject(root, { slug, id, title, path: slug });
    emit(json, { created: true, slug, id, dir }, `已创建 ${dir}`);
    process.exit(EXIT.OK);
    break;
  }

  /**
   * adopt —— 把已有的散稿目录纳入管理。
   *
   * 三条硬规矩：
   * 1. 草稿只读。本命令一个源文件都不改，写出去的全在新书目录里，随时可整目录删掉重来。
   * 2. 判不出来的不猜。编号/标题拿不准就进 issues，并用退出码 6 逼人来处理 ——
   *    建档是入口，入口排错了章节序，后面所有跨章规则都会稳定地报出错误结论。
   * 3. 人名候选用 R9 同一个识别器（NWRules.entityCandidates），
   *    不会出现「建档时看得见、检查时看不见」。
   */
  case 'adopt': {
    const srcDir = positional[0] ? path.resolve(positional[0]) : fail('adopt 需要草稿目录：nw-io.mjs adopt <目录> --title 书名');
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) fail(`不是目录：${srcDir}`);
    if (!flags.title) fail('adopt 需要 --title（书名用于目录与 slug）');

    const drafts = [];
    const alreadyStructured = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.') || e.name === PROJECT_DIR) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!/\.(md|txt|markdown)$/i.test(e.name)) continue;
        const text = fs.readFileSync(abs, 'utf8');
        // 已经是 NovelWeave 稿子的不重复建档
        if (/^---\r?\n[\s\S]{0,600}?^id:\s*ch-\d+/m.test(text)) { alreadyStructured.push(path.relative(srcDir, abs)); continue; }
        drafts.push({ name: path.basename(e.name), rel: path.relative(srcDir, abs), text });
      }
    })(srcDir);
    if (!drafts.length) fail(`${srcDir} 里没有可建档的 .md/.txt 草稿${alreadyStructured.length ? `（${alreadyStructured.length} 个文件已是 NovelWeave 格式）` : ''}`);

    const plan = NWDraft.planAdopt(drafts);
    // id 取自章号，让 id / 文件名 / 章号三者一致；否则会出现 id ch-001 对应 number 0
    // 这种错位，引用断链检查指向错误的章。
    const chId = (n) => `ch-${String(n).padStart(3, '0')}`;
    const candidates = NWRules.entityCandidates(
      { chapters: plan.chapters.map((c) => ({ id: chId(c.number), body: c.body })), characters: [], world: [], lexicon: null },
      { minCount: 2, minChapters: 1, limit: 40, exclude: false },
    );
    const report = {
      schemaVersion: SCHEMA_VERSION,
      adoptedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      source: srcDir,
      stats: { ...plan.stats, skippedStructured: alreadyStructured.length, nameCandidates: candidates.length },
      issues: plan.issues,
      unresolved: plan.unresolved,
      nameCandidates: candidates.map((c) => ({ name: c.name, n: c.n, chapters: c.chapters.length })),
      // 地名候选没有可靠抽取器：常见后缀（门/城/山）与普通名词高度重叠，
      // 宁可让作者自己列，也不塞一份看着像、实则噪声占多数，会教人学会忽略它。
      note: '人名候选只是线索，不等于角色；未登记地名需自行补进 bible/world。',
    };

    // 本文件的参数解析保留连字符：是 flags['dry-run']，写成 flags.dryRun 会静默失效
    if (flags['dry-run']) {
      emit(json, { dryRun: true, ...report }, () => humanAdopt(report, null));
      process.exit(report.issues.length ? EXIT.PENDING : EXIT.OK);
    }
    if (report.unresolved.length) {
      emit(json, { adopted: false, reason: 'unresolved', ...report },
        () => `${report.unresolved.length} 个文件判不出章号，未建档：${report.unresolved.join('、')}\n`
          + '请给它们改出章号（文件名或正文首行写「第N章」）再跑；不猜章序，因为排错序会让后面每条跨章规则都稳定地报错。');
      process.exit(EXIT.USAGE);
    }
    // 章号现在就是 id：重号等于两章抢同一个 id，会静默覆盖。所以从"警告"升级成"拒建"。
    const dup = plan.issues.find((i) => i.kind === 'duplicate-number');
    if (dup) {
      emit(json, { adopted: false, reason: 'duplicate-number', ...report },
        () => `第${dup.number}章重号：${dup.files.join('、')}。章号会直接变成 id，重号等于覆盖，未建档。请先改掉重号再跑。`);
      process.exit(EXIT.USAGE);
    }

    const root = path.join(baseDir, PROJECT_DIR);
    const slug = flags.slug || NWText.slugify(flags.title);
    const existing = readJson(path.join(root, PROJECT_FILE), null);
    if (existing?.books?.some((b) => b.slug === slug)) {
      emit(json, { adopted: false, slug, reason: 'exists' }, `书 ${slug} 已存在，未做任何修改（adopt 幂等；要重来请先删该目录）`);
      process.exit(EXIT.PENDING);
    }
    fs.mkdirSync(root, { recursive: true });
    const dir = scaffoldBook(root, { slug, id: flags.id || `novel_${crypto.randomUUID().slice(0, 8)}`, title: flags.title, genre: flags.genre || '玄幻', description: flags.description || '' });
    upsertProject(root, { slug, id: JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8')).id, title: flags.title, path: slug });

    plan.chapters.forEach((c, i) => {
      const id = chId(c.number);
      const meta = NWBible.newChapter({
        id, number: c.number, slug: NWText.slugify(c.title) || `c${i + 1}`, title: c.title,
        status: 'draft', summary: '', 'x-words': c.words,
      });
      meta.schemaVersion = SCHEMA_VERSION;
      saveChapter(dir, meta, c.body);
    });
    writeJsonAtomic(path.join(dir, 'meta', 'adopt-report.json'), report);
    recountBook(dir);
    emit(json, { adopted: true, dir, ...report }, () => humanAdopt(report, dir));
    process.exit(report.issues.length ? EXIT.PENDING : EXIT.OK);
    break;
  }

  case 'export': {
    const bookDir = flags.book ? path.resolve(flags.book) : (bookDirs(findProject(baseDir) || { project: { books: [] } })[0]?.dir);
    if (!bookDir || !fs.existsSync(path.join(bookDir, 'book.json'))) fail('找不到要导出的书，请用 --book 指定目录');
    const out = path.resolve(flags.out || path.join(baseDir, 'exports'));
    const target = path.join(out, path.basename(bookDir) + '-' + new Date().toISOString().slice(0, 10));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(bookDir, target, { recursive: true });
    const hash = treeHash(target);
    emit(json, { source: bookDir, target, treeHash: hash }, `已导出到 ${target}\n${hash}`);
    process.exit(EXIT.OK);
    break;
  }

  case 'import': {
    if (!flags.web || !flags.file) fail('import 目前支持 --web --file <backup.json>');
    const dump = readJson(path.resolve(flags.file));
    if (!dump?.data?.novels) fail('备份文件里没有 data.novels，不是织文导出的备份');
    if (dump.schemaVersion !== 1) fail(`暂只支持备份 schemaVersion 1，收到 ${dump.schemaVersion}`, EXIT.NEEDS_MIGRATION);

    const root = path.join(baseDir, PROJECT_DIR);
    fs.mkdirSync(root, { recursive: true });
    const made = [];
    for (const n of dump.data.novels) {
      const slug = NWText.slugify(n.title);
      const dir = scaffoldBook(root, { slug, id: n.id, title: n.title, genre: n.genre, description: n.description });
      upsertProject(root, { slug, id: n.id, title: n.title, path: slug });
      const book = readJson(path.join(dir, 'book.json'));
      book.created = NWText.toISO(n.created_at) || book.created;
      book.updated = NWText.toISO(n.updated_at) || book.updated;
      writeJsonAtomic(path.join(dir, 'book.json'), book);

      const chs = (dump.data.chapters || []).filter((c) => c.novel_id === n.id).sort((a, b) => (a.order || 0) - (b.order || 0));
      chs.forEach((c, i) => {
        const number = i + 1;
        const meta = NWBible.newChapter({
          id: c.id, number, slug: NWText.slugify(c.title), title: c.title,
          status: (c.content || '').trim() ? 'draft' : 'outline',
          'x-words': NWText.countWords(c.content), 'x-updated': NWText.toISO(c.updated_at),
        });
        meta.schemaVersion = SCHEMA_VERSION;
        writeFileAtomic(path.join(dir, 'manuscript', 'chapters', NWBible.chapterFileName(meta)), NWBible.serializeChapterFile(meta, c.content || ''));
      });

      const charIds = new Map();
      for (const c of dump.data.characters || []) {
        if (c.novel_id !== n.id) continue;
        const mapped = NWBible.ROLE_MAP[c.role];
        const rec = NWBible.defaultCharacter({
          schemaVersion: SCHEMA_VERSION, id: c.id, slug: NWText.slugify(c.name), name: c.name,
          role: mapped || 'minor', status: 'alive', personality: c.personality || '',
          appearance: { summary: c.appearance || '', tokens: [] }, background: c.background || '',
          notes: c.notes || '', created: NWText.toISO(c.created_at),
        });
        if (!mapped && c.role) rec._derived = { 'role-mapping-needed': c.role };
        charIds.set(c.id, rec);
        writeJsonAtomic(path.join(dir, 'bible', 'characters', `${c.id}.json`), rec);
      }
      for (const w of dump.data.worldbuilding || []) {
        if (w.novel_id !== n.id) continue;
        const rec = NWBible.defaultWorldEntry({
          schemaVersion: SCHEMA_VERSION, id: w.id, slug: NWText.slugify(w.name), name: w.name,
          comment: w.name, keys: [w.name], type: w.type || 'custom', content: w.description || '',
          details: w.details || {}, constant: w.type === 'rule' || w.type === 'system',
          created: NWText.toISO(w.created_at),
        });
        writeJsonAtomic(path.join(dir, 'bible', 'world', `${w.id}.json`), rec);
      }
      for (const [i, c] of chs.entries()) {
        const file = path.join(dir, 'manuscript', 'chapters', NWBible.chapterFileName({ number: i + 1, slug: NWText.slugify(c.title) }));
        if (!fs.existsSync(file)) continue;
        const { data, body } = NWBible.parseFrontmatter(fs.readFileSync(file, 'utf8'));
        data.characters = [...charIds.values()].filter((rec) => (c.content || '').includes(rec.name)).map((rec) => rec.id);
        writeFileAtomic(file, NWBible.serializeChapterFile(data, body));
      }
      // 带「伏笔」标签的笔记 → 登记表里的 candidate，等作者确认，不当作正式登记
      const promises = readJson(path.join(dir, 'bible', 'promises.json'), NWBible.emptyPromises());
      for (const note of dump.data.notes || []) {
        if (note.novel_id !== n.id) continue;
        if ((note.tags || []).includes('伏笔') || /伏笔/.test(note.title || '')) {
          promises.items.push({
            id: `p-${String(promises.items.length + 1).padStart(3, '0')}`, type: 'promise',
            title: note.title, status: 'planned', weight: 'candidate',
            setup: { chapter: null, evidence: (note.content || '').slice(0, 200) },
            payoff: { chapter: null, due: null }, notes: '由旧笔记迁移，待作者确认',
            created: NWText.toISO(note.created_at),
          });
        } else {
          writeJsonAtomic(path.join(dir, 'meta', 'notes', `${note.id}.json`), {
            schemaVersion: SCHEMA_VERSION, id: note.id, title: note.title, content: note.content,
            tags: note.tags || [], created: NWText.toISO(note.created_at),
          });
        }
      }
      if (promises.items.length) writeJsonAtomic(path.join(dir, 'bible', 'promises.json'), promises);

      const lex = NWBible.emptyLexicon();
      for (const rec of charIds.values()) lex.names[rec.name] = rec.id;
      writeJsonAtomic(path.join(dir, 'bible', 'lexicon.json'), lex);

      const sync = { schemaVersion: SCHEMA_VERSION, novelId: n.id, bookSlug: slug, exportedAt: null, baseTreeHash: null, records: {} };
      for (const rec of charIds.values()) sync.records[`character:${rec.id}`] = { hash: authorHash(rec), rev: 1, source: 'import', at: new Date().toISOString() };
      writeJsonAtomic(path.join(dir, 'meta', 'sync.json'), sync);
      const derived = recomputeDerived(dir);
      made.push({ slug, dir, chapters: chs.length, characters: charIds.size, promises: promises.items.length, words: derived.words });
    }
    emit(json, { imported: made }, made.map((m) => `《${m.slug}》${m.chapters} 章 / ${m.characters} 角色 / ${m.promises} 条伏笔候选\n  ${m.dir}`).join('\n'));
    process.exit(EXIT.OK);
    break;
  }

  case 'recount': {
    const dir = resolveBookDir(positional);
    if (!dir) fail('未找到书目录，请显式传入 bookDir');
    const r = recountBook(dir);
    emit(json, { bookDir: dir, ...r }, `已重算：${r.total} 章中 ${r.chaptersRewritten} 章的 x-words 被修正；全书 ${r.words} 字 / ${r.chapters} 章 / ${r.characters} 角色`);
    process.exit(EXIT.OK);
    break;
  }

  case 'migrate': {
    const project = findProject(baseDir);
    if (!project) fail('未找到项目');
    const stale = (project.project.books || []).map((b) => {
      const book = readJson(path.join(project.root, b.path, 'book.json'), {});
      return { slug: b.slug, from: book.schemaVersion || null, to: SCHEMA_VERSION };
    }).filter((x) => x.from !== SCHEMA_VERSION);
    if (!stale.length) emit(json, { needed: false }, '所有书都已是当前 schema 版本');
    else emit(json, { needed: true, books: stale }, `需要迁移：${stale.map((s) => `${s.slug}(${s.from}→${s.to})`).join(', ')}\n（v1 阶段尚无历史版本可迁，先保留命令占位）`);
    process.exit(stale.length ? EXIT.NEEDS_MIGRATION : EXIT.OK);
    break;
  }

  default:
    fail('用法：nw-io.mjs <locate|init|export|import|migrate> [options]', EXIT.USAGE);
}
