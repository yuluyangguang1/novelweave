import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NovelLLM, NWText } from './_load.mjs';

const wb = (over) => Object.assign({ id: 'wb-1', name: '青雾山', type: 'location', description: '终年大雾，山门三千阶。' }, over);

test('世界书按关键词触发：命中才注入，没命中不占额度', () => {
  const text = '他踏上青雾山的山门，望着远处。';
  const r = NovelLLM.loreTrigger(text, [wb({}), wb({ id: 'wb-2', name: '黑水泽', description: '沼泽' })]);
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-1']);
  assert.deepEqual(r.dropped, []);
});

test('rule / system 类条目默认 constant，无条件在场', () => {
  const r = NovelLLM.loreTrigger('完全无关的一段话', [wb({ id: 'wb-r', name: '灵气九境', type: 'rule', description: '不可逾越' })]);
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-r']);
});

test('selective 条目要求主键与副键同时命中', () => {
  const entry = wb({ id: 'wb-s', name: '山门', secondary_keys: ['青雾山'], selective: true });
  assert.equal(NovelLLM.loreTrigger('山门下站着人', [entry]).entries.length, 0);
  assert.equal(NovelLLM.loreTrigger('青雾山的山门下站着人', [entry]).entries.length, 1);
});

test('超出预算即截断，但把被裁掉的条目如实报出来（不许静默丢上下文）', () => {
  const big = [
    wb({ id: 'wb-a', name: '甲', description: 'x'.repeat(600) }),
    wb({ id: 'wb-b', name: '乙', description: 'y'.repeat(600) }),
  ];
  const r = NovelLLM.loreTrigger('甲 乙', big, { loreBytes: 700 });
  assert.equal(r.entries.length, 1);
  assert.deepEqual(r.dropped, ['wb-b']);
  assert.ok(NWText.bytesOf(r.entries.map((e) => e.content).join('')) <= 700);
});

test('priority 高的条目先占额度', () => {
  const r = NovelLLM.loreTrigger('甲 乙 丙', [
    wb({ id: 'wb-low', name: '甲', description: 'z'.repeat(600), priority: 0 }),
    wb({ id: 'wb-hi', name: '乙', description: 'z'.repeat(600), priority: 9 }),
  ], { loreBytes: 700 });
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-hi']);
});

test('回归：续写 prompt 必须真的带上正文（旧版 chapter 形参没用、prevChapter 恒 null → 一个字都没有）', () => {
  const prompt = NovelLLM.buildContinuePrompt({
    novel: { title: '烟火纪', genre: '玄幻', description: '少年出山' },
    characters: [{ id: 'char-a', name: '林烟火', role: '主角', personality: '沉默' }],
    worldEntries: [wb({})],
    prevChapter: { title: '山门夜火', content: '上一段的结尾停在师父转身那一刻。' },
    currentChapter: { title: '下山', content: '林烟火推开门，看见青雾山的雾散了。' },
  });

  assert.ok(prompt.includes('上一段的结尾停在师父转身那一刻。'), '前文结尾必须进 prompt');
  assert.ok(prompt.includes('林烟火推开门'), '本章已写正文必须进 prompt，否则是重写而不是续写');
  assert.ok(prompt.includes('终年大雾'), '触发的世界设定必须进 prompt');
  assert.ok(prompt.includes('林烟火（主角）'), '角色设定必须进 prompt');
  assert.ok(prompt.includes('玄幻'), '风格约束必须进 prompt');
});

test('回归：本章没有正文时，明确指示写本章而不是「接着上面」', () => {
  const prompt = NovelLLM.buildContinuePrompt({
    novel: {}, characters: [], worldEntries: [],
    prevChapter: { title: '一', content: '旧正文' },
    currentChapter: { title: '二', content: '   ' },
  });
  assert.ok(prompt.includes('尚未开始'));
  assert.ok(!prompt.includes('不要重复已有内容'));
});

test('一致性检查 prompt 要求只报有原文依据的矛盾', () => {
  const p = NovelLLM.buildConsistencyCheckPrompt('正文'.repeat(50), [{ name: '甲', personality: '寡言' }], [], {});
  assert.ok(p.includes('原文引用'));
  assert.ok(p.includes('一致'));
});
