#!/usr/bin/env node
/**
 * nw-context.mjs — 构造喂给写作模型的上下文文档（只读）
 *
 * 用法：
 *   node scripts/nw-context.mjs [bookDir] --chapter ch-013 [--budget 12288] [--write] [--json]
 *   node scripts/nw-context.mjs [bookDir] --chapter next [--json]
 *   node scripts/nw-context.mjs [bookDir] --lore --text "要扫描的正文"
 *
 * 拼装本身在 src/core/context.js —— 与浏览器「续写」共用同一份实现。
 * 之前这里和 llm.js 各写一套，结果 Web 少注入了「状态快照」与「未结线索」两节，
 * 作者录进矩阵和伏笔表的事实根本没进 prompt。
 *
 * 设计约束：结构化状态文件不整份进 prompt；超预算按固定优先级裁切并如实报告。
 * 退出码：0 · 2 用法错 · 5 IO 错
 */
import path from 'node:path';
import {
  loadBook, resolveBookDir, parseArgs, emit, log, EXIT, writeFileAtomic,
  NWContext, NWStory, NWText,
} from './lib/book.mjs';

const { positional, flags } = parseArgs(process.argv.slice(2));
const json = !!flags.json;

const bookDir = resolveBookDir(positional);
if (!bookDir) { log('未找到书目录'); process.exit(EXIT.USAGE); }

let ctx;
try { ctx = loadBook(bookDir); } catch (e) { log(`读取失败：${e.message}`); process.exit(EXIT.IO); }

const budgetBytes = Number(flags.budget) || NWContext.DEFAULTS.contextBytes;

// 只看世界书触发效果，不出整份文档
if (flags.lore) {
  const r = NWStory.loreTrigger(flags.text || '', ctx.world, { loreBytes: budgetBytes });
  emit(json, {
    included: r.entries.map((e) => ({ id: e.id, name: e.name, bytes: NWText.bytesOf(e.content) })),
    dropped: r.dropped, bytes: r.bytes,
  }, r.entries.map((e) => `【${e.name}】${e.content}`).join('\n\n')
     + (r.dropped.length ? `\n\n（已裁掉 ${r.dropped.length} 条：${r.dropped.join(', ')}）` : ''));
  process.exit(EXIT.OK);
}

const chapterId = flags.chapter || 'next';
if (chapterId !== 'next' && !ctx.chapters.some((c) => c.id === chapterId)) {
  log(`章节不存在：${chapterId}`);
  process.exit(EXIT.USAGE);
}

const built = NWContext.buildSections(ctx, { chapterId, budget: { contextBytes: budgetBytes } });
const document = NWContext.renderDocument(built);
const out = { bookDir, chapter: built.current?.id || null, prev: built.prev?.id || null, ...built.usage, document };

if (flags.write) {
  const target = path.join(bookDir, 'continuity', `context-${chapterId === 'next' ? 'next' : chapterId}.md`);
  writeFileAtomic(target, document);
  out.written = target;
}

emit(json, out, document
  + `\n<!-- ${built.usage.bytes}/${budgetBytes} 字节；裁掉 ${built.usage.droppedSections.length} 节、${built.usage.loreDropped.length} 条世界设定 -->`);
process.exit(EXIT.OK);
