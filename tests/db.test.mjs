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
import { NovelDB } from './_load.mjs';

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
