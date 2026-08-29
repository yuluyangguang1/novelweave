#!/usr/bin/env node
/**
 * nw-prose.mjs — 文体（去 AI 味）检查的**交接**机制，不是文体引擎
 *
 * 为什么要有这个文件：SKILL.md 早就写了「句子级文笔诊断让位给文体分析类 skill」，
 * 但那句话没有任何机制支撑 —— 实际发生的是续写完一章，没人看文字质感，
 * 那一章带着 AI 味就进稿了。本脚本只做三件事：探本机真有什么引擎、把该交给它的
 * 东西打包、把结论记进台账。**判断文字好坏仍然不是我们的活。**
 *
 * 用法：
 *   node scripts/nw-prose.mjs probe [--home DIR] [--json]
 *   node scripts/nw-prose.mjs packet [bookDir] --chapter ch-003 [--engine ID] [--json]
 *   node scripts/nw-prose.mjs record [bookDir] --chapter ch-003 --engine ID
 *        --result clean|issues|skipped [--findings N] [--note "..."]
 *   node scripts/nw-prose.mjs status [bookDir] [--home DIR] [--json]
 *
 * 退出码：0 · 2 用法错 · 5 IO 错。
 * 文体状态**永不阻断**：它是建议。与 nw-continuity 的机器门禁混在一起，
 * 会让 CI 因为「这台机器没装第三方技能」而变红，那是假失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadBook, resolveBookDir, chapterFileOf, parseArgs, emit, log, EXIT, expandHome,
  readJson, writeJsonAtomic, NWBible, NWProject, NWText,
} from './lib/book.mjs';

/** 交接边界只写一次，JSON 与人类可读输出共用同一份。 */
const BOUNDARY = [
  '只诊断，不替作者改写正文；要改由作者点头',
  '本 skill 不判断文笔好坏，交接包里的清单来自被交接的引擎',
  '改完必须重跑 nw-continuity —— 换句子会挪动证据偏移，R1/R7 的定位跟着失效',
  '结论用 nw-prose record 写回台账；不写，这一章在 status 里永远是「未查」',
];

const pathToFile = (p) => String(p).split(path.sep).join('/');

// ═══════════ 引擎目录 ═══════════
// 刻意不 import tools/agents.mjs：那份表说的是「我们的技能装到哪儿」，
// 这里说的是「别人家的文体技能长什么样」，两件事会变，且 tools/ 不在安装负载里。

/** bins：PATH 上找得到就算数；files：技能目录里必须有真文件才算数。 */
const ENGINES = [
  {
    id: 'ironprose', label: 'IronProse CLI', kind: 'cli',
    bins: ['ironprose'],
    how: 'ironprose lint <章节文件> --format json',
    note: '句子级规则最多（弱动词/被动/陈词/重复）。默认调远端 API，离线机器上不可用',
    network: true,
  },
  {
    id: 'story-deslop', label: 'oh-story 去 AI 味', kind: 'checklist',
    names: ['story-deslop'],
    files: ['references/banned-words.md', 'references/anti-ai-writing.md'],
    how: '读该技能 SKILL.md，按禁用词表逐条扫本章正文',
  },
  {
    id: 'chinese-novelist', label: 'chinese-novelist 质量清单', kind: 'checklist',
    names: ['chinese-novelist'],
    files: ['references/quality-checklist.md'],
    how: '取其中「去 AI 味」与「钩子」两节自查，不要跑它的批量成稿流程',
  },
  {
    id: 'novelwriter', label: 'novelwriter（自称集成 humanizer-zh）', kind: 'checklist',
    names: ['novelwriter'],
    files: ['references', 'templates', 'experience'],
    how: '仅当它真的带了清单文件时才用',
  },
];

/** 技能根：depth≤2 内找带 SKILL.md 的目录（Hermes 是 category 嵌套的）。 */
const SKILL_ROOTS = [
  '~/.qoder/skills', '~/.claude/skills', '~/.codex/skills', '~/.openclaw/skills',
  '~/.hermes/skills', '~/.workbuddy/skills', '~/.cursor/skills', '~/.zcode/skills',
];

function skillDirs(roots, home) {
  const found = [];
  for (const r of roots) {
    const base = home ? path.join(home, r.replace(/^~\//, '')) : expandHome(r);
    if (!fs.existsSync(base)) continue;
    const label = path.basename(path.dirname(base)) + '/' + path.basename(base);
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(base, e.name);
      if (fs.existsSync(path.join(p, 'SKILL.md'))) found.push({ name: e.name, dir: p, via: label });
      // 两级：<root>/<category>/<skill>/SKILL.md
      let sub = [];
      try { sub = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
      for (const s of sub) {
        if (!s.isDirectory()) continue;
        const sp = path.join(p, s.name);
        if (fs.existsSync(path.join(sp, 'SKILL.md'))) found.push({ name: s.name, dir: sp, via: label });
      }
    }
  }
  return found;
}

function onPath(bins) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const bin of bins) {
    for (const d of dirs) {
      for (const ext of exts) {
        try { if (fs.statSync(path.join(d, bin + ext)).isFile()) return path.join(d, bin + ext); } catch { /* 继续找 */ }
      }
    }
  }
  return null;
}

/**
 * 探测。usable=false 也要报出来，并说清为什么 ——
 * 「技能目录在但没有任何清单文件」这一类空承诺，只有探过文件才知道。
 */
function probe({ home }) {
  const dirs = skillDirs(SKILL_ROOTS, home);
  const out = [];
  for (const spec of ENGINES) {
    if (spec.kind === 'cli') {
      const bin = onPath(spec.bins);
      out.push({
        id: spec.id, label: spec.label, kind: spec.kind, how: spec.how, note: spec.note || '',
        network: !!spec.network, usable: !!bin,
        path: bin || null,
        why: bin ? '' : 'PATH 上没有该可执行文件',
      });
      continue;
    }
    const hits = dirs.filter((d) => (spec.names || []).includes(d.name));
    if (!hits.length) {
      out.push({ id: spec.id, label: spec.label, kind: spec.kind, how: spec.how, note: spec.note || '',
        network: false, usable: false, path: null, why: '本机各 agent 技能目录里没装' });
      continue;
    }
    const present = [];
    for (const h of hits) {
      for (const f of spec.files || []) {
        const p = path.join(h.dir, f);
        if (fs.existsSync(p)) present.push(p);
      }
    }
    out.push({
      id: spec.id, label: spec.label, kind: spec.kind, how: spec.how, note: spec.note || '',
      network: false,
      usable: present.length > 0,
      path: hits[0].dir, via: hits.map((h) => h.via).join(', '),
      files: present.map((p) => pathToFile(p)),
      // 装了名字但没有文件 = 用不了。这是实测出来的坑，不是假设。
      why: present.length ? '' : '技能目录在，但声明的清单文件一个都不存在，等于没有能力',
    });
  }
  return out;
}

// ═══════════ 台账 ═══════════

const LEDGER_REL = ['continuity', 'prose.json'];
const RESULTS = ['clean', 'issues', 'skipped'];

function readLedger(bookDir) {
  const file = path.join(bookDir, ...LEDGER_REL);
  const data = readJson(file, null);
  if (!data) return { schemaVersion: NWBible.SCHEMA_VERSION, byChapter: {} };
  if (data.schemaVersion !== NWBible.SCHEMA_VERSION) {
    throw new Error(`prose.json 的 schemaVersion=${data.schemaVersion}，本脚本认 ${NWBible.SCHEMA_VERSION}；先迁移再跑，不猜`);
  }
  data.byChapter = data.byChapter || {};
  return data;
}

/** 只有正文算数：大纲章没有文字可查。 */
const isProse = (ch) => NWText.countWords(ch.body || '') >= 200;

async function statusOf(ctx, { home }) {
  const ledger = readLedger(ctx.bookDir);
  const rows = [];
  for (const ch of ctx.chapters) {
    if (!isProse(ch)) continue;
    const rec = ledger.byChapter[ch.id];
    const hash = await NWProject.hashRecord('chapter', ch);
    let state;
    if (!rec) state = 'unchecked';
    else if (rec.contentHash !== hash) state = 'stale';   // 查完又改过正文 = 结论作废
    else state = rec.result;
    rows.push({
      chapter: ch.id, number: ch.number, title: ch.title, state,
      words: NWText.countWords(ch.body || ''),
      engine: rec?.engine || null, at: rec?.at || null,
      findings: rec?.findings ?? null, note: rec?.note || '',
    });
  }
  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  return { book: ctx.book.slug || ctx.book.title, engines: probe({ home }), counts, rows, total: rows.length };
}

// ═══════════ 子命令 ═══════════

const { positional, flags } = parseArgs(process.argv.slice(2));
const sub = positional[0];
const rest = positional.slice(1);

if (!sub || !['probe', 'packet', 'record', 'status'].includes(sub)) {
  log('用法：nw-prose.mjs <probe|packet|record|status> [bookDir] [--chapter ID] [--engine ID] [--result clean|issues|skipped] [--json]');
  process.exit(EXIT.USAGE);
}

const home = flags.home ? path.resolve(String(flags.home)) : null;

if (sub === 'probe') {
  const engines = probe({ home });
  const usable = engines.filter((e) => e.usable);
  emit(!!flags.json, { engines, usable: usable.map((e) => e.id), recommended: usable[0]?.id || null }, () => [
    `文体引擎探测（本机 ${engines.length} 个候选）`, '',
    ...engines.map((e) => `${e.usable ? '✅' : '·'} ${e.id}${e.path ? ` — ${pathToFile(e.path)}` : ''}`
      + (e.usable ? '' : `（${e.why}）`)
      + (e.usable && e.files?.length ? `\n     清单：${e.files.map((f) => path.basename(f)).join('、')}` : '')
      + (e.usable ? `\n     用法：${e.how}` : '')
      + (e.note ? `\n     注意：${e.note}` : '')),
    '',
    usable.length ? `可用 ${usable.length} 个；交接：nw-prose packet --chapter <ID>` : '本机没有可用引擎。不要静默跳过 —— 用 record --result skipped 把原因记进台账。',
  ].join('\n'));
  process.exit(EXIT.OK);
}

const bookDir = resolveBookDir(rest);
if (!bookDir) { log('未找到书目录（给显式路径，或在含 .novelweave/project.json 的目录下运行）'); process.exit(EXIT.USAGE); }

let ctx;
try { ctx = loadBook(bookDir); } catch (e) { log(`读取失败：${e.message}`); process.exit(EXIT.IO); }

const chapterId = flags.chapter;
const chapter = chapterId ? ctx.chapters.find((c) => c.id === chapterId) : null;
if (chapterId && !chapter) { log(`章节不存在：${chapterId}`); process.exit(EXIT.USAGE); }

if (sub === 'packet') {
  if (!chapter) { log('packet 需要 --chapter <ID>'); process.exit(EXIT.USAGE); }
  const engines = probe({ home });
  const want = flags.engine ? engines.find((e) => e.id === flags.engine) : null;
  if (flags.engine && !want) { log(`未知引擎：${flags.engine}。先看 probe`); process.exit(EXIT.USAGE); }
  // 指定了引擎但它不可用时不降级到别的引擎：作者点名要的那个失败，比悄悄换一个更有用
  const engine = want || (engines.find((e) => e.usable) || null);
  const file = chapterFileOf(bookDir, chapter);
  const hasFile = fs.existsSync(file);
  const words = NWText.countWords(chapter.body || '');

  emit(!!flags.json, {
    chapter: chapter.id, title: chapter.title, words,
    file: hasFile ? pathToFile(file) : null,
    engine: engine ? { id: engine.id, kind: engine.kind, how: engine.how, files: engine.files || [],
      network: engine.network, usable: engine.usable, why: engine.why || '' } : null,
    boundary: BOUNDARY,
  }, () => [
    `文体检查交接包 · ${NWBible.chapterLabel(chapter)}（${words} 字）`, '',
    engine ? `交给：${engine.id}（${engine.kind}）${engine.usable ? '' : ` — 不可用：${engine.why}`}\n  ${engine.how}`
      : '本机没有可用引擎 —— 见 nw-prose probe 的候选与原因',
    engine?.files?.length ? `  清单：${engine.files.join('\n        ')}` : null,
    engine?.network ? '  注意：该引擎默认走远端 API，离线时不要指望它' : null,
    engine ? `  正文：${hasFile ? pathToFile(file) : '（找不到章节文件，先跑 nw-io export）'}` : null,
    '',
    '交接边界：',
    ...BOUNDARY.map((b) => `· ${b}`),
    '',
    engine ? `跑完后：node scripts/nw-prose.mjs record --chapter ${chapter.id} --engine ${engine.id} --result clean|issues [--findings N]`
      : `记下来：node scripts/nw-prose.mjs record --chapter ${chapter.id} --engine none --result skipped --note "本机无文体引擎"`,
  ].filter((l) => l !== null).join('\n'));
  process.exit(EXIT.OK);
}

if (sub === 'record') {
  if (!chapter) { log('record 需要 --chapter <ID>'); process.exit(EXIT.USAGE); }
  const result = String(flags.result || '');
  if (!RESULTS.includes(result)) { log(`--result 必须是 ${RESULTS.join('|')} 之一`); process.exit(EXIT.USAGE); }
  const engineId = String(flags.engine || '');
  if (!engineId) { log('record 需要 --engine <ID>（没跑成用 --engine none 配 --result skipped）'); process.exit(EXIT.USAGE); }
  if (result === 'skipped' && !flags.note) { log('skipped 必须给 --note：跳过是要留原因的那种事实'); process.exit(EXIT.USAGE); }
  const findings = flags.findings === undefined ? null : Number(flags.findings);
  if (findings !== null && (!Number.isInteger(findings) || findings < 0)) { log('--findings 得是非负整数'); process.exit(EXIT.USAGE); }
  if (result === 'issues' && !findings) { log('result=issues 却没给 --findings，等于没记'); process.exit(EXIT.USAGE); }

  const hash = await NWProject.hashRecord('chapter', chapter);
  const ledger = readLedger(bookDir);
  const rec = {
    contentHash: hash, engine: engineId, result,
    findings: findings ?? (result === 'clean' ? 0 : null),
    note: flags.note ? String(flags.note) : '',
    at: new Date().toISOString(),
  };
  ledger.byChapter[chapter.id] = rec;
  writeJsonAtomic(path.join(bookDir, ...LEDGER_REL), ledger);
  emit(!!flags.json, { chapter: chapter.id, ...rec },
    () => `已记录：${NWBible.chapterLabel(chapter)}文体=${result}${findings !== null ? `（${findings} 处）` : ''} · 引擎 ${engineId}`);
  process.exit(EXIT.OK);
}

// status
{
  const s = await statusOf(ctx, { home });
  emit(!!flags.json, s, () => {
    const usable = s.engines.filter((e) => e.usable).map((e) => e.id);
    const icon = { unchecked: '·', stale: '⚠️', clean: '✅', issues: '❌', skipped: '🚫' };
    return [
      `《${s.book}》文体检查台账 · ${s.total} 章有正文`, '',
      ...s.rows.map((r) => `${icon[r.state] || '?'} ${NWBible.chapterLabel(r)} ${r.words}字 — ${zhState(r.state)}`
        + (r.engine ? `（${r.engine}${r.findings !== null ? `，${r.findings} 处` : ''}）` : '')
        + (r.note ? `｜${r.note}` : '')),
      '',
      Object.entries(s.counts).map(([k, v]) => `${zhState(k)} ${v}`).join(' / '),
      usable.length ? `\n可用引擎：${usable.join('、')}` : '\n本机无可用文体引擎（跑 nw-prose probe 看候选与原因）',
    ].join('\n');
  });
  process.exit(EXIT.OK);
}

function zhState(s) {
  return { unchecked: '未查', stale: '正文已改，结论过期', clean: '已查·干净', issues: '已查·有问题', skipped: '跳过' }[s] || s;
}
