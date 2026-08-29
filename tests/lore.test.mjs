import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NovelLLM, NWStory, NWContext, NWText } from './_load.mjs';

const wb = (over) => Object.assign({ id: 'wb-1', name: '青雾山', type: 'location', description: '终年大雾，山门三千阶。' }, over);

test('世界书按关键词触发：命中才注入，没命中不占额度', () => {
  const text = '他踏上青雾山的山门，望着远处。';
  const r = NWStory.loreTrigger(text, [wb({}), wb({ id: 'wb-2', name: '黑水泽', description: '沼泽' })]);
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-1']);
  assert.deepEqual(r.dropped, []);
});

test('rule / system 类条目默认 constant，无条件在场', () => {
  const r = NWStory.loreTrigger('完全无关的一段话', [wb({ id: 'wb-r', name: '灵气九境', type: 'rule', description: '不可逾越' })]);
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-r']);
});

test('selective 条目要求主键与副键同时命中', () => {
  const entry = wb({ id: 'wb-s', name: '山门', secondary_keys: ['青雾山'], selective: true });
  assert.equal(NWStory.loreTrigger('山门下站着人', [entry]).entries.length, 0);
  assert.equal(NWStory.loreTrigger('青雾山的山门下站着人', [entry]).entries.length, 1);
});

test('超出预算即截断，但把被裁掉的条目如实报出来（不许静默丢上下文）', () => {
  const big = [
    wb({ id: 'wb-a', name: '甲', description: 'x'.repeat(600) }),
    wb({ id: 'wb-b', name: '乙', description: 'y'.repeat(600) }),
  ];
  const r = NWStory.loreTrigger('甲 乙', big, { loreBytes: 700 });
  assert.equal(r.entries.length, 1);
  assert.deepEqual(r.dropped, ['wb-b']);
  assert.ok(NWText.bytesOf(r.entries.map((e) => e.content).join('')) <= 700);
});

test('priority 高的条目先占额度', () => {
  const r = NWStory.loreTrigger('甲 乙 丙', [
    wb({ id: 'wb-low', name: '甲', description: 'z'.repeat(600), priority: 0 }),
    wb({ id: 'wb-hi', name: '乙', description: 'z'.repeat(600), priority: 9 }),
  ], { loreBytes: 700 });
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-hi']);
});

test('回归：续写 prompt 必须带上正文、前文、世界设定、角色与风格', () => {
  const ctx = NWStory.buildCtx({
    novel: { id: 'n', title: '烟火纪', genre: '玄幻', description: '少年出山', word_count: 0, chapter_count: 2 },
    chapters: [
      { id: 'ch_a', order: 1, title: '山门夜火', content: '上一段的结尾停在师父转身那一刻。' },
      { id: 'ch_b', order: 2, title: '下山', content: '林烟火推开门，看见青雾山的雾散了。' },
    ],
    characters: [{ id: 'char_lin', name: '林烟火', role: '主角', personality: '沉默', background: '山中长大' }],
    world: [wb({})], promises: [], timeline: [], suppressions: [],
  });
  const p = NovelLLM.buildContinuePrompt({ ctx, chapterId: 'ch_b' });
  assert.ok(p.includes('师父转身那一刻'), '前文结尾必须进 prompt');
  assert.ok(p.includes('林烟火推开门'), '本章已写正文必须进 prompt，否则是重写而不是续写');
  assert.ok(p.includes('终年大雾'), '触发的世界设定必须进 prompt');
  assert.ok(p.includes('林烟火'), '角色设定必须进 prompt');
  assert.ok(p.includes('玄幻'), '风格约束必须进 prompt');
});

test('回归：本章没有正文时，指示写本章而不是「接着上面」', () => {
  const ctx = NWStory.buildCtx({
    novel: { id: 'n', title: 'x', genre: '仙侠', word_count: 0, chapter_count: 2 },
    chapters: [
      { id: 'ch_a', order: 1, title: '一', content: '旧正文在这里结束。' },
      { id: 'ch_b', order: 2, title: '二', content: '   ' },
    ],
    characters: [], world: [], promises: [], timeline: [], suppressions: [],
  });
  const p = NovelLLM.buildContinuePrompt({ ctx, chapterId: 'ch_b' });
  assert.ok(p.includes('尚未开始'));
  assert.ok(!p.includes('不要重复已有内容'));
});

test('同一本书：Web 与 CLI 必须产出同一份上下文（本项重构的存在理由）', () => {
  const rows = {
    novel: { id: 'novel_t', title: '烟火纪', genre: '仙侠', description: '少年出山', word_count: 0, chapter_count: 3 },
    chapters: [
      { id: 'ch_a', order: 1, title: '山门', content: '明长老笑道：“不可下山。”当夜他战死。' },
      { id: 'ch_b', order: 2, title: '夜袭', content: '林烟火抬起断臂挡下那一击。' },
      { id: 'ch_c', order: 3, title: '下山', content: '' },
    ],
    characters: [
      { id: 'char_ming', name: '明长老', role: '导师', status: 'deceased', 'died-in': 'ch_a' },
      { id: 'char_lin', name: '林烟火', role: '主角', appearance: '灰袍', appearance_tokens: [{ key: '断臂', since: 'ch_b', until: 'ch_b' }] },
    ],
    world: [{ id: 'wb_q', name: '青雾山', type: 'location', description: '终年大雾，山门三千阶。' }],
    promises: [{ id: 'p_1', type: 'promise', title: '半枚铜印', status: 'planted', weight: 'major',
      setup: { chapter: 'ch_a', evidence: '师父塞给我' }, payoff: { chapter: null, due: 'ch_b' } }],
    timeline: [], suppressions: [],
    states: [{ id: 'ch_b|char_lin', chapter: 'ch_b', entity: 'char_lin', loc: '山门', alive: 'alive', injury: ['断臂'], items: [], knows: [], goal: '查明夜火' }],
  };
  const ctx = NWStory.buildCtx(rows);
  const built = NWContext.buildSections(ctx, { chapterId: 'ch_c' });
  const names = built.sections.map((s) => s.name);
  // 这两节正是重构前 Web 独缺的：没有它们，状态矩阵与伏笔表只服务于事后检查
  assert.ok(names.includes('分章状态快照'), '上下文缺「分章状态快照」节');
  assert.ok(names.includes('未结线索'), '上下文缺「未结线索」节');

  const prompt = NovelLLM.buildContinuePrompt({ ctx, chapterId: 'ch_c' });
  assert.ok(prompt.includes('半枚铜印'), '未回收伏笔必须进 prompt');
  assert.ok(prompt.includes('查明夜火'), '状态快照必须进 prompt');
  assert.ok(prompt.includes('不得凭空行动'), '死亡约束必须写进写作要求');
  // prompt 与派生文档遍历同一批 section，内容不得分叉
  assert.ok(prompt.includes(built.sections[0].block));
});

test('一致性检查 prompt 要求只报有原文依据的矛盾', () => {
  const p = NovelLLM.buildConsistencyCheckPrompt('正文'.repeat(50), [{ name: '甲', personality: '寡言' }], [], {});
  assert.ok(p.includes('原文引用'));
  assert.ok(p.includes('一致'));
});
