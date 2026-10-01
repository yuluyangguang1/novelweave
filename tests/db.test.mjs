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

test('关系边的写库闸：坏边进不了库，进得去的都带角色 id', async () => {
  const n = await freshNovel('关系闸');
  const other = await freshNovel('别书');
  const lin = await NovelDB.characters.create(n.id, { name: '林烟火' });
  const ming = await NovelDB.characters.create(n.id, { name: '明长老' });
  const cs = [];
  for (let i = 1; i <= 3; i++) cs.push(await NovelDB.chapters.create(n.id, { title: `第${i}章`, content: '正文。' }));

  await assert.rejects(() => NovelDB.relations.save(n.id, { from: lin.id, to: ming.id, kind: '  ' }), /缺少 kind/);
  await assert.rejects(() => NovelDB.relations.save(n.id, { from: lin.id, to: 'char-nope', kind: '师徒' }), /客体.*找不到/,
    '端点没建档的边一旦落库，图上少一条线、R31 静默跳过，而全书检查一声不响');
  await assert.rejects(() => NovelDB.relations.save(n.id, { from: lin.id, to: lin.id, kind: '师徒' }), /同一个角色/);
  await assert.rejects(() => NovelDB.relations.save(n.id, { from: lin.id, to: ming.id, kind: '师徒', since: cs[2].id, until: cs[0].id }),
    /起止章选反了/);
  await assert.rejects(() => NovelDB.relations.save(n.id, { from: lin.id, to: ming.id, kind: '师徒', until: 'ch-gone' }),
    /失效章不在这本书里/);
  const foreign = await NovelDB.chapters.create(other.id, { title: '别书的章', content: '正文。' });
  await assert.rejects(() => NovelDB.relations.save(n.id, { from: lin.id, to: ming.id, kind: '师徒', since: foreign.id }),
    /生效章不在这本书里/, '别本书的章 id 也不该框得进来');

  const e = await NovelDB.relations.save(n.id, { from: '林烟火', to: ming.id, kind: ' 师徒 ', since: cs[0].id });
  assert.equal(e.from, lin.id, '端点写的是名字就得收成角色 id：名字是作者随时会改的那个字段');
  assert.equal(e.kind, '师徒', '关系类型两头的不该有的空格不落库');
  assert.match(e.id, /^rel_/);
  assert.equal(e.until, null, '起止留空是合法值（一直如此），不许被闸挡在门外');

  await NovelDB.characters.create(n.id, { name: '明长老' });
  await assert.rejects(() => NovelDB.relations.save(n.id, { from: lin.id, to: '明长老', kind: '师徒' }), /撞名/,
    '两个同名的角色：挑一个连上去就是替作者决定他说的是谁');

  const edited = await NovelDB.relations.save(n.id, { ...e, created_at: 1000, kind: '师徒（记名）' });
  assert.equal(edited.id, e.id, '带 id 保存是改那一条，不是再登记一条');
  assert.equal(edited.created_at, 1000, '改一条边不该把它的登记日期冲成今天');
  assert.ok(edited.updated_at > 1000);

  await NovelDB.characters.delete(ming.id);
  assert.equal((await NovelDB.relations.list(n.id)).length, 1,
    '删角色不连带删边：悄悄删掉作者的账本比留一条断链更坏，断链由 R15 报出来');

  await NovelDB.novels.delete(n.id);
  assert.deepEqual(await NovelDB.relations.list(n.id), [], '删书必须连关系一起清掉');
  await NovelDB.novels.delete(other.id);
});

test('导入不走写库闸：盘上的坏边要进得来，进来了由 R15 说出口', async () => {
  const n = await freshNovel('导入坏边');
  const row = { id: 'rel_legacy', novel_id: n.id, from: 'char-lin', to: 'char-gone', kind: '师徒', address: '', since: null, until: null };
  await NovelDB.putRow('relations', row);
  const rows = await NovelDB.relations.list(n.id);
  assert.equal(rows.length, 1, 'putRow 是导入通路：闸拦的是「手写的坏边」，不是「盘上已有的坏消息」');
  assert.equal(rows[0].from, 'char-lin', '导入不许顺手改写端点 —— 改写过的行会与导出侧的基线哈希对不上');
  await NovelDB.novels.delete(n.id);
});

/**
 * 侧栏章节列表的「最近编辑」这一档。判据只有一份（db 的 stableSort），界面只选档。
 * 最容易出的事故是「同一份库每次打开换个顺序」：毫秒相同、老行没写过 updated_at，
 * 这两种都必须退回 order → id，而不是让键插入顺序决定读者看到什么。
 */
test('章节列表的「最近编辑」档：倒排、并列退回章号、旧行退回创建时间', async () => {
  const n = await freshNovel('排序测试');
  const row = (id, order, updated_at, created_at) => ({
    id, novel_id: n.id, title: `第${order}章`, content: '', summary: '', word_count: 0,
    order, created_at, updated_at,
  });
  await NovelDB.putRow('chapters', row('ch_a', 1, 3000, 1000));
  await NovelDB.putRow('chapters', row('ch_b', 2, 5000, 1000));
  await NovelDB.putRow('chapters', row('ch_c', 3, 5000, 1000));   // 同一次保存的两章：毫秒完全相同
  await NovelDB.putRow('chapters', row('ch_d', 4, null, 4000));   // 旧库行没写过 updated_at

  const titles = (cs) => cs.map((c) => c.title).join('、');
  assert.equal(titles(await NovelDB.chapters.list(n.id, { recent: true })), '第2章、第3章、第4章、第1章',
    '最近改的在前；同一次保存按章号；没写 updated_at 的旧行按它的创建时间排');

  // 换一档不许顺手筛掉或多出章
  const ordered = await NovelDB.chapters.list(n.id);
  const recent = await NovelDB.chapters.list(n.id, { recent: true });
  assert.deepEqual(ordered.map((c) => c.order), [1, 2, 3, 4], '默认档必须还是章号 —— 它是写作的顺序，也是库里的权威顺序');
  assert.deepEqual([...recent.map((c) => c.id)].sort(), [...ordered.map((c) => c.id)].sort(), '换档只换顺序，不许丢章');
  assert.equal(await NovelDB.chapters.nextOrder(n.id), 5, 'nextOrder 走的是章号档，不能被最近编辑带跑');
  await NovelDB.novels.delete(n.id);
});

test('「最近编辑」档与行的插入顺序无关：同一份库两次打开长一样', async () => {
  const mk = (n, k) => [
    { id: `ch${k}a`, novel_id: n.id, title: 'a', content: '', summary: '', word_count: 0, order: 1, created_at: 1, updated_at: 10 },
    { id: `ch${k}b`, novel_id: n.id, title: 'b', content: '', summary: '', word_count: 0, order: 2, created_at: 1, updated_at: 90 },
    { id: `ch${k}c`, novel_id: n.id, title: 'c', content: '', summary: '', word_count: 0, order: 3, created_at: 1, updated_at: 90 },
    { id: `ch${k}d`, novel_id: n.id, title: 'd', content: '', summary: '', word_count: 0, order: 4, created_at: 1, updated_at: 40 },
  ];
  const n1 = await freshNovel('插入顺序一');
  const n2 = await freshNovel('插入顺序二');
  for (const r of mk(n1, 1)) await NovelDB.putRow('chapters', r);
  for (const r of mk(n2, 2).reverse()) await NovelDB.putRow('chapters', r);
  assert.deepEqual(
    (await NovelDB.chapters.list(n1.id, { recent: true })).map((c) => c.title),
    (await NovelDB.chapters.list(n2.id, { recent: true })).map((c) => c.title),
    '同一份内容、不同的写入次序，排出来必须一样：b、c 同一次保存按章号，然后 d，最后 a');
  assert.deepEqual((await NovelDB.chapters.list(n1.id, { recent: true })).map((c) => c.title), ['b', 'c', 'd', 'a']);

  const n3 = await freshNovel('全无时间戳');
  const bare = mk(n3, 3);
  await NovelDB.putRow('chapters', { ...bare[2], updated_at: null, created_at: null });
  await NovelDB.putRow('chapters', { ...bare[0], updated_at: null, created_at: null });
  assert.deepEqual((await NovelDB.chapters.list(n3.id, { recent: true })).map((c) => c.order), [1, 3],
    '时间戳全缺的旧行不许靠键序排 —— 都是 0 就退回章号');
  // 章号也没区分度时（两行 order 相同），最后一档必须是 id：故意先写 d 再写 b
  await NovelDB.putRow('chapters', { ...bare[3], order: 7, updated_at: null, created_at: null });
  await NovelDB.putRow('chapters', { ...bare[1], order: 7, updated_at: null, created_at: null });
  assert.deepEqual((await NovelDB.chapters.list(n3.id, { recent: true })).map((c) => c.id),
    ['ch3a', 'ch3c', 'ch3b', 'ch3d'],
    '时间与章号都一样：排出来的次序不能取决于谁先写进库');
  await Promise.all([n1, n2, n3].map((n) => NovelDB.novels.delete(n.id)));
});

/**
 * 「这一档有没有字数目标那一格」建档与读档必须同一句：以前建档按「非空就算」存，
 * 打包与逐格 diff 按「≥ 下限才算」读，于是短篇库里躺着一个 500 —— 进度条画出 0%，
 * 导出去过不了 schemas 的 minimum，而预设那边说这本书没设过目标。
 */
test('建档那一格：短篇要一个像样的数才存得进去，长篇与脏档一律留空', async () => {
  const cases = [
    [{ format: 'short', targetWords: 8000 }, 8000, '短篇的合法目标照存'],
    [{ format: 'short', targetWords: '8000' }, 8000, '向导以外传来的字符串要收回数字'],
    [{ format: 'short', targetWords: 500 }, null, '低于下限算没设，不是「存着但没人认」'],
    [{ format: 'short', targetWords: 1500.5 }, null, '小数不是合法的存档值（schema 只收整数）'],
    [{ format: 'short' }, null, '没填就是没设'],
    [{ format: 'long', targetWords: 8000 }, null, '长篇没有这一格'],
    [{ format: 'zhong', targetWords: 8000 }, null, '脏档归成长篇，那个数就不该留下'],
  ];
  for (const [input, want, why] of cases) {
    const n = await NovelDB.novels.create({ title: `目标那一格 ${want}`, ...input });
    try {
      assert.equal((await NovelDB.novels.get(n.id)).target_words, want, `${JSON.stringify(input)}：${why}`);
    } finally {
      await NovelDB.novels.delete(n.id);
    }
  }
});

/**
 * 篇幅档这一格以前在建书与列表两处各归一遍，而 update / putRow 那条路根本没归：
 * 库里可以躺着一格 'zhong'，首页按长篇画、侧栏按长篇画，而 R35 拿到的是原值。
 * 现在两处都问 NWTension，写进去与读出来必须同一句。
 */
test('篇幅档：脏档名存不进库（存成缺档），已经在库里的脏档名在列表里归一', async () => {
  const n = await NovelDB.novels.create({ title: '归一测试', format: 'zhong', targetWords: 8000 });
  try {
    assert.equal(n.format, 'long', '认不出的档名要存成缺档，库里不许留第三种值');
    assert.equal(n.target_words, null, '存成长篇就不该留下那个数：进度条不画、面板说没设，而评分卡照它算分');

    // 归一不住在写库那一路：update 与导入用的 putRow 都能把脏值塞进库行
    await NovelDB.novels.update(n.id, { format: 'short' });
    await NovelDB.putRow('novels', { ...(await NovelDB.novels.get(n.id)), format: 'zhong' });
    assert.equal((await NovelDB.novels.get(n.id)).format, 'zhong', '原始行照原样躺在库里（归一不是洗数据）');
    const row = (await NovelDB.novels.list()).find((x) => x.id === n.id);
    assert.equal(row.format, 'long', '首页那一读必须归一，否则书封与「短篇」那枚标记各按各的档画');
  } finally {
    await NovelDB.novels.delete(n.id);
  }
});
