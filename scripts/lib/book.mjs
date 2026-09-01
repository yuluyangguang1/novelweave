/**
 * NovelWeave · Story Bible 读写层（Node，零依赖）
 *
 * 五份 CLI 共用这一层，避免各写一套 IO 而在细节上分叉。
 * 核心模块从 src/core 加载 —— 与浏览器用的是同一份代码，
 * 所以 Web 面板与命令行产出的诊断、哈希、字数必然一致。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = (name) => path.join(repoRoot, 'src', 'core', name);

globalThis.self = globalThis;
globalThis.window = globalThis;
export const NWText = (globalThis.NWText = require(core('text.js')));
export const NWBible = (globalThis.NWBible = require(core('bible.js')));
export const NWRules = (globalThis.NWRules = require(core('rules.js')));
export const NWStory = (globalThis.NWStory = require(core('story.js')));
export const NWProject = (globalThis.NWProject = require(core('project.js')));
export const NWContext = (globalThis.NWContext = require(core('context.js')));
export const NWDraft = (globalThis.NWDraft = require(core('draft.js')));
export const NovelLLM = (globalThis.NovelLLM = require(core('llm.js')));
// story / project 提供「什么算作者内容」的唯一投影与记录标识。CLI 必须用同一份，
// 否则 sync.json 的基线哈希会与 Web 端算出来的不一致，导入时全是假冲突。

export const PROJECT_DIR = '.novelweave';
export const PROJECT_FILE = 'project.json';
export const SCHEMA_VERSION = NWBible.SCHEMA_VERSION;

export const schemaPath = path.join(repoRoot, 'schemas', 'story-bible.v1.json');

export function readSchema() {
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

// ═══════════ 基础 IO ═══════════

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${file} 不是合法 JSON：${e.message}`);
  }
}

/** 原子写：先写 tmp 再 rename，避免中途崩溃留下半个文件把书毁掉。 */
export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function sha256(str) {
  return 'sha256:' + crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

/** 只对作者字段取哈希：派生字段被脚本重写不该被当成冲突。 */
export function authorHash(record) {
  return sha256(NWText.canonicalJson(NWBible.authorFields(record)));
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

// ═══════════ 项目定位 ═══════════

/** 从给定目录向上找 .novelweave/project.json。agent 不需要用户告诉它书在哪。 */
export function findProject(from = process.cwd()) {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, PROJECT_DIR);
    if (fs.existsSync(path.join(candidate, PROJECT_FILE))) {
      return { root: candidate, file: path.join(candidate, PROJECT_FILE), project: readJson(path.join(candidate, PROJECT_FILE)) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function bookDirs(project) {
  return (project.project.books || []).map((b) => ({ ...b, dir: path.join(project.root, b.path) }));
}

/** 显式路径优先；否则从 cwd 向上找项目，单本书时自动选中。 */
export function resolveBookDir(positional = []) {
  if (positional[0]) return path.resolve(positional[0]);
  const project = findProject();
  if (!project) return null;
  const dirs = bookDirs(project);
  if (dirs.length === 1) return dirs[0].dir;
  return null;
}

/** 只读入口：把一本书装配成 rules.js 需要的 ctx。 */
export function loadBook(bookDir, opts = {}) {
  const book = readJson(path.join(bookDir, 'book.json'));
  if (!book) throw new Error(`${bookDir} 下没有 book.json`);

  const chaptersDir = path.join(bookDir, 'manuscript', 'chapters');
  const chapters = fs.existsSync(chaptersDir)
    ? fs.readdirSync(chaptersDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => {
          const { data, body } = NWBible.parseFrontmatter(fs.readFileSync(path.join(chaptersDir, f), 'utf8'));
          return {
            file: f,
            meta: data,
            id: data.id ?? f.replace(/\.md$/, ''),
            number: data.number,
            title: data.title ?? '',
            status: data.status,
            slug: data.slug,
            pov: data.pov ?? null,
            time_anchor: data.time_anchor ?? null,
            characters: data.characters || [],
            mentions: data.mentions || [],
            locations: data.locations || [],
            flags: data.flags || [],
            summary: data.summary || '',
            info_control: data.info_control || null,
            xWords: data['x-words'] ?? null,
            body,
          };
        })
    : [];
  chapters.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  const dirOf = (...segs) => path.join(bookDir, 'bible', ...segs);
  const characters = readIndex(dirOf('characters'));
  const world = readIndex(dirOf('world'));

  return {
    bookDir,
    book,
    chapters,
    characters,
    world,
    promises: readJson(dirOf('promises.json'), NWBible.emptyPromises()),
    states: readJson(dirOf('states.json'), NWBible.emptyStates()),
    timeline: readJson(dirOf('timeline.json'), NWBible.emptyTimeline()),
    lexicon: readJson(dirOf('lexicon.json'), NWBible.emptyLexicon()),
    relations: readJson(dirOf('relations.json'), { edges: [] }),
    suppressions: readJson(path.join(bookDir, 'continuity', 'suppressions.json'), { items: [] }),
    pending: readJson(path.join(bookDir, 'continuity', 'pending.json'), { items: [] }),
    sync: readJson(path.join(bookDir, 'meta', 'sync.json'), { records: {} }),
    schema: opts.schema === false ? null : readSchema(),
    chapterNumbers: new Map(chapters.map((c) => [c.id, c.number])),
  };
}

/** 目录内每个 json 一条记录；_ 开头的文件（_index.json）是索引，不算记录。 */
function readIndex(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => readJson(path.join(dir, f)));
}

export function saveChapter(bookDir, meta, body) {
  const m = { ...meta };
  const file = path.join(bookDir, 'manuscript', 'chapters', NWBible.chapterFileName(m));
  writeFileAtomic(file, NWBible.serializeChapterFile(m, body));
  return file;
}

export function chapterFileOf(bookDir, ch) {
  return path.join(bookDir, 'manuscript', 'chapters', ch.file || NWBible.chapterFileName(ch));
}

export function saveRecord(bookDir, kind, record) {
  const sub = kind === 'characters' ? 'characters' : kind === 'world' ? 'world' : kind;
  const file = path.join(bookDir, 'bible', sub, `${record.id}.json`);
  writeJsonAtomic(file, record);
  refreshIndex(path.join(bookDir, 'bible', sub), kind === 'world'
    ? { schemaVersion: SCHEMA_VERSION, ids: [], order: [], scan_depth: 6, token_budget: 1400, recursive_scanning: true }
    : { schemaVersion: SCHEMA_VERSION, ids: [], order: [] });
  return file;
}

function refreshIndex(dir, base) {
  const ids = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.replace(/\.json$/, '')).sort()
    : [];
  writeJsonAtomic(path.join(dir, '_index.json'), { ...base, ids, order: ids.map((_, i) => i) });
}

// ═══════════ 脚手架 ═══════════

export function scaffoldBook(root, { slug, id, title, genre = '玄幻', description = '' }) {
  const dir = path.join(root, slug);
  const book = NWBible.defaultBook({ schemaVersion: SCHEMA_VERSION, id, slug, title, genre, description });
  book.created = new Date().toISOString();
  book.updated = book.created;
  // 未跑过校验就不写 errors/warns，否则 0 会被误读成「检查过，没问题」
  book._derived = { chapters: 0, words: 0, characters: 0, lastChecked: null };

  writeJsonAtomic(path.join(dir, 'book.json'), book);
  for (const sub of ['manuscript/chapters', 'bible/characters', 'bible/world', 'continuity/reports', 'meta']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.mkdirSync(path.join(root, '..', 'conflicts'), { recursive: true });

  const promisesFile = path.join(dir, 'bible', 'promises.json');
  if (!fs.existsSync(promisesFile)) writeJsonAtomic(promisesFile, NWBible.emptyPromises());
  for (const [f, empty] of [['states.json', NWBible.emptyStates()], ['timeline.json', NWBible.emptyTimeline()], ['lexicon.json', NWBible.emptyLexicon()], ['relations.json', { schemaVersion: SCHEMA_VERSION, edges: [] }]]) {
    const p = path.join(dir, 'bible', f);
    if (!fs.existsSync(p)) writeJsonAtomic(p, empty);
  }
  for (const [f, empty] of [['suppressions.json', { schemaVersion: SCHEMA_VERSION, items: [] }], ['pending.json', { schemaVersion: SCHEMA_VERSION, items: [] }], ['snapshot.json', { schemaVersion: SCHEMA_VERSION, validatedAt: null, reports: {} }]]) {
    const p = path.join(dir, 'continuity', f);
    if (!fs.existsSync(p)) writeJsonAtomic(p, empty);
  }
  const syncFile = path.join(dir, 'meta', 'sync.json');
  if (!fs.existsSync(syncFile)) writeJsonAtomic(syncFile, { schemaVersion: SCHEMA_VERSION, novelId: id, bookSlug: slug, exportedAt: null, baseTreeHash: null, records: {} });
  const outline = path.join(dir, 'manuscript', 'outline.md');
  if (!fs.existsSync(outline)) writeFileAtomic(outline, `# ${title} · 大纲\n\n类型：${genre}\n\n${description ? '概述：' + description + '\n\n' : ''}## 卷结构\n\n- 第一卷：\n`);
  writeIndexMd(dir, book);
  return dir;
}

/**
 * 重算并写回 book._derived。派生量只有这一个出口 ——
 * 任何写过章节/角色的流程收尾都必须调它，否则刚建好的书立刻自报 derived-field-touched。
 */
export function recomputeDerived(bookDir) {
  const ctx = loadBook(bookDir, { schema: false });
  const book = ctx.book;
  book._derived = {
    ...(book._derived || {}),
    chapters: ctx.chapters.length,
    words: ctx.chapters.reduce((s, c) => s + NWText.countWords(c.body), 0),
    characters: ctx.characters.length,
  };
  book.updated = new Date().toISOString();
  writeJsonAtomic(path.join(bookDir, 'book.json'), book);
  return book._derived;
}

/**
 * 重算全部派生字段（章节 x-words + book._derived）。
 * 校验器的建议里承诺了「跑一次重算」，这个命令就是那句承诺的落点。
 */
export function recountBook(bookDir) {
  const ctx = loadBook(bookDir, { schema: false });
  const chaptersDir = path.join(bookDir, 'manuscript', 'chapters');
  let changed = 0;
  for (const ch of ctx.chapters) {
    const actual = NWText.countWords(ch.body);
    if (ch.xWords === actual) continue;
    const meta = { ...ch.meta, 'x-words': actual };
    writeFileAtomic(path.join(chaptersDir, ch.file), NWBible.serializeChapterFile(meta, ch.body));
    changed++;
  }
  const derived = recomputeDerived(bookDir);
  return { ...derived, chaptersRewritten: changed, total: ctx.chapters.length };
}

export function writeIndexMd(dir, book) {
  const lines = [
    `# ${book.title} · 文件索引`,
    '',
    '本文件由脚本生成，供人快速定位。结构化权威在各 json 与章节 frontmatter。',
    '',
    '| 域 | 文件 | 说明 |',
    '| --- | --- | --- |',
    '| 书目 | `book.json` | 元数据、叙事声音、目标体量 |',
    '| 大纲 | `manuscript/outline.md` | 卷/幕级 |',
    '| 正文 | `manuscript/chapters/*.md` | frontmatter + 正文，权威文本 |',
    '| 角色 | `bible/characters/*.json` | 状态与外貌区间 |',
    '| 世界 | `bible/world/*.json` | 字段对齐 Character Card V2 |',
    '| 伏笔 | `bible/promises.json` | 埋设/回收登记 |',
    '| 状态 | `bible/states.json` | 分章快照，v1 六维 |',
    '| 时间线 | `bible/timeline.json` | 锚点与跨度 |',
    '| 词典 | `bible/lexicon.json` | 名字 → 实体 id |',
    '| 校验 | `continuity/` | 快照、报告、豁免、待确认 |',
    '',
    `Schema：v${book.schemaVersion || SCHEMA_VERSION}`,
    '',
  ];
  writeFileAtomic(path.join(dir, '_index.md'), lines.join('\n'));
}

/** 更新 project.json 的书注册表（幂等）。 */
export function upsertProject(root, bookEntry) {
  const file = path.join(root, PROJECT_FILE);
  const project = readJson(file, { schemaVersion: SCHEMA_VERSION, books: [] });
  project.books = project.books || [];
  const i = project.books.findIndex((b) => b.slug === bookEntry.slug);
  if (i >= 0) project.books[i] = { ...project.books[i], ...bookEntry };
  else project.books.push(bookEntry);
  project.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, project);
  return project;
}

// ═══════════ 输出约定 ═══════════

/** stdout 只放结果，stderr 只放人类日志 —— 这样 agent 可以稳定地管道消费。
 *  human 允许是字符串或渲染函数（传函数时只在非 --json 分支才真的拼字符串）。 */
export function emit(json, payload, human) {
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  const text = typeof human === 'function' ? human() : (human ?? JSON.stringify(payload, null, 2));
  process.stdout.write(String(text) + '\n');
}

export function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

/** 全局退出码约定，五份 CLI 共用。 */
export const EXIT = { OK: 0, ERROR_FOUND: 1, USAGE: 2, BROKEN: 3, NEEDS_MIGRATION: 4, IO: 5, PENDING: 6 };

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

export async function sha256File(file) {
  const buf = await fsp.readFile(file);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}
