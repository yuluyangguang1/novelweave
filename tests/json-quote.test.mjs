/**
 * G 批：模型把人物台词写成英文双引号时，那份 JSON 还读不读得出来 —— 读不出来时说的是什么话。
 *
 * 判据只有一处：src/core/llm.js 的 parseModelJSON / repairInnerQuotes。
 * 消费的是四条模型输出路（梗概 / 拆解 / 关系边）加上两份 agent 落盘的东西
 * （CHANGES 段、nw-pitch 的概念文件）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NovelLLM, NWBible, repoRoot, scaffoldBook, upsertProject, writeFileAtomic,
} from './_load-cli.mjs';

const L = NovelLLM;

/**
 * 模型的犯错形态从合法那份倒推：内容里有引号，但它没转义。
 * 手搓 `\\"` 这种串最容易写出「夹具本身就不是模型会犯的错误」—— 那就白测了。
 */
const sloppy = (obj) => JSON.stringify(obj).replace(/\\"/g, '"');

const CONCEPT = {
  title: '烟火纪',
  characters: [{ name: '林烟火', role: '主角', personality: '闷' }],
  chapters: [{ title: '第五章', beat: '明长老说"不可下山"，她推门出去' }],
};

const broken = (args, expectCode, label) => {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', args[0]), ...args.slice(1)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (expectCode !== null) {
    assert.equal(r.status, expectCode, `${label || args.join(' ')} 退的是 ${r.status}\n${r.stdout}${r.stderr}`);
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
};

// ───────────── 修复本身 ─────────────

test('合法的份一个字都不动：修复只在对读不出来的东西出手', () => {
  const samples = [
    JSON.stringify({ beat: '明长老说"不可下山"' }),
    JSON.stringify({ beat: '他道：「不可下山。」', n: 1 }),
    JSON.stringify({ list: [1, 2], nested: { a: '值里有 , } ] : 这些符号' } }),
    '{\n  "a": "x",\n  "b": [ { "c": "y" } ]\n}',
  ];
  for (const s of samples) {
    const r = L.repairInnerQuotes(s);
    assert.equal(r.text, s, `合法的份被改写了：${s} → ${r.text}`);
    assert.equal(r.fixes, 0, '合法的份报了修复数，作者就会以为模型犯过错');
  }
});

test('成对的内层引号折成「」，那句话读得出来', () => {
  const bad = sloppy(CONCEPT);
  assert.throws(() => JSON.parse(bad), '夹具本身得先是真读不出来的，否则这条钉不住任何东西');
  const r = L.parseModelJSON(bad, '梗概');
  assert.equal(r.fixes, 2, `动的引号只数应是 2（一开一合），实报 ${r.fixes}`);
  assert.equal(r.value.chapters[0].beat, '明长老说「不可下山」，她推门出去');
});

test('一句里两对台词都折对，不会串成「他说「停”那种', () => {
  const r = L.repairInnerQuotes(sloppy({ beat: '甲说"走"，乙说"停"' }));
  assert.equal(r.fixes, 4);
  assert.equal(JSON.parse(r.text).beat, '甲说「走」，乙说「停」');
});

test('落单的开口引号在收尾处补一只」，不留半只引号给作者', () => {
  const r = L.parseModelJSON(sloppy({ beat: '他说"停下' }), '梗概');
  assert.ok(r.fixes > 0, '这种形态本来就是非法 JSON，不修就读不出来');
  assert.equal(r.value.beat, '他说「停下」', '补的那只闭合引号是这条判据的全部内容');
});

test('已经正确转义的引号原样交回，不许顺手折成「」', () => {
  const ok = JSON.stringify({ beat: '他说"停下"' });
  const r = L.parseModelJSON(ok, '梗概');
  assert.equal(r.fixes, 0, '合法输入报了修复数');
  assert.equal(r.value.beat, '他说"停下"', '作者要看到模型原话，转义过的英文引号不是错误');
});

// ───────────── 修不好时说什么话 ─────────────

test('修不出来的不假装修好：说人话、给位置、不念引擎的英文', () => {
  for (const [name, src] of [
    ['键漏了引号', '{title:"甲"}'],
    ['逗号多了', '{"title":"甲",}'],
    ['少了一个逗号', '{"title":"甲" "characters":[]}'],
  ]) {
    let msg = '';
    try { L.parseModelJSON(src, '梗概'); } catch (e) { msg = e.message; }
    assert.ok(msg, `${name} 这种输入应当报错`);
    assert.match(msg, /梗概的 JSON 读不出来/, `${name} 的报错没说是哪一份输出：${msg}`);
    assert.doesNotMatch(msg, /Expected|Unexpected|at position|JSON at /, `${name} 把引擎那句英文念给作者了：${msg}`);
    assert.match(msg, /出错的位置附近/, `${name} 没给出位置，作者只能整段重发：${msg}`);
    assert.match(msg, /台词一律用「」/, `${name} 的报错没告诉作者下一步怎么说：${msg}`);
  }
});

test('截断的那种要说「像没写完」，与引号问题分开', () => {
  let msg = '';
  try { L.parseModelJSON('{"title":"甲","beat":"未闭合的台词', '梗概'); } catch (e) { msg = e.message; }
  assert.match(msg, /没写完/, `半截 JSON 报成引号问题就是误导：${msg}`);
  assert.match(msg, /结尾停在「/, `断了却不给出断在哪：${msg}`);
  assert.doesNotMatch(msg, /出错的位置附近/, `没解析到过位置，却报了一个「附近」：${msg}`);
});

test('引擎那句不带位置的一种（Unexpected token …）：说结尾停在哪，但不谎称没写完', () => {
  let msg = '';
  try { L.parseModelJSON('{"a": 1, "b": }', '梗概'); } catch (e) { msg = e.message; }
  assert.match(msg, /梗概的 JSON 读不出来/, msg);
  assert.match(msg, /结尾停在「/, `V8 这句没有 position，位置取不到就该退到结尾：${msg}`);
  assert.doesNotMatch(msg, /没写完/, `完整一份 JSON 少了个值，却说成"没写完"是把作者往错方向支使：${msg}`);
  assert.doesNotMatch(msg, /Expected|Unexpected|at position|is not valid JSON/, `念了引擎原话：${msg}`);
});

test('整段里连一个对象都没有时，只说没找到，不编位置', () => {  const msg = (() => { try { L.parseModelJSON('我觉得这个故事不错', '梗概'); } catch (e) { return e.message; } return ''; })();
  assert.match(msg, /梗概的 JSON 没找到/, msg);
  assert.doesNotMatch(msg, /出错的位置附近/, `没有对象可言的位置，却报了一个「附近」：${msg}`);
});

// ───────────── 修复必须说出口 ─────────────

test('修了几处一律报给调用方：四路模型输出各一条，次数各归各', () => {
  const calls = [];
  const notice = (n) => calls.push(n);
  const concept = L.parseConceptJSON(sloppy(CONCEPT), { onRepair: notice });
  assert.equal(concept.chapters[0].beat, '明长老说「不可下山」，她推门出去');
  const decon = L.parseDeconstructJSON(sloppy({
    name: '压山门', goldenFinger: '一枚铜印',
    beats: [{ at: '第1屏', type: '钩子', note: '师父说"别接这单"' }],
  }), { onRepair: notice });
  assert.equal(decon.beats[0].note, '师父说「别接这单」');
  const edges = L.parseExtractedRelations(sloppy({
    edges: [{ from: '甲', to: '乙', kind: '师徒', address: '', evidence: '乙喊了一声"师父"' }],
  }), { onRepair: notice });
  assert.equal(edges[0].evidence, '乙喊了一声「师父」');
  assert.deepEqual(calls, [2, 2, 2], `三路各动两只引号，实际报的是 ${JSON.stringify(calls)}`);
});

test('没修就不许响：合法与彻底读不出来的两种都不报修复', () => {
  const calls = [];
  const notice = (n) => calls.push(n);
  L.parseConceptJSON(JSON.stringify(CONCEPT), { onRepair: notice });
  assert.deepEqual(calls, [], '合法的份也报修复，作者会以为每份都在改他的台词');
  assert.throws(() => L.parseConceptJSON('{"title":"甲","characters":[],}', { onRepair: notice }), /读不出来/);
  assert.deepEqual(calls, [], '没修成的也报修复，等于宣布了一件没发生的事');
});

test('调用方没接回调也照样读得出来（修复不靠提示活着）', () => {
  const r = L.parseModelJSON(sloppy(CONCEPT), '梗概');
  assert.equal(r.fixes, 2);
});

// ───────────── prompt 侧：话说在前头 ─────────────

test('四个要 JSON 的 prompt 都带同一句引号规则', () => {
  const rule = L.JSON_QUOTE_RULE;
  assert.ok(rule.includes('「」'), '规则本身得给出可用写法，不能只说"不要用英文引号"');
  const prompts = [
    L.buildShortConceptPrompt({ idea: '一单回乡', genre: '仙侠', structure: '反转流', tier: L.SHORT_TIERS[1] }),
    L.buildLongConceptPrompt({ idea: '一单回乡', genre: '仙侠', volumes: 3 }),
    L.buildDeconstructPrompt('正文', { source: '作者提供', words: '1200' }),
    L.buildExtractRelationsPrompt('正文', [{ name: '明长老' }]),
  ];
  prompts.forEach((p, i) => {
    assert.match(p, /只输出|只回复|JSON/, `第 ${i} 份不是要 JSON 的 prompt，用例表过期了`);
    assert.ok(p.includes(rule), `第 ${i} 份 prompt 没带引号规则，模型照样会把台词写成英文引号`);
  });
});

// ───────────── 两条 CLI 消费路 ─────────────

const bookFixture = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-quote-'));
  const root = path.join(tmp, '.novelweave');
  const bookDir = scaffoldBook(root, { slug: 'quote', id: 'novel_quote', title: '引号测试', genre: '仙侠' });
  upsertProject(root, { slug: 'quote', id: 'novel_quote', title: '引号测试', path: 'quote' });
  const meta = { ...NWBible.newChapter({ id: 'ch-001', number: 1, slug: 'c1', title: '第一章', status: 'draft' }), schemaVersion: '1' };
  writeFileAtomic(path.join(bookDir, 'manuscript', 'chapters', NWBible.chapterFileName(meta)),
    NWBible.serializeChapterFile(meta, '明长老说「不可下山」。她推门出去。\n'));
  return { tmp, bookDir };
};

test('CHANGES 段：台词写成英文引号也 stage 得进去，且 stderr 说动了几个字', () => {
  const { tmp, bookDir } = bookFixture();
  try {
    const draft = path.join(bookDir, 'manuscript', 'chapters', 'ch-002-sloppy.md');
    const block = sloppy({ chapter: 'ch-002', changes: [{ op: 'promise.plant', title: '半枚铜印', setup: 'ch-001', weight: 'major', evidence: '师父说"别接这单"' }] });
    writeFileAtomic(draft, '新的正文。\n\n---CHANGES---\n' + block + '\n');
    const r = broken(['nw-changes.mjs', 'stage', '--file', draft, '--book', bookDir, '--json'], 6, 'CHANGES stage');
    assert.match(r.stderr, /内层英文引号已折成「」/, '修了引号不出声，作者对着 pending 里的「」会以为模型自己写的');
    assert.match(r.stderr, /2 处/, `没说动了几处：${r.stderr}`);
    const pending = JSON.parse(fs.readFileSync(path.join(bookDir, 'continuity', 'pending.json'), 'utf8'));
    assert.equal(pending.items[0].evidence, '师父说「别接这单」', '修好的引号没进账本，说明 stage 用的不是修后的那份');
    assert.equal(JSON.parse(r.stdout).accepted.length, 1, r.stdout);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('CHANGES 段真坏了：退 3、说人话，不念引擎那句英文', () => {
  const { tmp, bookDir } = bookFixture();
  try {
    const draft = path.join(bookDir, 'manuscript', 'chapters', 'ch-003-broken.md');
    writeFileAtomic(draft, '新的正文。\n\n---CHANGES---\n{"chapter": "ch-003", "changes": [{"op": "promise.plant", "title": }]}\n');
    const r = broken(['nw-changes.mjs', 'stage', '--file', draft, '--book', bookDir], 3, 'CHANGES 坏段');
    assert.match(r.stderr, /CHANGES 段的 JSON 读不出来/, r.stderr);
    assert.doesNotMatch(r.stderr, /Expected|Unexpected|at position/, `把引擎的英文念给 agent：${r.stderr}`);
    const pending = JSON.parse(fs.readFileSync(path.join(bookDir, 'continuity', 'pending.json'), 'utf8'));
    assert.deepEqual(pending.items, [], '读不出来的段却往 pending 里写了东西');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('nw-pitch --concept 吃模型原样落盘的那份：修得动、说得出、分数照算', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-quote-pitch-'));
  try {
    const file = path.join(tmp, 'concept.json');
    fs.writeFileSync(file, sloppy(CONCEPT), 'utf8');
    const r = broken(['nw-pitch.mjs', 'score', '--concept', file, '--json'], 0, 'pitch --concept');
    assert.match(r.stderr, /折成「」/, '修了引号不说，评分卡依据的文本与作者手上的文件就不是同一份');
    const j = JSON.parse(r.stdout);
    assert.equal(j.book, '烟火纪', r.stdout);
    assert.equal(j.basis.chapterCount, 1, '修后的章节没进评分依据');
    const bad = path.join(tmp, 'broken.json');
    fs.writeFileSync(bad, '{"title":"甲","characters":', 'utf8');
    const e = broken(['nw-pitch.mjs', 'score', '--concept', bad, '--json'], 5, 'pitch 坏文件');
    assert.match(e.stderr, /概念文件的 JSON 读不出来/, e.stderr);
    assert.doesNotMatch(e.stderr, /Expected|Unexpected/, `把引擎的英文念给 agent：${e.stderr}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
