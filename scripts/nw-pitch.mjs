#!/usr/bin/env node
/**
 * nw-pitch.mjs — 选题评分卡（动笔之前那张卡）
 *
 * 机检（nw-continuity）查的是「写出来的东西哪里错了」，这一份查的是选题本身立不立得住：
 * 开篇有没有钩子、题材撞不撞车、结构三项齐不齐、字数摊到每章合不合理。
 * 判据只有一处：src/core/pitch.js。这里不复制任何阈值，界面也不 ——
 * 三处各写一份必然对不上，那是这个项目反复犯过的病。
 *
 * 用法：
 *   node scripts/nw-pitch.mjs score [bookDir] [对照书目录…] [--against DIR] [--json]
 *   node scripts/nw-pitch.mjs score --concept FILE.json [--genre G] [--words N]
 *        [--format short|long] [对照书目录…] [--json]
 *   node scripts/nw-pitch.mjs rubric [--json]
 *
 * 退出码：0 · 2 用法错 · 5 IO 错。**分数永不阻断**：
 * 分低就退非零，等于把一张建议卡变成门禁，而这套判据是手写词表加几个阈值，
 * 撑不起那个权力。要门禁请去跑 nw-continuity。
 *
 * `--concept` 那份 JSON 的形状就是生成侧产出的梗概：
 * {title, logline, characters:[{name,role,personality}], chapters:[{title,beat}], world:[...]}
 * 它是动笔前的东西，不落库；`score` 直接读磁盘上已导出的一本（或多本对照）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadBook, resolveBookDir, parseArgs, emit, log, EXIT, NWPitch, NWTension, NovelLLM,
} from './lib/book.mjs';

const { positional, flags } = parseArgs(process.argv.slice(2));
// score 可以省：`nw-pitch <bookDir>` 是最高频的用法，与 nw-context 的写法保持一致
let sub = positional[0];
let rest = positional.slice(1);
if (sub !== 'score' && sub !== 'rubric') {
  if (!sub) {
    log('用法：nw-pitch.mjs <score|rubric> [bookDir] [--concept FILE.json] [--genre G] [--words N] [--format short|long] [--against DIR] [对照书目录…] [--json]');
    process.exit(EXIT.USAGE);
  }
  sub = 'score';
  rest = positional.slice(0);
}

if (sub === 'rubric') {
  const rubric = {
    version: NWPitch.PACK_VERSION,
    maxPerDim: NWPitch.MAX_PER_DIM,
    dims: [
      { id: 'hook', label: '开篇钩子', judge: `一句话梗概／首章拍点／首章成稿结尾（≥${NWPitch.BODY_MIN_FOR_HOOK} 字才算）里有几处收在问句或突转上` },
      { id: 'diff', label: '题材差异', judge: `内置手写套路词表 ${NWPitch.CLICHE_WORDS.length} 个词命中数；给了 --against 再加一条大字符重合 ≥${NWPitch.SIMILAR_CUT} 算撞车` },
      { id: 'structure', label: '结构完整', judge: '每章有拍点／主角有性格／有对抗方或未收的伏笔，三项各一分' },
      { id: 'length', label: '篇幅匹配', judge: `目标字数 ÷ 章数 落在单章区间：长篇 ${NWPitch.LENGTH_LABEL.long}，短篇 ${NWPitch.LENGTH_LABEL.short}` },
    ],
    thresholds: NWPitch.VERDICTS,
    words: NWPitch.CLICHE_WORDS,
    notMeasured: ['题材热度', '平台榜单', '爽点强度', '文笔好坏', '作者粉丝量'],
  };
  emit(!!flags.json, rubric, () => [
    `选题评分卡 v${rubric.version} —— 满分 ${rubric.dims.length * rubric.maxPerDim}，四维各 ${rubric.maxPerDim}`, '',
    ...rubric.dims.map((d) => `${d.label}（${d.id}）：${d.judge}`),
    '',
    `分档：${rubric.thresholds.map(([r, t]) => `≥${Math.round(r * 100)}% → ${t}`).join('；')}`,
    `套路词表是手写的 ${rubric.words.length} 个词，不是任何平台的榜单数据：${rubric.words.join('、')}`,
    `明确不测：${rubric.notMeasured.join('、')} —— 本机没有这些数据源，硬写出来就是拿词表冒充热度。`,
    '分数只是建议，本命令恒退 0。',
  ].join('\n'));
  process.exit(EXIT.OK);
}

// ── score ──
const againstDirs = (flags.against === true ? [] : flags.against ? [flags.against] : []).concat(rest.slice(1));

let input;
let label;
if (flags.concept) {
  const file = path.resolve(String(flags.concept));
  if (!fs.existsSync(file)) { log(`概念文件不存在：${file}`); process.exit(EXIT.IO); }
  // 这份文件多半是 agent 把模型给的梗概原样落盘 —— 走 core 那一道解析口，
  // 台词写成英文双引号时先折成「」再读；修了几处要在 stderr 说出来。
  let read;
  try { read = NovelLLM.parseModelJSON(fs.readFileSync(file, 'utf8'), '概念文件'); }
  catch (e) { log(e.message); process.exit(EXIT.IO); }
  if (read.fixes) log(`概念文件里 ${read.fixes} 处内层英文引号已折成「」，评分按折后的文本算`);
  input = read.value;
  label = input.title || path.basename(file);
} else {
  const bookDir = resolveBookDir(rest);
  if (!bookDir) { log('未找到书目录（给显式路径，或在含 .novelweave/project.json 的目录下运行）'); process.exit(EXIT.USAGE); }
  try { input = loadBook(bookDir); } catch (e) { log(`读取失败：${e.message}`); process.exit(EXIT.IO); }
  label = (input.book && (input.book.title || input.book.slug)) || path.basename(bookDir);
  againstDirs.push(bookDir);   // 自己要在对照表里被认出来并剔掉
}

const others = [];
for (const d of againstDirs) {
  const p = path.resolve(String(d));
  const isSelf = input.bookDir && p === path.resolve(input.bookDir);
  if (isSelf) continue;
  let b;
  try { b = loadBook(p).book; } catch { continue; }
  const text = String(b.description || b.title || '').trim();
  if (text) others.push({ title: b.title || path.basename(p), logline: text });
}

// --format 认不出就**不猜一档**（按书自己的档评），但必须说一句：
// 把用户填的那一格静默丢掉，正是这套工具反复犯过的病 —— 他会以为评的是短篇。
const fmtWanted = flags.format === undefined ? undefined
  : (flags.format === true ? '' : String(flags.format));
const fmtOk = fmtWanted !== undefined && NWTension.FORMATS.includes(fmtWanted);
if (fmtWanted !== undefined && !fmtOk) {
  log(`--format 只认 ${NWTension.FORMATS.join(' 或 ')}，这里给的是「${fmtWanted || '(没给值)'}」—— 这一格不参与评分，按书自己的档评`);
}

const opts = {
  genre: flags.genre ? String(flags.genre) : '',
  targetWords: flags.words ? Number(flags.words) || null : null,
  format: fmtOk ? fmtWanted : undefined,
  others,
};
const result = NWPitch.scorePitch(input, opts);
const payload = { book: label, ...result, against: others.map((o) => o.title) };
// 「没查撞车」的原因有两种（没给对照 / 给的对照全是自己），话术不许把它们说成同一种
const noCompare = others.length ? '' : flags.against || rest.length > 1
  ? '对照只有这本书自己，撞车未查' : '未给对照书，本题材是否撞车未查';

emit(!!flags.json, payload, () => [
  `《${label}》`, NWPitch.renderLines(result), '',
  `对照：${others.length ? others.map((o) => `《${o.title}》`).join('、') : noCompare}`,
  `评分不阻断任何东西：${result.verdict}。逐条判据跑 node scripts/nw-pitch.mjs rubric`,
].join('\n'));
process.exit(EXIT.OK);
