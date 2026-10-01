/**
 * 数据层真跑一遍：建库、写读、级联删除、putRow 白名单。
 *
 * 这些此前一项都没有：db.js 有 600 多行、13 张表，而测试进程里它的函数体
 * 一次都没执行过（只在 _load.mjs 里 require 出来给守卫看门面形状）。
 * 新加一张表最容易出的三种事故 —— 表没建成、级联漏删、导入白名单没放行 ——
 * 全都要靠这一段兜住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './_idb.mjs';
import { NovelDB, NWVolume } from './_load.mjs';

installFakeIndexedDB();

async function freshNovel(title = '账本测试') {
  return NovelDB.novels.create({ title });
}

test('v6 的 secrets 表建得出来、写得进去，默认值补齐', async () => {
  assert.ok(NovelDB.CASCADE_STORES.includes('secrets'), '新表必须进级联清单，否则删书留孤儿');
  const n = await freshNovel();
  const rec = await NovelDB.secrets.save(n.id, {
    term: '沈砚是弑父者', truth: '他亲眼看着父亲死在山下',
    first_chapter: 'ch_3', reveal_chapter: 'ch_12',
  });
  assert.match(rec.id, /^sec_/);
  assert.equal(rec.novel_id, n.id);
  assert.equal(rec.revealed_at, null, '没写过的就不该假装已揭示');
  assert.equal(rec.enabled, true);
  assert.deepEqual(rec.informed, []);

  const list = await NovelDB.secrets.list(n.id);
  assert.equal(list.length, 1);
  assert.equal((await NovelDB.secrets.get(rec.id)).term, '沈砚是弑父者');
});

test('term 是规则拿去正文里比对的字符串：空与重名都挡在写库之前', async () => {
  const n = await freshNovel('重名测试');
  await assert.rejects(() => NovelDB.secrets.save(n.id, { term: '   ' }), /缺少 term/);
  await NovelDB.secrets.save(n.id, { term: '铜印是开门钥匙' });
  await assert.rejects(() => NovelDB.secrets.save(n.id, { term: ' 铜印是开门钥匙 ' }),
    /已经登记过/, 'trim 后同名等于同一条，允许它就等于让 R20 不知道信哪条');

  // 另一本书可以重名：账本是每本书自己的
  const m = await freshNovel('另一本');
  await NovelDB.secrets.save(m.id, { term: '铜印是开门钥匙' });
  assert.equal((await NovelDB.secrets.list(m.id)).length, 1);
});

test('编辑一条登记：改已揭示章要留得下来，且不换主键', async () => {
  const n = await freshNovel('编辑测试');
  const rec = await NovelDB.secrets.save(n.id, { term: '师父早已知情', reveal_chapter: 'ch_20' });
  const upd = await NovelDB.secrets.update(rec.id, { revealed_at: 'ch_20', informed: ['char_lin'] });
  assert.equal(upd.id, rec.id);
  assert.equal(upd.revealed_at, 'ch_20');
  assert.deepEqual(upd.informed, ['char_lin']);
  assert.equal(upd.term, '师父早已知情', 'update 不该把没传的字段冲掉');
  await assert.rejects(() => NovelDB.secrets.update('sec_不存在', { term: 'x' }), /不存在/);
});

test('删书连信息差账本一起清掉（孤儿记录既查不到也清不掉）', async () => {
  const n = await freshNovel('级联测试');
  await NovelDB.secrets.save(n.id, { term: '她不是亲生的' });
  await NovelDB.novels.delete(n.id);
  const orphans = (await NovelDB.dump('secrets')).filter((s) => s.novel_id === n.id);
  assert.deepEqual(orphans.map((s) => s.term), []);
});

test('putRow 放行 secrets，也照样拒绝未知表名', async () => {
  const n = await freshNovel('导入白名单');
  await NovelDB.putRow('secrets', { id: 'sec_from_file', novel_id: n.id, term: '桥洞下的第三具尸体', created_at: 1 });
  assert.equal((await NovelDB.secrets.list(n.id))[0].id, 'sec_from_file', '导入必须尊重文件里的 id');
  await assert.rejects(() => NovelDB.putRow('bogus_table', { id: 'x' }), /未知 store/);
});

/**
 * 世界设定的触发词/副键/销毁章曾经只有 CLI 写得进来：界面上填的那几格走的是
 * createWorldbuilding，它漏一个键，那一格就只活到刷新为止 —— 而 R28/R30 与
 * 两层召回读的全是库里的值。所以这里按「表单交下来的形状」真写一次库。
 */
test('界面上填的世界设定四格必须真落库，改描述不许冲掉它们', async () => {
  const n = await freshNovel('世界条目落库');
  const w = await NovelDB.worldbuilding.create(n.id, {
    type: 'location', name: '青冥山', description: '终年大雾。',
    keys: ['青冥', '北宗故地'], secondary_keys: ['祭石'], selective: true,
    lifecycle: { 'destroyed-in': 'ch-003', 'revealed-in': null },
  });
  const back = await NovelDB.worldbuilding.get(w.id);
  assert.deepEqual(back.keys, ['青冥', '北宗故地'], '触发词没落库：召回带不出来，R30 只认本名');
  assert.deepEqual(back.secondary_keys, ['祭石']);
  assert.equal(back.selective, true, '副键「要不要同时命中」丢了，召回口径就变了');
  assert.equal(back.lifecycle['destroyed-in'], 'ch-003', '销毁章丢了，R28 整条静默');

  await NovelDB.worldbuilding.update(w.id, { description: '改了描述' });
  const again = await NovelDB.worldbuilding.get(w.id);
  assert.equal(again.description, '改了描述');
  assert.deepEqual(again.keys, ['青冥', '北宗故地'], '编辑一格不该把别的格冲掉');
  assert.equal(again.lifecycle['destroyed-in'], 'ch-003');
});

test('AI 起书建的世界条目：没填的格子落成可用的空值，不是 undefined', async () => {
  const n = await freshNovel('起书条目');
  const w = await NovelDB.worldbuilding.create(n.id, { name: '井台', type: 'custom', description: '' });
  assert.deepEqual(w.keys, [], '没填触发词要给空数组：规则与召回都是 .length 判断，undefined 会崩');
  assert.deepEqual(w.secondary_keys, []);
  assert.equal(w.selective, false);
  assert.equal(w.lifecycle['destroyed-in'], null, '没标销毁章必须是 null，不能是 undefined');
});

/**
 * 卷的起止存的是**章 id**。按章号存的话，删过章的这本书里那一卷会盖住完全不同的几十章，
 * 而摘要那一行读起来依然通顺。写库这四处拦的都是这类会静默改写的错。
 */
test('volumes 表：缺卷名、缺起止、起止选反、章不属于本书都拦在写库之前', async () => {
  assert.ok(NovelDB.CASCADE_STORES.includes('volumes'), '新表必须进级联清单，否则删书留孤儿');
  const n = await freshNovel('卷表测试');
  const cs = [];
  for (let i = 1; i <= 4; i++) cs.push(await NovelDB.chapters.create(n.id, { title: `第${i}章`, content: '正文。' }));
  const other = await freshNovel('另一本');
  const foreign = await NovelDB.chapters.create(other.id, { title: '别书的章', content: '正文。' });

  await assert.rejects(() => NovelDB.volumes.save(n.id, { title: '  ', fromChapter: cs[0].id, toChapter: cs[1].id }), /缺少 title/);
  await assert.rejects(() => NovelDB.volumes.save(n.id, { title: '卷一', fromChapter: cs[0].id }), /没有选起止章/);
  await assert.rejects(() => NovelDB.volumes.save(n.id, { title: '卷一', fromChapter: cs[2].id, toChapter: cs[0].id }), /起止章选反了/);
  await assert.rejects(() => NovelDB.volumes.save(n.id, { title: '卷一', fromChapter: cs[0].id, toChapter: foreign.id }),
    /不在这本书里/, '别本书的章 id 也框得进来：那一卷盖的是另一本书的章');

  const v = await NovelDB.volumes.save(n.id, { title: '卷一·出山', fromChapter: cs[0].id, toChapter: cs[1].id, summary: '林烟火出山' });
  assert.match(v.id, /^vol_/);
  assert.equal(v.order, 1, '卷序自己排，作者不用管');
  const second = await NovelDB.volumes.save(n.id, { title: '卷二', fromChapter: cs[2].id, toChapter: cs[3].id });
  assert.equal(second.order, 2);
  assert.equal(second.summary, '', '摘要允许留空：空卷由 volumes.js 判据一兜着，写库不该拦着不让建');

  const single = await NovelDB.volumes.save(n.id, { title: '单章一卷', fromChapter: cs[1].id, toChapter: cs[1].id, summary: '只盖一章' });
  assert.equal(single.toChapter, single.fromChapter, '起止同一章是一卷合法的区间，不许被当成填反了拦在写库之前');
  assert.equal(NWVolume.coveredCount(NWVolume.spans([single], cs)[0]), 1, '单章卷盖住 1 章');

  const edited = await NovelDB.volumes.update(v.id, { summary: '补上的卷摘要' });
  assert.equal(edited.title, '卷一·出山', 'update 不许把没传的格子冲掉');
  assert.equal(edited.fromChapter, cs[0].id);

  await NovelDB.chapters.delete(cs[0].id);
  const rows = await NovelDB.volumes.list(n.id);
  assert.equal(rows[0].fromChapter, cs[0].id, '删章时悄悄改写卷的起止，等于替作者重画账本');
  const plan = NWVolume.recapPlan({ chapters: await NovelDB.chapters.list(n.id), currentId: null, volumes: rows });
  assert.equal(plan.counts.bad, 1, '这一卷必须被判坏，而不是按 order 猜一段区间');

  await NovelDB.novels.delete(n.id);
  assert.deepEqual(await NovelDB.volumes.list(n.id), [], '删书必须连卷一起清掉');
  await NovelDB.novels.delete(other.id);
});
