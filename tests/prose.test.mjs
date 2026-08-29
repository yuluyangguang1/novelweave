import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NWBible, NWText, NWProject, NWStory, repoRoot, scaffoldBook, upsertProject, writeFileAtomic } from './_load-cli.mjs';

/**
 * nw-prose 是「交接」机制，不是文体引擎。所以这里测的不是它判文笔准不准
 * （那不是它的活），而是三件会让交接失效的事：
 * 探到的东西是不是真的能用、结论会不会随正文改动过期、台账会不会污染导出契约。
 */
const script = (name) => path.join(repoRoot, 'scripts', name);
const LONG = '雾散之后是山道，山道尽头是旧石阶。'.repeat(20);   // 300 字，过 isProse 门槛

let tmp, root, bookDir, fakeHome;

function run(args, expectCode = null) {
  let res;
  try {
    res = { code: 0, stdout: execFileSync(process.execPath, [script('nw-prose.mjs'), ...args], { encoding: 'utf8', cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    res = { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
  if (expectCode !== null) assert.equal(res.code, expectCode, `退出码应为 ${expectCode}\n${res.stdout}${res.stderr}`);
  return res;
}
const json = (args) => JSON.parse(run([...args, '--json']).stdout);

function writeChapter(id, number, slug, title, body) {
  const meta = NWBible.newChapter({ id, number, slug, title, status: 'draft', 'x-words': NWText.countWords(body) });
  meta.schemaVersion = NWBible.SCHEMA_VERSION;
  writeFileAtomic(path.join(bookDir, 'manuscript', 'chapters', NWBible.chapterFileName(meta)), NWBible.serializeChapterFile(meta, body));
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-prose-'));
  root = path.join(tmp, '.novelweave');
  bookDir = scaffoldBook(root, { slug: 'yan-huo', id: 'novel_test', title: '烟火纪', genre: '仙侠' });
  upsertProject(root, { slug: 'yan-huo', id: 'novel_test', title: '烟火纪', path: 'yan-huo' });
  writeChapter('ch-001', 1, 'ch1', '山门', LONG);
  writeChapter('ch-002', 2, 'ch2', '夜袭', LONG + '他抬起断臂挡下那一击。');
  writeChapter('ch-003', 3, 'ch3', '大纲章', '尚未展开');   // 不足 200 字，不该进台账

  // 假 HOME：一个真有清单文件的技能、一个只有名字的空壳技能
  fakeHome = path.join(tmp, 'fakehome');
  const deslop = path.join(fakeHome, '.qoder', 'skills', 'story-deslop');
  fs.mkdirSync(path.join(deslop, 'references'), { recursive: true });
  fs.writeFileSync(path.join(deslop, 'SKILL.md'), '---\nname: story-deslop\n---\n去 AI 味\n');
  fs.writeFileSync(path.join(deslop, 'references', 'banned-words.md'), '# 禁用词表\n');
  const hollow = path.join(fakeHome, '.qoder', 'skills', 'novelwriter');
  fs.mkdirSync(hollow, { recursive: true });
  fs.writeFileSync(path.join(hollow, 'SKILL.md'), '---\nname: novelwriter\ndescription: 集成 humanizer-zh 自动去痕\n---\n');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('探测：装了名字但没有清单文件 = 不可用，且要说清为什么', () => {
  const { engines } = json(['probe', '--home', fakeHome]);
  const byId = Object.fromEntries(engines.map((e) => [e.id, e]));
  assert.ok(byId['story-deslop'].usable, 'banned-words.md 在，就该判可用');
  assert.ok(byId['story-deslop'].files.some((f) => f.endsWith('banned-words.md')));
  assert.equal(byId.novelwriter.usable, false, '只有 SKILL.md 的技能不能算有能力');
  assert.match(byId.novelwriter.why, /清单文件一个都不存在/);
  for (const e of engines) if (!e.usable) assert.ok(e.why, `${e.id} 不可用却没给原因`);
});

test('探测要能穿透 category 嵌套布局（Hermes 是 skills/<类别>/<技能>）', () => {
  const nested = path.join(fakeHome, '.hermes', 'skills', 'writing', 'story-deslop', 'references');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, '..', 'SKILL.md'), '---\nname: story-deslop\n---\n');
  fs.writeFileSync(path.join(nested, 'banned-words.md'), '# 表\n');
  const { engines } = json(['probe', '--home', fakeHome]);
  const d = engines.find((e) => e.id === 'story-deslop');
  assert.match(d.via, /hermes/, '两级布局没探到');
});

test('交接包给出正文文件、被交接引擎和边界；没有引擎时不假装跑过', () => {
  const p = json(['packet', bookDir, '--chapter', 'ch-001', '--home', fakeHome]);
  assert.equal(p.chapter, 'ch-001');
  assert.match(p.file, /manuscript\/chapters\//, '正文路径要指向 manuscript 下的章节文件');
  assert.ok(fs.existsSync(p.file), `交接包给的正文文件不存在：${p.file}`);
  assert.equal(p.engine.id, 'story-deslop');
  assert.equal(p.boundary.length, 4);
  assert.ok(p.boundary.some((b) => /重跑 nw-continuity/.test(b)), '改文字会挪证据偏移，必须写进边界');

  const empty = json(['packet', bookDir, '--chapter', 'ch-001', '--home', path.join(tmp, 'no-such-home')]);
  assert.equal(empty.engine, null, '本机没引擎时 engine 必须是 null，不能挑一个不能用的顶上');
  assert.match(empty.file, /ch-001/);
});

test('台账三态：未查 → 已查 → 正文改过就作废', () => {
  const s0 = json(['status', bookDir, '--home', fakeHome]);
  assert.equal(s0.rows.length, 2, '不足 200 字的大纲章不该进台账');
  assert.equal(s0.rows.find((r) => r.chapter === 'ch-001').state, 'unchecked');

  run(['record', bookDir, '--chapter', 'ch-001', '--engine', 'story-deslop', '--result', 'clean']);
  const s1 = json(['status', bookDir, '--home', fakeHome]);
  assert.equal(s1.rows.find((r) => r.chapter === 'ch-001').state, 'clean');

  writeChapter('ch-001', 1, 'ch1', '山门', LONG + LONG);   // 正文变了
  const s2 = json(['status', bookDir, '--home', fakeHome]);
  assert.equal(s2.rows.find((r) => r.chapter === 'ch-001').state, 'stale',
    '查完又改正文，旧结论必须失效，否则台账在撒谎');
});

test('record 的入参校验：跳过得留原因，报问题得给数量', () => {
  run(['record', bookDir, '--chapter', 'ch-002', '--engine', 'none', '--result', 'skipped'], 2);
  run(['record', bookDir, '--chapter', 'ch-002', '--engine', 'none', '--result', 'issues'], 2);
  run(['record', bookDir, '--chapter', 'ch-002', '--engine', 'x', '--result', '也许'], 2);
  const ok = run(['record', bookDir, '--chapter', 'ch-002', '--engine', 'none', '--result', 'skipped',
    '--note', '本机无文体引擎'], 0);
  assert.match(ok.stdout, /已记录/);
  const s = json(['status', bookDir, '--home', fakeHome]);
  const row = s.rows.find((r) => r.chapter === 'ch-002');
  assert.equal(row.state, 'skipped');
  assert.equal(row.note, '本机无文体引擎');
});

test('台账不是作者内容：不进导出树、不动同步基线哈希', async () => {
  run(['record', bookDir, '--chapter', 'ch-001', '--engine', 'story-deslop', '--result', 'issues', '--findings', '6']);
  assert.ok(fs.existsSync(path.join(bookDir, 'continuity', 'prose.json')), 'record 没落盘');

  const ctx = NWStory.buildCtx({
    novel: { id: 'novel_test', title: '烟火纪', genre: '仙侠' },
    chapters: [
      { id: 'ch-001', order: 1, title: '山门', content: LONG, summary: '' },
      { id: 'ch-002', order: 2, title: '夜袭', content: LONG, summary: '' },
    ],
    characters: [], world: [], promises: [], timeline: [], suppressions: [], states: [],
  });
  const tree = await NWProject.buildProjectTree(ctx);
  assert.ok(!Object.keys(tree).some((k) => k.endsWith('prose.json')),
    'prose.json 一旦进导出树，就会被 Web 的三方合并当成可比对记录');

  // 记过台账的这本书，章节哈希仍只由作者内容决定 —— 否则每次文体检查都会造出假冲突
  const before = await NWProject.hashRecord('chapter', ctx.chapters[0]);
  const after = await NWProject.hashRecord('chapter', { ...ctx.chapters[0], prose: { result: 'clean' } });
  assert.equal(before, after, 'prose 混进作者投影 = 幻影冲突');
});

test('文体状态永不阻断：台账里有问题也退出 0', () => {
  const r = run(['status', bookDir, '--home', path.join(tmp, 'no-such-home')]);
  assert.equal(r.code, 0, 'CI 不该因为"这台机器没装第三方技能"或"某章有文笔问题"而红');
  assert.match(r.stdout, /文体检查台账/);
  assert.match(r.stdout, /已查·有问题/, '前序测试写入的结论要能读回来');
  assert.match(r.stdout, /本机无可用文体引擎/);
});
