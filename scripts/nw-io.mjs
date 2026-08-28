#!/usr/bin/env node
/**
 * nw-io.mjs — 项目定位、建档、导入导出、迁移
 *
 * 用法：
 *   node scripts/nw-io.mjs locate [--dir PATH] [--json]
 *   node scripts/nw-io.mjs init --title 书名 [--genre 玄幻] [--slug s] [--dir PATH]
 *   node scripts/nw-io.mjs export [--out DIR] [--book DIR]
 *   node scripts/nw-io.mjs import --web --file backup.json [--dir PATH]
 *   node scripts/nw-io.mjs recount [bookDir]
 *   node scripts/nw-io.mjs migrate [--dry-run]
 *
 * 退出码：0 成功 · 2 用法错 · 4 需要迁移 · 5 IO 错 · 6 有对象已存在（幂等提示）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PROJECT_DIR, PROJECT_FILE, SCHEMA_VERSION, NWBible, NWText,
  findProject, bookDirs, resolveBookDir, readJson, writeJsonAtomic, writeFileAtomic,
  scaffoldBook, upsertProject, recomputeDerived, recountBook, emit, log, EXIT, authorHash,
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
