import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWDraft } from './_load.mjs';

const { cnToNumber, detect, stripTitleLine, planAdopt } = NWDraft;

test('中文数字：十/二十一/一百零五/一千二百 都要对，判不出来就返回 null', () => {
  assert.equal(cnToNumber('一'), 1);
  assert.equal(cnToNumber('两'), 2);
  assert.equal(cnToNumber('十'), 10);
  assert.equal(cnToNumber('二十一'), 21);
  assert.equal(cnToNumber('一百零五'), 105);
  assert.equal(cnToNumber('一千二百'), 1200);
  assert.equal(cnToNumber('12'), 12);
  assert.equal(cnToNumber('山门'), null);
});

test('编号优先看文件名，其次正文首行；文件名可靠时不被正文噪声带偏', () => {
  assert.deepEqual(
    { ...detect({ filename: '012-夜袭.md', text: '本章完。' }) }.number, 12);
  assert.equal(detect({ filename: 'random.txt', text: '第三章 下山\n\n正文' }).number, 3);
  assert.equal(detect({ filename: 'random.txt', text: '第三章 下山\n\n正文' }).title, '下山');
  assert.equal(detect({ filename: 'Chapter 7 The Fog.md', text: '' }).number, 7);
});

test('文件名有编号无标题时从正文回填标题，编号不一致就不回填', () => {
  const a = detect({ filename: '第1章.md', text: '第一章 山门\n\n他推开门。' });
  assert.equal(a.number, 1);
  assert.equal(a.title, '山门', '标题没回填就会在正文里留一行重复标题');

  const b = detect({ filename: '第3章.md', text: '第一章 山门\n\n他推开门。' });
  assert.equal(b.title, '', '正文编号与文件名不一致时，那个标题不属于本章');
  assert.equal(planAdopt([{ name: '第1章.md', text: '第一章 山门\n\n' + '他推开门。'.repeat(20) }]).chapters[0].body, '他推开门。'.repeat(20));
});

test('楔子/尾声 认出类别但不硬塞编号', () => {
  const d = detect({ filename: '楔子.md', text: '很久以前……' });
  assert.equal(d.number, null);
  assert.equal(d.named, 'prologue');
  assert.equal(detect({ filename: '尾声.md', text: 'x' }).named, 'epilogue');
});

test('stripTitleLine 只吃标题行和紧随的空行，正文一个字不动', () => {
  const body = '第一章 山门\n\n他推开门。\n\n第二句。\n';
  assert.equal(stripTitleLine(body, '山门'), '他推开门。\n\n第二句。\n');
  // 首行不是标题时绝不误删
  const prose = '他推开门。\n\n第二句。\n';
  assert.equal(stripTitleLine(prose, '山门'), prose);
});

test('全部文件都判得出编号时按编号排，重号与跳号只报出来不乱改', () => {
  const { chapters, issues } = planAdopt([
    { name: '第2章.md', text: '第二段正文'.repeat(20) },
    { name: '第1章.md', text: '第一段正文'.repeat(20) },
    { name: '第4章.md', text: '第四段正文'.repeat(20) },
    { name: '第4章-重复.md', text: '撞号的正文'.repeat(20) },
  ]);
  assert.deepEqual(chapters.map((c) => c.number), [1, 2, 4, 4]);
  const kinds = issues.map((i) => i.kind);
  assert.ok(kinds.includes('duplicate-number'), '重号必须报');
  assert.ok(kinds.includes('gap-number'), '跳号（缺第3章）必须报');
  assert.equal(chapters.filter((c) => c.positional).length, 0, '编号可信时不该有任何章被重排');
});

test('楔子取 0 排在最前，且不平移作者已有的章号', () => {
  const { chapters, issues } = planAdopt([
    { name: '002-夜袭.txt', text: '第二段正文'.repeat(20) },
    { name: '楔子.txt', text: '很久以前的事。'.repeat(10) },
    { name: '第1章 山门.md', text: '第一段正文'.repeat(20) },
  ]);
  assert.deepEqual(chapters.map((c) => [c.number, c.title]), [[0, '楔子'], [1, '山门'], [2, '夜袭']],
    '楔子在最前，但第1章仍是第1章');
  assert.equal(chapters.filter((c) => c.positional).length, 1, '只有楔子是被定位的');
  assert.ok(!issues.some((i) => i.kind === 'gap-number'), '0/1/2 连续，不该报跳号');
});

test('尾声接在最后；判不出章号的文件不建档，交回给人', () => {
  const { chapters, unresolved } = planAdopt([
    { name: '第1章.md', text: '第一段正文'.repeat(20) },
    { name: '尾声.md', text: '后来的事。'.repeat(10) },
    { name: '随便一个文件.md', text: '没有章号也没有类别。'.repeat(10) },
  ]);
  assert.deepEqual(chapters.map((c) => c.number), [1, 2], '尾声拿 max+1，不塞进正文序列中间');
  assert.deepEqual(unresolved, ['随便一个文件.md'], '判不出的必须交回去，不能猜个位置留下');
});

test('前导零的草稿名要认得；日期名不能当成章号', () => {
  assert.equal(detect({ filename: '002-夜袭.txt', text: '' }).number, 2);
  assert.equal(detect({ filename: '0007-山门.md', text: '' }).number, 7);
  assert.equal(detect({ filename: '002-夜袭.txt', text: '' }).title, '夜袭');
  const dated = detect({ filename: '2024-03-12 草稿.md', text: '正文正文正文' });
  assert.equal(dated.number, null, '日期不是章号');
  assert.equal(detect({ filename: '随手记.md', text: '没有编号' }).number, null);
});

test('空文件与短到可疑的文件要单独报出来，不能算正常建档', () => {
  const { issues } = planAdopt([
    { name: '第1章.md', text: '' },
    { name: '第2章.md', text: '太短了' },
  ]);
  assert.ok(issues.filter((i) => i.kind === 'suspiciously-short').length === 2);
});

test('建档统计里的字数按正文算，与前端同一口径', () => {
  const { stats } = planAdopt([{ name: '第1章.md', text: '第一章 山门\n\n你好，世界。Hello world 42' }]);
  assert.equal(stats.chapters, 1);
  assert.equal(stats.words, 7);   // 4 汉字 + Hello + world + 42，与 text.test.mjs 钉住的口径一致
});
