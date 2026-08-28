import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerMod } from './_load.mjs';

const { parse, toHash } = routerMod;

test('解析作品与章节深链（旧版 router 完全没有 hash 处理，刷新即回首页）', () => {
  assert.deepEqual(parse('#/novel/novel_abc/chapter/ch_xyz'), {
    page: 'workspace', params: { novelId: 'novel_abc', chapterId: 'ch_xyz' },
  });
  assert.deepEqual(parse('#/novel/novel_abc'), { page: 'workspace', params: { novelId: 'novel_abc' } });
});

test('解析首页与设置页，含空前缀两种写法', () => {
  assert.equal(parse('#/home').page, 'home');
  assert.equal(parse('').page, 'home');
  assert.equal(parse('#/').page, 'home');
  assert.equal(parse('#/settings').page, 'settings');
});

test('未知路由返回 null，交给调用方重定向，不会白屏', () => {
  assert.equal(parse('#/nonsense/x'), null);
});

test('URL 编码过的中文 id 能还原', () => {
  const id = encodeURIComponent('烟火纪');
  assert.equal(parse(`#/novel/${id}`).params.novelId, '烟火纪');
});

test('toHash 与 parse 往返一致', () => {
  for (const [page, params] of [
    ['workspace', { novelId: 'n1', chapterId: 'c2' }],
    ['workspace', { novelId: 'n1' }],
    ['settings', {}],
    ['home', {}],
  ]) {
    assert.equal(parse(toHash(page, params)).page, page);
  }
  assert.equal(toHash('workspace', { novelId: 'n1', chapterId: 'c2' }), '#/novel/n1/chapter/c2');
  assert.equal(toHash('home', {}), '#/home');
});
