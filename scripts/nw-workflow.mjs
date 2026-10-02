#!/usr/bin/env node
/**
 * nw-workflow.mjs — 工作流预设：把一本书调顺了的那三格搬给另一本书
 *
 * 判据只有一处：src/core/workflow.js。哪三格能走、一份外来文件能信到哪一步、
 * 应用会改哪几格、哪一格在这本书里落不下，全在那一份里算；界面、schema、这里
 * 都引它。阈值与字段清单抄第二份必然对不上，那是这个项目反复犯过的病。
 *
 * 用法：
 *   node scripts/nw-workflow.mjs keys [--json]
 *   node scripts/nw-workflow.mjs pack [bookDir] [--name 名字] [--out preset.json] [--json]
 *   node scripts/nw-workflow.mjs check preset.json [bookDir] [--json]
 *
 * 退出码：0 预设能用 · 1 预设不能用（原因逐条打在 stdout）· 2 用法错 · 5 读不到文件。
 * **这里只看不改**：写库那一路要逐格确认「现在 / 预设 / 会不会变」，那是界面那张框的事。
 * 命令行拿到的是别人写的设置，没人当场点头就落盘，正是这套预设要避免的那件事。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadBook, resolveBookDir, parseArgs, emit, log, EXIT, writeJsonAtomic,
  NWWorkflow, NWStylePack,
} from './lib/book.mjs';

const FLAGS = ['name', 'out', 'json'];
const { positional, flags } = parseArgs(process.argv.slice(2), FLAGS);
const sub = positional[0];
if (sub !== 'keys' && sub !== 'pack' && sub !== 'check') {
  log('用法：nw-workflow.mjs <keys|pack|check> […]（pack [bookDir] [--name 名字] [--out f.json]；check <preset.json> [bookDir]）');
  process.exit(EXIT.USAGE);
}

/** 一格的情况收成一行话。「落不下」排在「要改」之前判：那一格不会写进库，不许画箭头。 */
const rowLine = (r) => `  ${r.label}：${r.current}${
  r.blocked ? ` ｜ 预设要的是 ${r.incoming} —— ${r.blocked}`
    : r.changed ? ` → ${r.incoming}（要改）` : '（不变）'}`;

if (sub === 'keys') {
  const table = {
    version: NWWorkflow.WORKFLOW_VERSION,
    kind: NWWorkflow.KIND,
    fileVersion: NWWorkflow.FILE_VERSION,
    fields: NWWorkflow.FIELDS.map((key) => ({ key, label: NWWorkflow.FIELD_LABEL[key] })),
    formats: NWWorkflow.FORMATS.map((v) => ({ value: v, label: NWWorkflow.valueText('format', v) })),
    targetMin: NWWorkflow.TARGET_MIN,
    targetMax: NWWorkflow.TARGET_MAX,
    packKeys: NWWorkflow.PACK_KEYS,
    groups: NWStylePack.GROUPS.map((g) => ({ id: g.id, label: g.label })),
    notShared: NWWorkflow.NOT_SHARED,
    builtins: NWWorkflow.BUILTINS.map((b) => ({ name: b.name, note: b.note })),
  };
  emit(!!flags.json, table, () => [
    `工作流预设 v${table.version} · 文件格式第 ${table.fileVersion} 号（kind 写 ${table.kind}）`, '',
    `预设只搬这三格：${table.fields.map((f) => f.label).join('、')}。`,
    `篇幅档只认：${table.formats.map((f) => `${f.value}（${f.label}）`).join('、')}。`,
    `字数目标的上下限：${table.targetMin} 到 ${table.targetMax} 字（与 schemas/story-bible.v1.json 的 book.target_words.minimum / maximum 同一对数）。`,
    `规则包那一格的子键：${table.packKeys.join('、')}；禁词组 ${table.groups.length} 个：${table.groups.map((g) => `${g.id}（${g.label}）`).join('、')}。`, '',
    '明确不进预设：',
    ...table.notShared.map((n) => `  ${n.key}：${n.why}`),
    '',
    '随货内置：',
    ...table.builtins.map((b) => `  ${b.name} —— ${b.note}`),
    '',
    '打包与过闸：node scripts/nw-workflow.mjs pack | check',
  ].join('\n'));
  process.exit(EXIT.OK);
}

if (sub === 'pack') {
  const bookDir = resolveBookDir(positional.slice(1));
  if (!bookDir) {
    log('未找到书目录（给显式路径，或在含 .novelweave/project.json 的目录下运行）');
    process.exit(EXIT.USAGE);
  }
  let input;
  try {
    input = loadBook(bookDir);
  } catch (e) {
    log(`读取失败：${e.message}`);
    process.exit(EXIT.IO);
  }
  const preset = NWWorkflow.pack(input.book, { name: typeof flags.name === 'string' ? flags.name : undefined });
  let outFile = null;
  if (flags.out) {
    outFile = path.resolve(flags.out === true ? NWWorkflow.fileName(preset) : String(flags.out));
    try {
      writeJsonAtomic(outFile, preset);
    } catch (e) {
      log(`写不出去：${e.message}`);
      process.exit(EXIT.IO);
    }
    log(`已写出 ${outFile}`);
  }
  // 过的是自己那道闸：打包与校验口径不一致的话，导得出去、进不来就没人发现
  const n = NWWorkflow.normalize(preset);
  emit(!!flags.json, { book: input.book.title || input.book.slug, file: outFile, ok: n.ok, preset }, () => [
    `《${input.book.title || input.book.slug}》→ 预设「${preset.name}」`,
    // 这里念的是 core 那一句逐格 diff 的整行，不是「这一格现在写着什么」：长篇库里那个
    // 遗留的字数目标，只报数就等于让人以为预设把它带上了。
    '  逐格对照（「要改」＝应用这一份时会动这一格，打包这一步什么都没改）：',
    ...NWWorkflow.diffFields(input.book, preset.fields).map(rowLine),
    outFile ? `文件：${outFile}` : '（没给 --out，只打到屏幕上）',
    n.ok ? '这份预设过自己那道闸：能导入。' : `这份预设过不了自己的闸：${[...n.errors, ...n.bad.map((b) => b.reason)].join('；')}`,
  ].join('\n'));
  process.exit(n.ok ? EXIT.OK : EXIT.ERROR_FOUND);
}

const file = path.resolve(positional[1] || '');
if (!positional[1]) {
  log('check 要给预设文件：nw-workflow.mjs check preset.json [bookDir]');
  process.exit(EXIT.USAGE);
}
if (!fs.existsSync(file)) {
  log(`读不到这个文件：${file}`);
  process.exit(EXIT.IO);
}
let raw = null;
let parseError = '';
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  parseError = e.message;
}
// 连 JSON 都不是：这是这份文件的问题，不是这里读不动，所以退 1 把原因说出口，不退 5
const n = parseError ? { ok: false, name: path.basename(file), note: '', fields: {}, unknown: [], bad: [], errors: [`不是合法 JSON：${parseError}`] } : NWWorkflow.normalize(raw);

let input = null;
let bookError = '';
const bookDir = positional[2] ? path.resolve(positional[2]) : resolveBookDir([]);
if (bookDir) {
  try {
    input = loadBook(bookDir);
  } catch (e) {
    bookError = e.message;
  }
}
// 过不了闸就只谈为什么过不了：一份坏文件配一张「会改这两格」的清单，
// 读的人只记得住清单。等它改对了再谈落点。
const rows = n.ok && input ? NWWorkflow.diffFields(input.book, n.fields) : null;
const carried = new Set(Object.keys(n.fields));
// 「照旧」那一格清单里不许出现被清走的那一格：预设不带它，可应用会把它写成空 ——
// 一句「你书里那几格照旧」配一行「要清掉」，读的人只会记住一句，而两句是相反的。
const clearing = new Set((rows || []).filter((r) => r.clears).map((r) => r.key));
const missing = NWWorkflow.FIELDS.filter((k) => !carried.has(k) && !clearing.has(k)).map((k) => NWWorkflow.FIELD_LABEL[k]);
const anyChanged = !!rows && rows.some((r) => r.changed);
const blockedRows = rows ? rows.filter((r) => r.blocked) : [];
// 「一格都不用改」这一句要有逐格清单才可说：没有清单（预设没过闸、或根本没有书）时它也蹦出来，
// 就把「这份文件我们读不动」说成了「你的书已经对了」—— 两个人各得一句假话。
const noneLine = !rows ? ''
  : anyChanged ? ''
    : blockedRows.length ? `  一格都不会动。落不下的原因写在上面那一行，不是这本书已经对了。`
      : '  这一本已经就是这套工作流，一格都不用改。';

emit(!!flags.json, {
  file, name: n.name, note: n.note, ok: n.ok,
  errors: n.errors, bad: n.bad, unknown: n.unknown, fields: n.fields,
  book: input ? input.book.title || input.book.slug : null,
  diff: rows,
}, () => [
  `预设「${n.name}」—— ${n.ok ? '这一份能用' : '这一份没有应用'}`,
  n.note ? `作者留的话：${n.note}` : '',
  ...(!n.ok ? [...n.errors.map((e) => `  · ${e}`), ...n.bad.map((b) => `  ${NWWorkflow.FIELD_LABEL[b.key] || b.key}：${b.reason}`)] : []),
  n.ok ? (input ? `对照《${input.book.title || input.book.slug}》：` : '没有可对照的书：只判这份预设能不能用，不说它会改哪几格'
    + (bookError ? `（${bookError}）` : '')) : '等这几处改对了再谈它会改哪几格。',
  ...(rows ? rows.map(rowLine) : []),
  ...(noneLine ? [noneLine] : []),
  ...(rows && missing.length ? [`  这份预设不带：${missing.join('、')} —— 你书里那几格照旧。`] : []),
].filter(Boolean).join('\n'));
process.exit(n.ok ? EXIT.OK : EXIT.ERROR_FOUND);
