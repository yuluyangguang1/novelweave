#!/usr/bin/env node
/**
 * nw-validate.mjs — 结构校验（schema / 断链 / 非法结构 / 派生字段被改）
 *
 * 用法：node scripts/nw-validate.mjs [bookDir] [--json] [--level schema|ref|structure|all]
 * 退出码：0 通过 · 1 有 error · 2 用法错 · 3 schema 不通过 · 5 IO 错
 */
import path from 'node:path';
import {
  loadBook, resolveBookDir, parseArgs, emit, log, EXIT,
  NWRules, NWBible, writeJsonAtomic, readJson,
} from './lib/book.mjs';

const { positional, flags } = parseArgs(process.argv.slice(2));
const json = !!flags.json;
const bookDir = resolveBookDir(positional);

if (!bookDir) {
  log(positional[0] ? `目录不存在或没有 book.json：${positional[0]}` : '未找到 .novelweave/project.json，或项目下有多本书需要指定 bookDir');
  process.exit(EXIT.USAGE);
}

let ctx;
try {
  ctx = loadBook(bookDir);
} catch (e) {
  log(`读取失败：${e.message}`);
  process.exit(EXIT.IO);
}

const schemaResult = NWRules.runSchemaRules(ctx);
let diags = schemaResult.diags;
if (schemaResult.ok) {
  // schema 不通过时不跑派生规则，否则会产出一堆假诊断
  const structural = NWRules.runRules(ctx, {
    only: ['structure-invalid', 'dangling-reference', 'derived-field-touched'],
  });
  diags = structural;
}

const summary = NWRules.summarize(diags);
const errors = diags.filter((d) => !d.suppressedBy && d.severity === 'error').length;

const snapFile = path.join(bookDir, 'continuity', 'snapshot.json');
const snap = readJson(snapFile, { schemaVersion: NWBible.SCHEMA_VERSION, reports: {} });
snap.validatedAt = new Date().toISOString();
snap.validation = { errors, warnings: summary.warn, infos: summary.info, engine: NWRules.ENGINE_VERSION };
if (!flags['no-write']) writeJsonAtomic(snapFile, snap);

emit(json, { bookDir, ok: errors === 0, summary, diagnostics: diags }, () => {
  if (!diags.length) return `✅ ${path.basename(bookDir)}：结构校验通过（${ctx.chapters.length} 章）`;
  const lines = diags.map((d) => `${d.severity === 'error' ? '❌' : d.severity === 'warn' ? '⚠️' : 'ℹ️'} [${d.rule}] ${d.chapter || '-'} ${d.message}`);
  lines.push('', `${errors} error / ${summary.warn} warn / ${summary.info} info`);
  return lines.join('\n');
});

process.exit(errors ? (schemaResult.ok ? EXIT.ERROR_FOUND : EXIT.BROKEN) : EXIT.OK);
