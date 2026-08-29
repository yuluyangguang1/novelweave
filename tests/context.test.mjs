import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWContext, NWStory, NWProject } from './_load.mjs';

const LONG = '雾' + '散'.repeat(199); // 399 字，超过 recap 的每章上限

function rows(overrides = {}) {
  return {
    novel: { id: 'novel_t', title: '烟火纪', genre: '仙侠', description: '少年出山' },
    chapters: [
      { id: 'ch_a', order: 1, title: '山门', content: '明长老笑道：“不可下山。”', summary: '核心事件：明长老拒林烟火下山\n出场角色：明长老、林烟火\n状态变化：明长老位置山门\n新埋或回收的伏笔：半枚铜印' },
      { id: 'ch_b', order: 2, title: '夜袭', content: '林烟火抬起断臂挡下那一击。', summary: '核心事件：夜袭发生，林烟火断臂' },
      { id: 'ch_c', order: 3, title: '下山', content: '' },
    ],
    characters: [], world: [], promises: [], timeline: [], suppressions: [], states: [],
    ...overrides,
  };
}

function recapOf(chapterId, overrides) {
  const ctx = NWStory.buildCtx(rows(overrides));
  const built = NWContext.buildSections(ctx, { chapterId });
  const sec = built.sections.find((s) => s.name === '前情摘要');
  return { text: sec ? sec.text : null, built, names: built.sections.map((s) => s.name) };
}

test('前情摘要进上下文：长篇靠它替代回读全文', () => {
  const { text, names } = recapOf('ch_c');
  assert.ok(names.includes('前情摘要'));
  assert.match(text, /第1章《山门》/);
  assert.match(text, /夜袭发生/);
});

test('摘要是四行结构时只取「核心事件」：位置与伏笔另有专节，重复注入会挤爆预算', () => {
  const { text } = recapOf('ch_c');
  assert.ok(text.includes('明长老拒林烟火下山'), '核心事件要在');
  assert.ok(!text.includes('出场角色：'), '四行结构的其他行不该进 recap');
  assert.ok(!text.includes('新埋或回收的伏笔'), '同上');
});

test('自由文本摘要原样进 recap，超长截断并留下省略号（截断必须看得出来）', () => {
  const { text } = recapOf('ch_b', {
    chapters: [
      { id: 'ch_a', order: 1, title: '山门', content: 'x', summary: LONG },
      { id: 'ch_b', order: 2, title: '下山', content: '' },
    ],
  });
  const line = text.split('\n')[0];
  assert.ok(line.length < LONG.length + 30, '长摘要必须被截断');
  assert.ok(line.endsWith('…'), '截断要留标记，不能看起来像完整事实');
});

test('指定了书里不存在的章节要说清楚，而不是在 current.id 上抛裸 TypeError', () => {
  const ctx = NWStory.buildCtx(rows());
  assert.throws(() => NWContext.buildSections(ctx, { chapterId: 'ch_不存在' }),
    /章节「ch_不存在」不在本书中/);
});

test('超过 12 章时如实报出没列出的章数，而不是静默丢掉更早的前情', () => {
  const many = Array.from({ length: 16 }, (_, i) => ({
    id: 'ch_' + i, order: i + 1, title: '第' + (i + 1) + '章', content: '正文', summary: `事件${i + 1}`,
  }));
  many[15].content = '';
  const { text } = recapOf('ch_15', { chapters: many });
  assert.match(text, /更早 3 章的摘要未列出/);
  assert.ok(text.includes('- 第15章《第15章》：事件15'), '最近一章必须在');
  assert.ok(!text.includes('- 第3章《第3章》：事件3'), '窗口外更早的章不该列出');
  assert.ok(text.includes('- 第4章《第4章》：事件4'), '窗口应含最近 12 章');
});

test('摘要再长也不能把「本章已有正文」挤出预算 —— 接着写比前情更要紧', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({
    id: 'ch_' + i, order: i + 1, title: '第' + (i + 1) + '章', content: '旧正文若干。', summary: LONG,
  }));
  many.push({ id: 'ch_last', order: 15, title: '新章', content: '林烟火推开门，' + '雾'.repeat(1800) });
  const { text, names, built } = recapOf('ch_last', { chapters: many });
  assert.match(text, /更早 \d+ 章/, '14 章带摘要时应当有折叠提示');
  assert.ok(names.includes('本章已有正文'), '本章正文被裁掉了');
  assert.ok(!built.usage.truncated || built.usage.droppedSections.every((d) => d.name !== '本章已有正文'));
});

test('没填任何摘要时给出可执行的提示，而不是留一节空白', () => {
  const { text } = recapOf('ch_c', {
    chapters: [
      { id: 'ch_a', order: 1, title: '山门', content: 'x' },
      { id: 'ch_b', order: 2, title: '夜袭', content: 'y' },
      { id: 'ch_c', order: 3, title: '下山', content: '' },
    ],
  });
  assert.match(text, /尚未填写/);
});

test('多行摘要在库行与文件记录两种形状下哈希一致，否则导入必误报冲突', async () => {
  const dbRow = { id: 'ch_a', order: 1, title: '山门', content: '正文', summary: '核心事件：甲\n状态变化：乙' };
  const fileRow = { id: 'ch_a', number: 1, title: '山门', body: '正文', content: '正文', status: 'draft', summary: '核心事件：甲\n状态变化：乙' };
  assert.equal(await NWProject.hashRecord('chapter', dbRow), await NWProject.hashRecord('chapter', fileRow));
});
