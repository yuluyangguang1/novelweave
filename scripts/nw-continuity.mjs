#!/usr/bin/env node
/**
 * nw-continuity.mjs — 连续性检查（只读，不改任何文件，除非 --write 落报告）
 *
 * 用法：
 *   node scripts/nw-continuity.mjs [bookDir] [--from ch-003] [--to ch-011]
 *        [--rules R1,R7 | --rules dead-character-on-stage] [--fail-on error|warn|never]
 *        [--write] [--json]
 *   node scripts/nw-continuity.mjs explain --rule dead-character-on-stage
 *
 * 退出码：0 通过 · 1 达到 fail-on 阈值 · 2 用法错 · 3 schema 不通过 · 5 IO 错
 * 只有 machine 来源的诊断计入非零退出码 —— LLM 补充项永远不阻断流水线。
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  loadBook, resolveBookDir, parseArgs, emit, log, EXIT,
  NWRules, NWBible, writeJsonAtomic, repoRoot,
} from './lib/book.mjs';

const ALIAS = {
  R1: 'dead-character-on-stage', R2: 'status-declared-contradiction', R3: 'promise-unpaid',
  R3b: 'promise-overdue', R4: 'payoff-before-setup', R6: 'timeline-regression',
  R7: 'appearance-token-violation',
  R9: 'unregistered-entity', R14: 'structure-invalid', R15: 'dangling-reference',
  R16: 'derived-field-touched',
};

function resolveRuleNames(list) {
  return list.map((raw) => {
    const name = ALIAS[raw] || ALIAS[raw.toLowerCase?.()] || raw;
    return NWRules.RULES[name] ? name : null;
  }).filter(Boolean);
}

const { positional, flags } = parseArgs(process.argv.slice(2));

// ── explain ──
if (positional[0] === 'explain') {
  const name = ALIAS[flags.rule] || flags.rule;
  const rule = NWRules.RULES[name];
  if (!rule) {
    const table = Object.entries(NWRules.RULES).map(([k, v]) => `${v.code.padEnd(4)} ${k}  (${v.defaultSeverity})`);
    emit(!!flags.json, { rules: Object.fromEntries(Object.entries(NWRules.RULES).map(([k, v]) => [k, { code: v.code, defaultSeverity: v.defaultSeverity, summary: v.summary }])) }, table.join('\n'));
    process.exit(flags.rule ? EXIT.USAGE : EXIT.OK);
  }
  emit(!!flags.json, { name, ...rule, run: undefined },
    `${rule.code} ${name}\n默认级别：${rule.defaultSeverity}\n\n${rule.summary}\n\n误报控制：${rule.detail}`);
  process.exit(EXIT.OK);
}

const bookDir = resolveBookDir(positional);
if (!bookDir) {
  log('未找到书目录。显式传入 bookDir，或在含 .novelweave/project.json 的项目下运行。');
  process.exit(EXIT.USAGE);
}

let ctx;
try {
  ctx = loadBook(bookDir);
} catch (e) {
  log(`读取失败：${e.message}`);
  process.exit(EXIT.IO);
}

const schemaGate = NWRules.runSchemaRules(ctx);
if (!schemaGate.ok) {
  emit(!!flags.json, { bookDir, blockedBy: 'schema', diagnostics: schemaGate.diags },
    `❌ schema 校验未通过（${schemaGate.diags.length} 处），先修结构再谈连续性：\n` +
    schemaGate.diags.map((d) => `  · ${d.message}`).join('\n'));
  process.exit(EXIT.BROKEN);
}

const only = typeof flags.rules === 'string' ? resolveRuleNames(flags.rules.split(',').map((s) => s.trim())) : null;
if (flags.rules && !only.length) {
  log(`--rules 里的名字一个都不认识：${flags.rules}。用 explain 查看规则表。`);
  process.exit(EXIT.USAGE);
}

const diags = NWRules.runRules(ctx, { only, from: flags.from, to: flags.to });
const summary = NWRules.summarize(diags);
const blocking = diags.filter((d) => !d.suppressedBy && d.source === 'machine'
  && (d.severity === 'error' || (flags['fail-on'] === 'warn' && d.severity === 'warn')));

const failOn = flags['fail-on'] || 'error';
const report = {
  schemaVersion: NWBible.SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  engine: `novelweave-rules@${NWRules.ENGINE_VERSION}`,
  book: ctx.book.slug || ctx.book.title,
  range: { from: flags.from || (ctx.chapters[0]?.id ?? null), to: flags.to || (ctx.chapters.at(-1)?.id ?? null) },
  summary,
  diagnostics: diags,
};

if (flags.write) {
  const dir = path.join(bookDir, 'continuity', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  writeJsonAtomic(path.join(dir, `${stamp}.json`), report);
  const snapFile = path.join(bookDir, 'continuity', 'snapshot.json');
  const snap = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : { schemaVersion: NWBible.SCHEMA_VERSION, reports: {} };
  snap.reports = { ...(snap.reports || {}), [stamp]: { error: summary.error, warn: summary.warn, info: summary.info } };
  snap.lastRun = report.generatedAt;
  writeJsonAtomic(snapFile, snap);
  // 检查结果如实回写：没跑过就没有 lastChecked，跑了才有 errors/warns
  const bookFile = path.join(bookDir, 'book.json');
  const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  book._derived = { ...(book._derived || {}), lastChecked: report.generatedAt,
    errors: summary.error, warns: summary.warn, suppressed: summary.suppressed };
  writeJsonAtomic(bookFile, book);
  log(`报告已写入 continuity/reports/${stamp}.json`);
}

emit(!!flags.json, report, () => {
  const head = `《${ctx.book.title}》${ctx.chapters.length} 章 · 引擎 ${NWRules.ENGINE_VERSION}`;
  if (!diags.length) return `✅ ${head}\n没有发现连续性问题。`;
  const body = diags.map((d) => {
    const icon = d.suppressedBy ? '🚫' : d.severity === 'error' ? '❌' : d.severity === 'warn' ? '⚠️' : 'ℹ️';
    const where = d.chapter ? `${d.chapter}` : d.entity ? `${d.entity}` : '全书';
    const quote = d.evidence?.quote ? `\n     「${d.evidence.quote}」` : '';
    return `${icon} [${NWRules.RULES[d.rule]?.code || d.rule}] ${d.rule} · ${where}\n   ${d.message}${quote}${d.suggestion ? `\n   → ${d.suggestion}` : ''}`;
  });
  const counts = `${summary.error} error / ${summary.warn} warn / ${summary.info} info`
    + (summary.suppressed ? ` / ${summary.suppressed} 已豁免` : '');
  return [head, '', ...body, '', counts].join('\n');
});

process.exit(failOn === 'never' ? EXIT.OK : (blocking.length ? EXIT.ERROR_FOUND : EXIT.OK));
