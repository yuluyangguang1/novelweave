#!/usr/bin/env node
/**
 * nw-context.mjs — 构造喂给写作模型的上下文文档（只读）
 *
 * 用法：
 *   node scripts/nw-context.mjs [bookDir] --chapter ch-013 [--budget 12288] [--write] [--json]
 *   node scripts/nw-context.mjs [bookDir] --chapter next [--json]
 *   node scripts/nw-context.mjs [bookDir] --lore --text "要扫描的正文"
 *
 * 设计约束（长篇必爆的第一原因就是无脑塞全文）：
 *   · 结构化状态文件不整份进 prompt，只喂这份派生文档
 *   · 总字节超预算时按固定优先级裁切，且**如实报告裁掉了什么**
 * 退出码：0 · 2 用法错 · 5 IO 错
 */
import path from 'node:path';
import {
  loadBook, resolveBookDir, parseArgs, emit, log, EXIT, writeFileAtomic,
  NovelLLM, NWText, NWRules,
} from './lib/book.mjs';

const { positional, flags } = parseArgs(process.argv.slice(2));
const json = !!flags.json;

const bookDir = resolveBookDir(positional);
if (!bookDir) { log('未找到书目录'); process.exit(EXIT.USAGE); }

let ctx;
try { ctx = loadBook(bookDir); } catch (e) { log(`读取失败：${e.message}`); process.exit(EXIT.IO); }

const budgetBytes = Number(flags.budget) || 12288;
const byId = new Map(ctx.chapters.map((c) => [c.id, c]));

if (flags.lore) {
  const r = NovelLLM.loreTrigger(flags.text || '', ctx.world, { loreBytes: budgetBytes });
  emit(json, { included: r.entries.map((e) => ({ id: e.id, name: e.name, bytes: NWText.bytesOf(e.content) })), dropped: r.dropped, bytes: r.bytes },
    r.entries.map((e) => `【${e.name}】${e.content}`).join('\n\n') + (r.dropped.length ? `\n\n（已裁掉 ${r.dropped.length} 条：${r.dropped.join(', ')}）` : ''));
  process.exit(EXIT.OK);
}

const wantNext = !flags.chapter || flags.chapter === 'next';
const current = wantNext ? null : byId.get(flags.chapter);
if (!wantNext && !current) { log(`章节不存在：${flags.chapter}`); process.exit(EXIT.USAGE); }
const lastIndex = wantNext ? ctx.chapters.length - 1 : ctx.chapters.findIndex((c) => c.id === current.id);
const prev = ctx.chapters[lastIndex] || null;   // next 时最后就是上一章；否则取前一本
const prevChapter = wantNext ? prev : (lastIndex > 0 ? ctx.chapters[lastIndex - 1] : null);

/** 出场角色的判定：优先用 frontmatter 声明，没声明时按正文命中名推断。 */
function activeCharacters() {
  const scan = [prevChapter?.body, current?.body].filter(Boolean).join('\n');
  const declared = new Set([...(current?.characters || []), ...(prevChapter?.characters || [])]);
  return ctx.characters.filter((c) => {
    if (c.enabled === false) return false;
    if (declared.has(c.id)) return true;
    return NWRules.nameForms(c).some((f) => scan.includes(f));
  });
}

function characterBlock(list) {
  return list.map((c) => {
    const bits = [`- ${c.name}（${c.role}${c.status !== 'alive' ? '，' + c.status : ''}${c['died-in'] ? '，卒于 ' + c['died-in'] : ''}）`];
    if (c.personality) bits.push(`  性格：${c.personality}`);
    if (c.appearance?.summary) bits.push(`  外貌：${c.appearance.summary}`);
    if (c.goals) bits.push(`  目标：${c.goals}`);
    if (c.status === 'deceased') bits.push(`  ⚠️ 已死亡，只可被提及，不得行动`);
    const toks = (c.appearance?.tokens || []).filter((t) => t.key);
    if (toks.length) bits.push(`  特征区间：${toks.map((t) => `${t.key}${t.since ? '(自 ' + t.since : ''}${t.until ? '; 至 ' + t.until : ''}${t.since || t.until ? ')' : ''}`).join('、')}`);
    if (c.aliases?.length) bits.push(`  别称：${c.aliases.map((a) => (typeof a === 'string' ? a : a.text)).join('、')}`);
    return bits.join('\n');
  }).join('\n');
}

function promiseBlock() {
  const open = (ctx.promises.items || []).filter((i) => i.type === 'promise' && ['planned', 'planted'].includes(i.status));
  const questions = (ctx.promises.items || []).filter((i) => i.type === 'question' && i.status === 'open');
  if (!open.length && !questions.length) return '（无未结线索）';
  return [
    ...open.map((i) => `- [${i.weight || 'major'}] ${i.title}｜埋于 ${i.setup?.chapter || '?'}${i.payoff?.due ? '｜期限 ' + i.payoff.due : ''}｜${i.setup?.evidence || ''}`),
    ...questions.map((i) => `- [悬念] ${i.title}`),
  ].join('\n');
}

function stateBlock() {
  const snap = prevChapter ? ctx.states.byChapter?.[prevChapter.id] : null;
  if (!snap) return `（${prevChapter ? prevChapter.id + ' 没有状态快照' : '无上一章，无需快照'}）`;
  return Object.entries(snap).map(([id, dims]) => {
    const c = ctx.characters.find((x) => x.id === id);
    return `- ${c?.name || id}：位置 ${dims.loc || '?'}｜状态 ${dims.alive || '?'}｜伤 ${dims.injury?.join('/') || '无'}|持 ${dims.items?.join('/') || '无'}｜已知 ${(dims.knows || []).join('/') || '无'}｜目标 ${dims.goal || '?'}`;
  }).join('\n');
}

const scanText = [prevChapter?.body, current?.body].filter(Boolean).join('\n');
const lore = NovelLLM.loreTrigger(scanText, ctx.world, { loreBytes: Math.floor(budgetBytes / 3) });
const chars = activeCharacters();

// 固定优先级：越靠前越不能被裁
const sections = [
  { name: '书目', bytes: 0, text: [`# ${ctx.book.title}`, `类型：${ctx.book.genre}`, ctx.book.description ? `概述：${ctx.book.description}` : '', ctx.book.voice?.person ? `人称：${ctx.book.voice.person}` : '', ctx.book.voice?.notes ? `笔法：${ctx.book.voice.notes}` : ''].filter(Boolean).join('\n') },
  { name: '出场角色', bytes: 0, text: characterBlock(chars) || '（无）' },
  { name: '分章状态快照', bytes: 0, text: stateBlock() },
  { name: '未结线索', bytes: 0, text: promiseBlock() },
  { name: '相关世界设定', bytes: 0, text: lore.entries.map((e) => `- ${e.name}：${e.content}`).join('\n') || '（未触发）' },
  { name: '上章尾部', bytes: 0, text: prevChapter?.body ? '…' + prevChapter.body.slice(-1200) : '（本章是第一章）' },
  { name: '本章已有正文', bytes: 0, text: current?.body ? '…' + current.body.slice(-1500) : '（本章尚未开始）' },
];

let used = 0;
const kept = [], droppedSections = [];
const HEADER = `<!-- NovelWeave 派生上下文，勿手改；权威数据在 book.json / bible/ / manuscript/ -->\n\n`;
used += NWText.bytesOf(HEADER);
for (const s of sections) {
  const block = `## ${s.name}\n${s.text}`;
  s.bytes = NWText.bytesOf(block);
  const cost = s.bytes + (kept.length ? 2 : 0);
  if (used + cost > budgetBytes) { droppedSections.push({ name: s.name, bytes: s.bytes }); continue; }
  used += cost;
  kept.push({ name: s.name, bytes: s.bytes, block });
}

const doc = HEADER + kept.map((k) => k.block).join('\n\n') + '\n';
const out = {
  bookDir,
  chapter: current?.id || null,
  nextOf: prev?.id || null,
  budgetBytes,
  bytes: NWText.bytesOf(doc),
  sections: kept.map((k) => ({ name: k.name, bytes: k.bytes })),
  droppedSections,
  loreIncluded: lore.entries.map((e) => e.id),
  loreDropped: lore.dropped,
  truncated: droppedSections.length > 0 || lore.dropped.length > 0,
  document: doc,
};

if (flags.write) {
  const target = path.join(bookDir, 'continuity', `context-${current?.id || 'next'}.md`);
  writeFileAtomic(target, doc);
  out.written = target;
}

emit(json, json ? out : undefined, doc + `\n<!-- ${out.bytes}/${budgetBytes} 字节；裁掉 ${droppedSections.length} 节、${lore.dropped.length} 条世界设定 -->`);
process.exit(EXIT.OK);
