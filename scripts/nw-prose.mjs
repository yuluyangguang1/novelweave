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
 *   node scripts/nw-prose.mjs lint [bookDir] --chapter ch-003 [--record] [--json]
 *   node scripts/nw-prose.mjs record [bookDir] --chapter ch-003 --engine ID
 *        --result clean|issues|skipped [--findings N] [--note "..."]
 *   node scripts/nw-prose.mjs status [bookDir] [--home DIR] [--json]
 *
 * 退出码：0 · 2 用法错 · 5 IO 错。
 * 文体状态**永不阻断**：它是建议。与 nw-continuity 的机器门禁混在一起，
 * 会让 CI 因为「这台机器没装第三方技能」而变红，那是假失败。
 *
 * `lint` 是这文件里唯一自己动手的子命令，用的就是 Web 端 R22 那份内置包
 * （src/core/stylepack.js）。它存在的理由：交接机制假定本机有别人的引擎，
 * 而大多数机器没有 —— 于是「建议去查文笔」在现实中永远不发生。
 * 它仍然只数词与句式，不判断好坏。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadBook, resolveBookDir, chapterFileOf, parseArgs, emit, log, EXIT, expandHome,
  readJson, writeJsonAtomic, NWBible, NWProject, NWText, NWStylePack,
} from './lib/book.mjs';

/** 交接边界只写一次，JSON 与人类可读输出共用同一份。 */
const BOUNDARY = [
  '只诊断，不替作者改写正文；要改由作者点头',
  '本 skill 不判断文笔好坏，交接包里的清单来自被交接的引擎',
  '改完必须重跑 nw-continuity —— 换句子会挪动证据偏移，R1/R7 的定位跟着失效',
  '结论要写回台账：外部引擎用 record，内置包用 lint --record；不写，这一章在 status 里永远是「未查」',
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
  // 兜底引擎排最后：packet 默认取第一个可用的，别把本机真有的第三方引擎挤掉
  {
    id: 'builtin', label: '织文内置去 AI 味包', kind: 'builtin',
    how: 'node scripts/nw-prose.mjs lint --chapter <ID>',
    note: '与 Web 端 R22 同一份包，永远可用；只数禁词密度与句式套路，不判断文笔',
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
    if (spec.kind === 'builtin') {
      // 自家包不需要探测：它随代码走，永远在。写清楚这点，probe 的「不可用要有原因」
      // 那条约定才仍然成立 —— 它没有原因可给。
      out.push({ id: spec.id, label: spec.label, kind: spec.kind, how: spec.how, note: spec.note || '',
        network: false, usable: true, path: null, why: '' });
      continue;
    }
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

if (!sub || !['probe', 'packet', 'lint', 'record', 'status'].includes(sub)) {
  log('用法：nw-prose.mjs <probe|packet|lint|record|status> [bookDir] [--chapter ID] [--engine ID] [--result clean|issues|skipped] [--json]');
  process.exit(EXIT.USAGE);
}

const home = flags.home ? path.resolve(String(flags.home)) : null;

if (sub === 'probe') {
  const engines = probe({ home });
  const usable = engines.filter((e) => e.usable);
  // 内置包不算「外部引擎」：packet 那条交接路径的存在意义是把活交给别人，
  // 交给自己的话直接跑 lint 就行，不必假装有个要交接的对象。
  const external = usable.filter((e) => e.kind !== 'builtin');
  emit(!!flags.json, {
    engines, usable: usable.map((e) => e.id), external: external.map((e) => e.id),
    recommended: external[0]?.id || 'builtin',
  }, () => [
    `文体引擎探测（本机 ${engines.length} 个候选）`, '',
    ...engines.map((e) => `${e.usable ? '✅' : '·'} ${e.id}${e.path ? ` — ${pathToFile(e.path)}` : ''}`
      + (e.usable ? '' : `（${e.why}）`)
      + (e.usable && e.files?.length ? `\n     清单：${e.files.map((f) => path.basename(f)).join('、')}` : '')
      + (e.usable ? `\n     用法：${e.how}` : '')
      + (e.note ? `\n     注意：${e.note}` : '')),
    '',
    external.length ? `外部引擎 ${external.length} 个可用；交接：nw-prose packet --chapter <ID>`
      : '本机没有外部文体引擎。内置包仍然能跑（nw-prose lint --chapter <ID>）；要交给别的 agent 时，'
        + '把结论用 record --engine builtin 记进台账，别静默跳过。',
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
  // 指定了引擎但它不可用时不降级到别的引擎：作者点名要的那个失败，比悄悄换一个更有用。
  // 默认也不选内置包 —— packet 的语义是「交给别人」，交给自己是 lint 那条路。
  const engine = want || (engines.find((e) => e.usable && e.kind !== 'builtin') || null);
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
      : '本机没有外部引擎 —— 内置包仍可用：node scripts/nw-prose.mjs lint --chapter ' + chapter.id,
    engine?.files?.length ? `  清单：${engine.files.join('\n        ')}` : null,
    engine?.network ? '  注意：该引擎默认走远端 API，离线时不要指望它' : null,
    engine ? `  正文：${hasFile ? pathToFile(file) : '（找不到章节文件，先跑 nw-io export）'}` : null,
    '',
    '交接边界：',
    ...BOUNDARY.map((b) => `· ${b}`),
    '',
    engine ? `跑完后：node scripts/nw-prose.mjs record --chapter ${chapter.id} --engine ${engine.id} --result clean|issues [--findings N]`
      : `内置包顶上：node scripts/nw-prose.mjs lint --chapter ${chapter.id} --record`,
  ].filter((l) => l !== null).join('\n'));
  process.exit(EXIT.OK);
}

if (sub === 'lint') {
  if (!chapter) { log('lint 需要 --chapter <ID>'); process.exit(EXIT.USAGE); }
  const opts = NWStylePack.optsFrom(ctx.book);
  const body = String(chapter.body || '');
  const words = NWText.countWords(body);
  const r = NWStylePack.lint(body, opts);
  const v = NWStylePack.verdict(r);
  const findings = r.banned.length + r.patterns.reduce((n, p) => n + p.count, 0);
  // 「没评」与「评了没问题」是两件事：包被作者关掉、正文短于门槛，一律算 skipped。
  // 图省事写成 clean，台账就在对作者撒谎。
  const stopped = opts.enabled === false;
  const result = stopped || words < 500 ? 'skipped' : (v.severity ? 'issues' : 'clean');
  const note = stopped ? '本书已停用去 AI 味包（stylePack.enabled=false）'
    : words < 200 ? '本章不足 200 字，没有正文可查'
      : words < 500 ? '正文不足 500 字，本包不评密度' : '';

  const byTerm = new Map();
  for (const b of r.banned) {
    const k = `${b.group}\u0000${b.term}`;
    const row = byTerm.get(k) || { group: b.groupLabel, term: b.term, count: 0, at: b.at };
    row.count += 1; byTerm.set(k, row);
  }
  const terms = [...byTerm.values()].sort((a, b) => b.count - a.count || (a.term < b.term ? -1 : 1));

  const payload = {
    chapter: chapter.id, number: chapter.number, title: chapter.title, words,
    packVersion: NWStylePack.PACK_VERSION, per1000: r.per1000,
    severity: v.severity, reasons: v.reasons,
    terms, patterns: r.patterns, findings, result, note,
    enabled: opts.enabled !== false,
  };
  if (flags.record) {
    await putRecord(bookDir, chapter, { engine: 'builtin', result, findings: result === 'issues' ? findings : null, note });
  }
  emit(!!flags.json, payload, () => [
    `${NWBible.chapterLabel(chapter)} · ${words} 字 · 内置去 AI 味包 v${NWStylePack.PACK_VERSION}`, '',
    `结论：${zhState(result === 'issues' ? 'issues' : result)}${findings ? `（${findings} 处）` : ''}`,
    v.reasons.length ? `  ${v.reasons.join('；')}` : (note ? `  ${note}` : '  密度与句式都在门槛内'),
    terms.length ? '' : null,
    ...terms.slice(0, 12).map((t) => `  ${t.group}｜${t.term} ×${t.count}（首个位置 ${t.at}）`),
    terms.length > 12 ? `  …另有 ${terms.length - 12} 个词` : null,
    ...r.patterns.map((p) => `  句式｜${p.label} ×${p.count}：${(p.samples || []).join(' / ')}`),
    '',
    flags.record ? '已写进台账 continuity/prose.json'
      : `要记进台账：加 --record（不写的话这一章在 status 里仍是「未查」）`,
    '边界：只诊断不改写；改完必须重跑 nw-continuity（换句子会挪动证据偏移）',
  ].filter((l) => l !== null).join('\n'));
  process.exit(EXIT.OK);
}

/** lint 与 record 共用同一份落盘逻辑，避免两处写出两种形状。 */
async function putRecord(bookDir, chapter, { engine, result, findings = null, note = '' }) {
  const rec = {
    contentHash: await NWProject.hashRecord('chapter', chapter), engine, result,
    findings: findings ?? (result === 'clean' ? 0 : null),
    note, at: new Date().toISOString(),
  };
  const ledger = readLedger(bookDir);
  ledger.byChapter[chapter.id] = rec;
  writeJsonAtomic(path.join(bookDir, ...LEDGER_REL), ledger);
  return rec;
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

  const rec = await putRecord(bookDir, chapter, {
    engine: engineId, result, findings, note: flags.note ? String(flags.note) : '',
  });
  emit(!!flags.json, { chapter: chapter.id, ...rec },
    () => `已记录：${NWBible.chapterLabel(chapter)}文体=${result}${findings !== null ? `（${findings} 处）` : ''} · 引擎 ${engineId}`);
  process.exit(EXIT.OK);
}

// status
{
  const s = await statusOf(ctx, { home });
  emit(!!flags.json, s, () => {
    const usable = s.engines.filter((e) => e.usable && e.kind !== 'builtin').map((e) => e.id);
    const icon = { unchecked: '·', stale: '⚠️', clean: '✅', issues: '❌', skipped: '🚫' };
    return [
      `《${s.book}》文体检查台账 · ${s.total} 章有正文`, '',
      ...s.rows.map((r) => `${icon[r.state] || '?'} ${NWBible.chapterLabel(r)} ${r.words}字 — ${zhState(r.state)}`
        + (r.engine ? `（${r.engine}${r.findings !== null ? `，${r.findings} 处` : ''}）` : '')
        + (r.note ? `｜${r.note}` : '')),
      '',
      Object.entries(s.counts).map(([k, v]) => `${zhState(k)} ${v}`).join(' / '),
      usable.length ? `\n外部引擎：${usable.join('、')}（交接：nw-prose packet --chapter <ID>）`
        : '\n本机无外部文体引擎（跑 nw-prose probe 看候选与原因）；内置包随时可查：nw-prose lint --chapter <ID>',
    ].join('\n');
  });
  process.exit(EXIT.OK);
}

function zhState(s) {
  return { unchecked: '未查', stale: '正文已改，结论过期', clean: '已查·干净', issues: '已查·有问题', skipped: '跳过' }[s] || s;
}
