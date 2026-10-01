import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWText } from './_load.mjs';

test('countWords 用中文口径：汉字算字，英文数字算词，标点空白不计', () => {
  assert.equal(NWText.countWords('你好，世界。\n\nHello world 42'), 7);
  assert.equal(NWText.countWords(''), 0);
  assert.equal(NWText.countWords(null), 0);
  assert.equal(NWText.countWords('！！！……——'), 0);
  assert.equal(NWText.countWords("don't"), 1);
  assert.equal(NWText.countWords('3.5 米'), 2);
  assert.equal(NWText.countWords('他说：「走吧。」'), 4);
});

test('countWords 与旧的 length 口径不同，正是修 bug 的关键', () => {
  const text = '第一章\n\n他走了。\n';
  assert.ok(NWText.countWords(text) < text.length, '换行与标点不应计入字数');
});

test('esc 同时转义尖括号与两种引号，可安全用于带引号属性', () => {
  const evil = `"><img src=x onerror=alert(1)>'`;
  const out = NWText.esc(evil);
  assert.ok(!out.includes('<'), '不应残留 <');
  assert.ok(!out.includes('"'), '不应残留半角双引号');
  assert.ok(!out.includes("'"), '不应残留半角单引号 —— 旧版 escapeHtml 正是漏在这里');
  assert.equal(NWText.esc(0), '0', '数字 0 不能被当成空值吞掉');
  assert.equal(NWText.esc(null), '');
  assert.equal(NWText.esc(undefined), '');
});

test('canonicalJson 与键插入顺序无关，字节稳定', () => {
  const a = NWText.canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = NWText.canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(NWText.canonicalJson([1, undefined, 2]), '[1,null,2]');
  assert.throws(() => NWText.canonicalJson(NaN), /non-finite/);
});

test('slugify 保留 CJK 可读性，剥掉路径不安全字符，空结果走哈希兜底', () => {
  assert.equal(NWText.slugify('第一章：烟火'), '第一章-烟火');
  assert.equal(NWText.slugify('  Ashes / of  Time  '), 'ashes-of-time');
  assert.match(NWText.slugify('！！！'), /^x[0-9a-f]{6}$/);
  assert.equal(NWText.slugify('a'.repeat(100)).length <= 40, true);
});

test('toISO 把旧的 Date.now() 毫秒转成 ISO，且不认识的输入不抛错', () => {
  assert.equal(NWText.toISO(0), '1970-01-01T00:00:00.000Z');
  assert.equal(NWText.toISO(null), null);
  assert.equal(NWText.toISO('not-a-date'), null);
  assert.match(NWText.toISO('2026-08-28T00:00:00Z'), /^\d{4}-/);
});

test('bytesOf 按 UTF-8 计字节，中文一个字算 3 字节（预算控制的基准）', () => {
  assert.equal(NWText.bytesOf('中文'), 6);
  assert.equal(NWText.bytesOf('ab'), 2);
});

/**
 * 封面那一列竖排书名原先被裁了两刀：app.js 取 6 个字，CSS 的 max-height:46px 只放得下约 3 个，
 * 于是「代码说要 6 个字、画出来 3 个」，而且被裁这件事在界面上没有任何信号。
 * 现在长度只有 coverTitle 这一处说了算，超出就要留一个看得见的「…」。
 */
test('coverTitle：封面那列的长度与「被截过」的信号一起给', () => {
  assert.equal(NWText.coverTitle('山河故人旧梦长'), '山河故…');
  assert.equal(NWText.coverTitle('山河故人'), '山河故…', '截出来的只能是容量内的字，剩下的是省略号的位置');
  assert.equal(NWText.coverTitle('长安十二时辰'), '长安十…');
});

test('coverTitle 不该裁的就不裁：短书名一个点都不许多', () => {
  assert.equal(NWText.coverTitle('长歌行'), '长歌行');
  assert.equal(NWText.coverTitle('春'), '春');
  assert.ok(!NWText.coverTitle('长歌行').includes('…'), '三个字的书名正好放得下，凭空多个点是谎报');
  assert.equal(NWText.coverTitle('长歌行', 2), '长歌…', '容量是可传的，写死的那一处只有常量一个');
});

test('coverTitle 的空书名与书名号：不许把《》画上封面', () => {
  assert.equal(NWText.coverTitle(''), '未命名');
  assert.equal(NWText.coverTitle(null), '未命名');
  assert.equal(NWText.coverTitle('《山河故人》'), '山河故…');
  assert.equal(NWText.coverTitle('《春》'), '春');
  assert.equal(NWText.coverTitle('《'), '未命名', '只打了一个书名号：剥完是空的，封面不能画出一列空白');
});

test('封面容量是个写死的数：改了它就得同时改这里与 CSS 那条注释', () => {
  assert.equal(NWText.COVER_TITLE_MAX, 3);
  // 省略号占一格位置：截出来的串最长是 容量 + 1
  assert.equal([...NWText.coverTitle('一二三四五六七八')].length, NWText.COVER_TITLE_MAX + 1);
});
