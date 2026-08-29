#!/usr/bin/env node
/**
 * nw-changes.mjs — `---CHANGES---` 变更声明协议
 *
 * 模型（或人）写完正文后，在文件末尾追加一段结构化变更声明；本命令把它解析、
 * 过门禁，写入 continuity/pending.json。**只有作者点头 apply 之后才会改动状态文件** ——
 * 这是「作者掌控」原则在工程上的落点：AI 可以提案，但不能自行改写既定事实。
 *
 * 用法：
 *   node scripts/nw-changes.mjs stage --file manuscript/chapters/ch-013-x.md [--book DIR]
 *   node scripts/nw-changes.mjs list [--json]
 *   node scripts/nw-changes.mjs apply [--id p-001,p-002 | --all] [--dry-run]
 *   node scripts/nw-changes.mjs reject --id p-001 --reason "不是死亡，是假死"
 *
 * 退出码：0 全部通过 · 1 有变更被拒 · 2 用法错 · 6 有待确认项
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadBook, resolveBookDir, parseArgs, emit, log, EXIT, SCHEMA_VERSION,
  readJson, writeJsonAtomic, NWBible, NWText, NWProject,
} from './lib/book.mjs';

const MARKER = /^---CHANGES---\s*$/m;

const OPS = {
  'character.status': { requires: ['id', 'to'], enumField: 'to', enum: NWBible.CHARACTER_STATUS },
  'character.alias.add': { requires: ['id', 'text'] },
  'promise.plant': { requires: ['title', 'setup'] },
  'promise.payoff': { requires: ['id', 'chapter'] },
  'promise.drop': { requires: ['id'] },
  'state.set': { requires: ['chapter', 'entity', 'dim', 'to'], dims: NWBible.STATE_DIMS },
  'world.destroy': { requires: ['id', 'chapter'] },
};

/** 六道门禁。任何一道不过就整条拒绝 —— 宁可让 agent 重写，也不静默写坏状态。 */
function gate(op, ctx) {
  const spec = OPS[op.op];
  if (!spec) return `未知 op「${op.op}」。可用：${Object.keys(OPS).join(', ')}`;
  for (const key of spec.requires) {
    if (op[key] === undefined || op[key] === '') return `${op.op} 缺少必填字段 ${key}`;
  }
  if (!op.evidence) return `${op.op} 缺少 evidence（正文依据句）`;
  if (spec.enum && op[spec.enumField] && !spec.enum.includes(op[spec.enumField])) {
    return `${op.op} 的 ${spec.enumField}=「${op[spec.enumField]}」不在允许值 [${spec.enum.join('|')}] 内`;
  }
  const chapterIds = new Set(ctx.chapters.map((c) => c.id));
  const charIds = new Set(ctx.characters.map((c) => c.id));
  const worldIds = new Set(ctx.world.map((w) => w.id));
  const promiseIds = new Set((ctx.promises.items || []).map((i) => i.id));

  const needChapter = (v, what) => { if (v && !chapterIds.has(v)) return `${what}「${v}」不是已存在的章节 id`; return null; };
  let err = null;
  switch (op.op) {
    case 'character.status':
      if (!charIds.has(op.id)) return `角色「${op.id}」未登记：请先建角色卡，不要顺手发明 id`;
      err = needChapter(op['died-in'], '死亡章节'); break;
    case 'character.alias.add':
      if (!charIds.has(op.id)) return `角色「${op.id}」未登记`; break;
    case 'promise.plant':
      err = needChapter(op.setup, '埋设章节'); break;
    case 'promise.payoff':
      if (!promiseIds.has(op.id)) return `伏笔「${op.id}」不在登记表里，先用 promise.plant 埋`;
      err = needChapter(op.chapter, '回收章节'); break;
    case 'promise.drop':
      if (!promiseIds.has(op.id)) return `伏笔「${op.id}」不在登记表里`; break;
    case 'state.set':
      err = needChapter(op.chapter, '章节');
      if (!err && !spec.dims.includes(op.dim)) return `state.set 的 dim「${op.dim}」不在 v1 六维 [${spec.dims.join('|')}] 内`;
      if (!err && op.entity && !charIds.has(op.entity)) return `状态快照的实体「${op.entity}」未登记`;
      break;
    case 'world.destroy':
      if (!worldIds.has(op.id)) return `世界条目「${op.id}」未登记`;
      err = needChapter(op.chapter, '章节'); break;
  }
  return err;
}

function parseBlock(text) {
  const m = text.match(MARKER);
  if (!m) return { error: '文件里没有 ---CHANGES--- 段' };
  const payload = text.slice(m.index + m[0].length).trim();
  try {
    const json = JSON.parse(payload);
    if (!Array.isArray(json.changes)) return { error: 'CHANGES 里必须有 changes 数组' };
    return { header: json.chapter || null, changes: json.changes };
  } catch (e) {
    return { error: `CHANGES 段不是合法 JSON：${e.message}` };
  }
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const sub = positional[0];
const bookDir = resolveBookDir(flags.book ? [flags.book] : []);
if (!bookDir) { log('未找到书目录，请用 --book 指定'); process.exit(EXIT.USAGE); }

let ctx;
try { ctx = loadBook(bookDir); } catch (e) { log(`读取失败：${e.message}`); process.exit(EXIT.IO); }

const pendingFile = path.join(bookDir, 'continuity', 'pending.json');
const pending = readJson(pendingFile, { schemaVersion: SCHEMA_VERSION, items: [] });
const stamp = () => new Date().toISOString();

switch (sub) {
  case 'stage': {
    if (!flags.file) { log('stage 需要 --file <草稿路径>'); process.exit(EXIT.USAGE); }
    const draft = path.resolve(flags.file);
    if (!fs.existsSync(draft)) { log(`文件不存在：${draft}`); process.exit(EXIT.IO); }
    const parsed = parseBlock(fs.readFileSync(draft, 'utf8'));
    if (parsed.error) { log(`❌ ${parsed.error}`); process.exit(EXIT.BROKEN); }

    const accepted = [], rejected = [];
    parsed.changes.forEach((op, i) => {
      const reason = gate(op, ctx);
      const entry = {
        id: `${path.basename(draft, '.md')}#${i}`,
        chapter: op.chapter || op.setup || parsed.header || ctx.chapters.at(-1)?.id || null,
        op: op.op, at: stamp(), evidence: op.evidence || '',
        payload: op,
      };
      if (reason) rejected.push({ ...entry, rejectedBy: reason, status: 'rejected' });
      else accepted.push({ ...entry, status: 'staged' });
    });

    // 同 id 覆盖（重复 stage 是幂等的，不会越堆越多）
    const ids = new Set([...accepted, ...rejected].map((x) => x.id));
    pending.items = [...pending.items.filter((x) => !ids.has(x.id)), ...accepted, ...rejected];
    writeJsonAtomic(pendingFile, pending);

    emit(!!flags.json, { accepted: accepted.map((a) => ({ id: a.id, op: a.op, chapter: a.chapter })), rejected: rejected.map((r) => ({ id: r.id, reason: r.rejectedBy })) },
      `通过 ${accepted.length} 条，拒绝 ${rejected.length} 条` + (rejected.length ? '\n' + rejected.map((r) => `  ✗ ${r.id}：${r.rejectedBy}`).join('\n') : ''));
    process.exit(rejected.length ? EXIT.ERROR_FOUND : (accepted.length ? EXIT.PENDING : EXIT.OK));
    break;
  }

  case 'list': {
    const items = pending.items.filter((i) => i.status === 'staged');
    emit(!!flags.json, { pending: items },
      items.length ? items.map((i) => `[${i.id}] ${i.op}  chapter=${i.chapter || '-'}  ${i.evidence.slice(0, 50)}`).join('\n') : '没有待确认的变更');
    process.exit(items.length ? EXIT.PENDING : EXIT.OK);
    break;
  }

  case 'apply': {
    const wanted = flags.all ? pending.items.filter((i) => i.status === 'staged')
      : pending.items.filter((i) => flags.id ? String(flags.id).split(',').includes(i.id) && i.status === 'staged' : false);
    if (!wanted.length) { log('没有匹配的 staged 变更'); process.exit(EXIT.OK); }

    const applied = [], skipped = [];
    // tag → 变更后的实际内容；结尾用它算真实基线哈希，绝不写占位符
    const dirty = new Map();
    const markDirty = (kind, id, row) => dirty.set(NWProject.tagFor(kind, id), { kind, row });
    for (const item of wanted) {
      const op = item.payload;
      const reason = gate(op, ctx);   // apply 前再过一次：stage 与 apply 之间书可能已被改
      if (reason) { skipped.push({ id: item.id, reason }); continue; }
      if (flags['dry-run']) { applied.push({ id: item.id, op: op.op, dryRun: true }); continue; }

      switch (op.op) {
        case 'character.status': {
          const rec = ctx.characters.find((c) => c.id === op.id);
          const next = { ...rec, status: op.to };
          if (op.to === 'deceased') next['died-in'] = op['died-in'] || item.chapter;
          if (op.to !== 'deceased') next['died-in'] = null;
          writeJsonAtomic(path.join(bookDir, 'bible', 'characters', `${rec.id}.json`), next);
          Object.assign(rec, next);
          markDirty('character', rec.id, rec);
          break;
        }
        case 'character.alias.add': {
          const rec = ctx.characters.find((c) => c.id === op.id);
          const aliases = rec.aliases || [];
          if (!aliases.some((a) => (typeof a === 'string' ? a : a.text) === op.text)) {
            aliases.push({ text: op.text, kind: op.kind || 'nickname', who: op.who || [], since: item.chapter, until: null, note: op.note || '' });
            writeJsonAtomic(path.join(bookDir, 'bible', 'characters', `${rec.id}.json`), { ...rec, aliases });
            Object.assign(rec, { aliases });
            markDirty('character', rec.id, rec);
          }
          break;
        }
        case 'promise.plant': {
          const id = `p-${String((ctx.promises.items || []).filter((i) => i.type === 'promise').length + 1).padStart(3, '0')}`;
          ctx.promises.items.push({ id, type: 'promise', title: op.title, status: 'planted',
            weight: op.weight || 'minor', setup: { chapter: op.setup, evidence: op.evidence },
            payoff: { chapter: null, due: op.due || null }, created: stamp(), updated: stamp() });
          writeJsonAtomic(path.join(bookDir, 'bible', 'promises.json'), ctx.promises);
          markDirty('promise', id, ctx.promises.items.at(-1));
          break;
        }
        case 'promise.payoff':
        case 'promise.drop': {
          const it = ctx.promises.items.find((i) => i.id === op.id);
          if (op.op === 'promise.payoff') Object.assign(it, { status: 'paid-off', payoff: { ...(it.payoff || {}), chapter: op.chapter, evidence: op.evidence } });
          else Object.assign(it, { status: 'dropped', notes: op.reason || it.notes || '' });
          it.updated = stamp();
          writeJsonAtomic(path.join(bookDir, 'bible', 'promises.json'), ctx.promises);
          markDirty('promise', it.id, it);
          break;
        }
        case 'state.set': {
          const byChapter = ctx.states.byChapter || {};
          byChapter[op.chapter] = byChapter[op.chapter] || {};
          byChapter[op.chapter][op.entity] = byChapter[op.chapter][op.entity] || {};
          const target = byChapter[op.chapter][op.entity];
          if (['injury', 'items', 'knows'].includes(op.dim)) {
            const list = new Set(target[op.dim] || []);
            (Array.isArray(op.to) ? op.to : [op.to]).forEach((v) => (op.remove ? list.delete(v) : list.add(v)));
            target[op.dim] = [...list];
          } else target[op.dim] = op.to;
          const bytes = NWText.bytesOf(NWText.canonicalJson(byChapter[op.chapter]));
          if (bytes > NWBible.MAX_STATE_BYTES_PER_CHAPTER) {
            // 超预算不静默截断：报出来让作者决定删哪个维度
            log(`⚠️ ${op.chapter} 的状态快照已达 ${bytes} 字节，超过 ${NWBible.MAX_STATE_BYTES_PER_CHAPTER} 上限，请精简`);
          }
          ctx.states.byChapter = byChapter;
          writeJsonAtomic(path.join(bookDir, 'bible', 'states.json'), ctx.states);
          markDirty('state', `${op.chapter}|${op.entity}`, {
            id: `${op.chapter}|${op.entity}`, chapter: op.chapter, entity: op.entity, ...target,
          });
          break;
        }
        case 'world.destroy': {
          const w = ctx.world.find((x) => x.id === op.id);
          const lifecycle = { ...(w.lifecycle || {}), 'destroyed-in': op.chapter };
          writeJsonAtomic(path.join(bookDir, 'bible', 'world', `${w.id}.json`), { ...w, lifecycle });
          Object.assign(w, { lifecycle });
          markDirty('world', w.id, w);
          break;
        }
      }
      item.status = 'applied';
      item.appliedAt = stamp();
    }

    if (!flags['dry-run']) {
      writeJsonAtomic(pendingFile, pending);
      const sync = ctx.sync || { schemaVersion: SCHEMA_VERSION, records: {} };
      sync.records = sync.records || {};
      for (const [tag, { kind, row }] of dirty) {
        // 必须是真实哈希：占位符会让 base 与两侧都不等，
        // 于是每条被 agent 碰过的记录在 Web 导入时都变成假冲突
        sync.records[tag] = {
          hash: await NWProject.hashRecord(kind, row),
          rev: (sync.records[tag]?.rev || 0) + 1, source: 'agent', at: stamp(),
        };
      }
      writeJsonAtomic(path.join(bookDir, 'meta', 'sync.json'), sync);
      const line = { at: stamp(), applied: applied.map((a) => ({ id: a.id, op: a.op })), skipped };
      fs.appendFileSync(path.join(bookDir, 'meta', 'changelog.jsonl'), JSON.stringify(line) + '\n');
    }

    emit(!!flags.json, { applied: wanted.length - skipped.length, skipped },
      `${flags['dry-run'] ? '（试运行）' : ''}已落地 ${wanted.length - skipped.length} 条` + (skipped.length ? `\n跳过 ${skipped.length} 条：\n` + skipped.map((s) => `  · ${s.id}：${s.reason}`).join('\n') : ''));
    process.exit(skipped.length ? EXIT.ERROR_FOUND : EXIT.OK);
    break;
  }

  case 'reject': {
    if (!flags.id) { log('reject 需要 --id'); process.exit(EXIT.USAGE); }
    const ids = String(flags.id).split(',');
    let n = 0;
    for (const item of pending.items) {
      if (ids.includes(item.id) && item.status === 'staged') { item.status = 'rejected'; item.rejectedBy = flags.reason || 'author'; item.rejectedAt = stamp(); n++; }
    }
    writeJsonAtomic(pendingFile, pending);
    emit(!!flags.json, { rejected: n }, `已拒绝 ${n} 条`);
    process.exit(EXIT.OK);
    break;
  }

  default:
    log('用法：nw-changes.mjs <stage|list|apply|reject> [options]');
    process.exit(EXIT.USAGE);
}
