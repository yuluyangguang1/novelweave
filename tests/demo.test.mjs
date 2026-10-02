/**
 * 示例书的形状测试：src/demo.js 文件头那段说明书里，每一句「有几章、几行状态、
 * 机检几个 error」都是宣称。宣称一旦过期，示例书就变成了本项目最擅长的那种东西 ——
 * 写着做了、其实没做。所以这里走浏览器同一条路（假 IndexedDB → seed() → 真 db.js
 * 读表 → NWStory.buildCtx → NWRules.runRules），把那些句子逐条钉住。
 *
 * 口径与 tests/_load.mjs 一致：src/core 是经典脚本，Node 里要 createRequire，
 * 且必须先立好全局对象，demo.js 的 seed 才拿得到 NovelDB。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installFakeIndexedDB } from './_idb.mjs';
import { NovelDB, NWStory, NWRules, NWText, repoPath } from './_load.mjs';

installFakeIndexedDB();
const require = createRequire(import.meta.url);
const NWDemo = require(repoPath('src/demo.js'));

const seeded = await NWDemo.seed();
const [novel, chapters, characters, world, promises, timeline, states] = await Promise.all([
  NovelDB.novels.get(seeded), NovelDB.chapters.list(seeded), NovelDB.characters.list(seeded),
  NovelDB.worldbuilding.list(seeded), NovelDB.promises.list(seeded),
  NovelDB.timeline.list(seeded), NovelDB.states.list(seeded),
]);
const ctx = NWStory.buildCtx({
  novel, chapters, characters, world,
  promises, timeline, suppressions: [], states,
  relations: { edges: [] }, decisions: [], secrets: [], volumes: [],
});
const diags = NWRules.runRules(ctx);
const sev = (level) => diags.filter((d) => d.severity === level);

test('示例书认自己的门牌：id、书名、版本号与文件头同一出处', async () => {
  assert.equal(NWDemo.DEMO_ID, 'novel_demo', '换 id 等于把老用户那本书孤儿化');
  assert.equal(seeded, NWDemo.DEMO_ID);
  assert.equal(novel.title, '天机阁（示例）');
  assert.equal(novel.demo_version, NWDemo.DEMO_VERSION, '种进库的版本号必须是导出的那一个');
  assert.equal(typeof NWDemo.isDemo, 'function');
  // 版本号不一致时整本重灌：这一句是「内容升级能到老用户手里」的全部实现
  // 光看 demo_version 回没回来不够 —— 不级联删除也能把这一格写回正确值，
  // 而旧版多出来的那些行会留在库里，界面上一眼就能看出来。
  await NovelDB.putRow('chapters', {
    id: 'ch-005', novel_id: NWDemo.DEMO_ID, title: '旧版的一章', content: 'x', order: 5,
    word_count: 1, created_at: Date.now(), updated_at: Date.now(),
  });
  await NovelDB.putRow('promises', {
    id: 'p-old', novel_id: NWDemo.DEMO_ID, type: 'promise', title: '旧版的一条',
    status: 'planted', weight: 'minor', created_at: Date.now(), updated_at: Date.now(),
  });
  await NovelDB.putRow('novels', { ...novel, demo_version: NWDemo.DEMO_VERSION - 1 });
  assert.equal(await NWDemo.seed(), NWDemo.DEMO_ID);
  assert.equal((await NovelDB.novels.get(NWDemo.DEMO_ID)).demo_version, NWDemo.DEMO_VERSION);
  assert.deepEqual((await NovelDB.chapters.list(NWDemo.DEMO_ID)).map((c) => c.id),
    ['ch-001', 'ch-002', 'ch-003', 'ch-004'], '旧版遗留的章没被删掉，升级后就是一张混着两版内容的目录');
  assert.deepEqual((await NovelDB.promises.list(NWDemo.DEMO_ID)).map((p) => p.id),
    ['p-zhen'], '旧版遗留的伏笔没被删掉，「未结」的数字就不是这一本的');
});

test('四章、章名与每章三千字：文件头数的字数是 countWords 口径，标点不入账', () => {
  assert.deepEqual(chapters.map((c) => c.order), [1, 2, 3, 4]);
  assert.deepEqual(chapters.map((c) => c.title), ['过手', '念命', '收字', '归格']);
  const lengths = chapters.map((c) => NWText.countWords(c.content));
  assert.deepEqual(lengths.map((n) => n >= 3000), [true, true, true, true],
    `宣称「每章 3000 字以上」，实测 ${lengths.join('/')}`);
  assert.equal(novel.word_count, lengths.reduce((a, b) => a + b, 0), '总数必须是四章的和，不是另算一份');
});

test('三张角色卡、一条已故：死了的就是第 2 章死的，第 3 章之后不许他行动', () => {
  assert.equal(characters.length, 3);
  const dead = characters.filter((c) => c.status === 'deceased');
  assert.equal(dead.length, 1, JSON.stringify(characters.map((c) => `${c.name}:${c.status}`)));
  assert.equal(dead[0].name, '裴无咎');
  assert.equal(dead[0]['died-in'], 'ch-002');
  assert.deepEqual(sev('error'), [], '死人出场是 error，示例书不许带 error 出厂');
  assert.deepEqual(diags.filter((d) => d.rule === 'dead-character-on-stage'), []);
});

test('四条世界条目、一条未收伏笔、四个时间线锚点：面板上的数就是这些', () => {
  assert.equal(world.length, 4, JSON.stringify(world.map((w) => w.name)));
  assert.equal(timeline.length, 4);
  assert.equal(promises.length, 1);
  const p = promises[0];
  assert.equal(p.status, 'planted', '伏笔要保持未收，收了「未结线索」面板就是空的');
  assert.equal(p.setup.chapter, 'ch-001');
  assert.equal(p.payoff.due, 'ch-004');
});

test('七行状态矩阵，第 1 章那行是基线：没有基线，第 2 章的大事件会被读成平章', () => {
  assert.equal(states.length, 7, JSON.stringify(states.map((s) => s.id)));
  assert.ok(states.some((s) => s.chapter === 'ch-001'), '缺基线行时 R24 会把第 2 章判成无变化');
  const noChange = diags.filter((d) => d.rule === 'chapter-no-change' && d.chapter === 'ch-002');
  assert.deepEqual(noChange, [], JSON.stringify(noChange.map((d) => d.message)));
});

test('出厂机检：0/4/5，warn 全归 R22 —— 文体提示不是事实矛盾，示例书不为它改口', () => {
  assert.deepEqual(NWRules.summarize(diags).error, 0, '文件头写的是零 error');
  const warn = sev('warn');
  assert.equal(warn.length, 4, `文件头写 warn 4，实测 ${warn.length}`);
  assert.ok(warn.length > 0, '一条 warn 都没有，就演示不了 warn 与 error 的分工');
  assert.deepEqual([...new Set(warn.map((d) => d.rule))], ['ai-flavor'],
    JSON.stringify(warn.map((d) => `${d.rule}:${d.message}`)));
  assert.equal(sev('info').length, 5, `文件头写 info 5，实测 ${sev('info').length}`);
});

test('未结线索面板里有真内容：R9 抓得到「提灯道人」，抓不到旧版宣称的「灰衣人」', () => {
  const d = diags.filter((x) => x.rule === 'unregistered-entity');
  assert.equal(d.length, 1, JSON.stringify(d.map((x) => x.message)));
  const names = NWRules.entityCandidates(ctx).map((s) => s.name);
  assert.ok(names.includes('提灯道人'), `称谓式那一支该认「道人」：${JSON.stringify(names)}`);
  assert.ok(!names.some((n) => n.includes('灰衣')), `无姓无衔的旧宣称两式都抓不到：${JSON.stringify(names)}`);
  // 左起最长匹配会把候选前一个字咬进来，所以正文必须把这个名号写在标点之后
  assert.ok(!names.some((n) => n.endsWith('灯道人') && n !== '提灯道人'),
    `名号被上一字咬进候选了：${JSON.stringify(names)}`);
  assert.ok(d[0].message.includes('提灯道人'), d[0].message);
});

test('示例书跑的是浏览器那条路：分表读取 + buildCtx，不自己拼上下文', () => {
  const s = NWRules.summarize(diags);
  assert.equal(s.error, 0);
  assert.equal(s.warn, sev('warn').length);
  assert.equal(s.info, sev('info').length);
  assert.equal(ctx.characters.length, 3);
  assert.equal(ctx.states.byChapter['ch-004']['char-cen'].alive, 'alive');
});
