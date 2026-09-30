#!/usr/bin/env node
/**
 * nw-style.mjs — 文风指纹：把「这本书自己的笔法」量成四个数，逐章与基准比
 *
 * 判据只有一处：src/core/stylefit.js。界面「文体规则」页那一行、机检 R32、
 * 生成时注入 prompt 的那一行、这里，四边算的都是同一个函数 ——
 * 阈值抄第二份必然对不上，那正是这个项目反复犯过的病。
 *
 * 用法：
 *   node scripts/nw-style.mjs [bookDir] [--json]              整本指纹 + 逐章偏离
 *   node scripts/nw-style.mjs keys [--json]                   四格与门槛（从包里现取）
 *   node scripts/nw-style.mjs anchor [bookDir] --set ch-001,ch-002 [--json]
 *   node scripts/nw-style.mjs anchor [bookDir] --clear [--json]
 *
 * 退出码：0 · 2 用法/参数错 · 5 IO 错。**偏离永不阻断**：
 * 文风是作者说了算的那件事，这四个数只负责把它量出来摆在眼前。
 * 真要门禁请去跑 nw-continuity（R32 恒为 info，它也不拦）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadBook, resolveBookDir, parseArgs, emit, log, EXIT, writeJsonAtomic,
  NWBible, NWContext, NWRules, NWStyleFit, NWStylePack,
} from './lib/book.mjs';

const { positional, flags } = parseArgs(process.argv.slice(2));
let sub = positional[0];
let rest = positional.slice(1);
if (sub !== 'keys' && sub !== 'anchor') {
  if (!sub) {
    log('用法：nw-style.mjs <bookDir> [--json] | keys [--json] | anchor [bookDir] --set ch-001,ch-002 | anchor [bookDir] --clear');
    process.exit(EXIT.USAGE);
  }
  sub = 'fit';
  rest = positional.slice(0);
}

if (sub === 'keys') {
  const table = {
    version: NWStyleFit.FIT_VERSION,
    minBodyWords: NWStyleFit.MIN_BODY,
    keys: NWStyleFit.KEYS.map((k) => ({ id: k.id, label: k.label, kind: k.kind, threshold: k.dev })),
    notMeasured: ['文笔高低', '一个总分', '语义相似度'],
    gate: 'R32 只在同时越两格以上时报，且只认 book.styleAnchor 勾定的基准章',
  };
  emit(!!flags.json, table, () => [
    `文风指纹 v${table.version} —— 四个数各说各话，不合成总分（合成就是把判断权交给统计）。`, '',
    ...table.keys.map((k) => `${NWStyleFit.keyOf(k.id).label}（${k.id}）：${
      k.kind === 'rel' ? `相对基准偏离 >${Math.round(k.threshold * 100)}%`
      : k.kind === 'pp' ? `与基准相差 >${k.threshold} 个百分点`
      : `与基准相差 >${NWStyleFit.keyOf(k.id).fmt(k.threshold)}`}`),
    `够格进指纹：正文 ≥${table.minBodyWords} 字（与「生成时注入哪几段」同一个门槛）。`,
    `明确不算：${table.notMeasured.join('、')}。`,
    table.gate + '。',
  ].join('\n'));
  process.exit(EXIT.OK);
}

const bookDir = resolveBookDir(rest);
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

if (sub === 'anchor') {
  if (flags.set !== undefined && flags.clear) { log('--set 与 --clear 只能给一个'); process.exit(EXIT.USAGE); }
  const ids = flags.clear ? [] : (flags.set === true ? '' : String(flags.set ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  if (!flags.clear && !ids.length) { log('--set 要给逗号分隔的章 id（或改用 --clear 取消基准）'); process.exit(EXIT.USAGE); }
  const known = new Set(input.chapters.map((c) => c.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    log(`这些章 id 不在书里：${unknown.join('、')}。可写的清单：${[...known].join('、') || '（这本书还没有章节）'}`);
    process.exit(EXIT.USAGE);
  }
  const bookPath = path.join(bookDir, 'book.json');
  // 只动 styleAnchor 这一格，其余内容与键序一律不碰。取消是删掉这个键而不是写 null ——
  // schema 里 styleAnchor 不可为 null，留一个 null 等于给这本书白添一条 error。
  const raw = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
  if (ids.length) raw.styleAnchor = { chapterIds: ids }; else delete raw.styleAnchor;
  raw.updated = new Date().toISOString();
  writeJsonAtomic(bookPath, raw);
  input = loadBook(bookDir);
}

const book = input.book;
const opts = NWStylePack.optsFrom(book);
const pool = NWContext.stylePool(input.chapters, null, book);
// 勾过基准就比基准；没勾过就比「全书合格章」——这两件事必须说得出口，不许都叫「基准」
const basis = pool.source === 'anchor' ? pool.list : input.chapters;
const baseFp = NWStyleFit.fingerprint(basis, opts);
const exempt = NWRules.EXEMPT_FLAGS;
const anchorIds = new Set(pool.source === 'anchor' ? pool.list.map((c) => c.id) : []);

const rows = input.chapters.map((ch) => {
  const fp = NWStyleFit.fingerprint([ch], opts);
  const base = { id: ch.id, number: ch.number, label: NWBible.chapterLabel(ch), words: fp.chapters ? fp.words : 0 };
  if (anchorIds.has(ch.id)) return { ...base, role: 'baseline', fingerprint: fp, drift: [] };
  if (!fp.chapters) return { ...base, role: 'too-short', fingerprint: null, drift: [] };
  if ((ch.flags || []).some((f) => exempt.has(f))) return { ...base, role: 'exempt', fingerprint: fp, drift: [] };
  return { ...base, role: 'chapter', fingerprint: fp, drift: NWStyleFit.compare(baseFp, fp) };
});

// 注入预览按「写下一章」的情形算：与生成时同一函数、同一预算，
// 这样屏上这一行「样例是谁、指纹是多少」和模型真读到的那份是同一个答案。
const injected = NWContext.pickStyleExemplars(input.chapters, null, book, NWContext.DEFAULTS.styleBytes);
const payload = {
  book: book.title || book.slug,
  fitVersion: NWStyleFit.FIT_VERSION,
  stylePack: { enabled: opts.enabled, disabled: opts.disabled, extraBanned: opts.extraBanned },
  baseline: {
    source: pool.source,
    declared: (Array.isArray(book.styleAnchor?.chapterIds) ? book.styleAnchor.chapterIds : []),
    chapters: baseFp.chapters,
    fingerprint: baseFp,
  },
  injected: { source: injected.source, fitLine: injected.fitLine, chapters: injected.list.map((e) => e.label) },
  chapters: rows,
};

emit(!!flags.json, payload, () => {
  const head = [
    `《${payload.book}》· 文风指纹 v${NWStyleFit.FIT_VERSION}`,
    `词组开关：${opts.enabled ? '整包启用' : '整包关掉'}${opts.disabled.length ? ` · 已关掉 ${opts.disabled.join('、')}` : ''}${opts.extraBanned.length ? ` · 本书额外禁词 ${opts.extraBanned.length} 个` : ''}`,
    pool.source === 'anchor' ? `作者勾定的基准：${pool.list.map((c) => NWBible.chapterLabel(c)).join('、')}`
      : pool.source === 'anchor-lost' ? `勾过的基准章（${(book.styleAnchor?.chapterIds || []).join('、')}）正文都不够 ${NWStyleFit.MIN_BODY} 字，生成时退回就近取样`
        : `未勾定基准：下面拿全书合格章当参照，只说明这一章离全书平均有多远 —— R32 在这种情况下一条不报。`
          + `（平均数会被离群的章拖走，两章彼此一模一样也可能各报偏离）`,
    baseFp.chapters ? NWStyleFit.lines(baseFp) : `够格的章一章都没有（正文都要 ≥${NWStyleFit.MIN_BODY} 字），算不出指纹`,
    injected?.list.length ? `生成时注入的样例：${injected.list.map((e) => e.label).join('、')}` : '生成时没有可注入的样例',
    '',
    '逐章：',
  ];
  const body = rows.map((r) => {
    if (r.role === 'too-short') return `  ${r.label}　正文不足 ${NWStyleFit.MIN_BODY} 字，不进指纹`;
    if (r.role === 'baseline') return `  ${r.label}　基准，不评自己`;
    if (r.role === 'exempt') return `  ${r.label}　带回忆/引文标记，不评`;
    return `  ${r.label}　${r.words} 字 · ${r.drift.length ? `越 ${r.drift.length} 格：${NWStyleFit.driftText(baseFp, r.fingerprint)}` : '与参照相符'}`;
  });
  return [...head, ...body, '',
    '数字只是量出来的，好不好的判断还是你的。门槛逐条：node scripts/nw-style.mjs keys',
  ].join('\n');
});
process.exit(EXIT.OK);
