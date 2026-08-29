import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWStory, NWRules, NWBible, readSchema } from './_load.mjs';

/** 模拟 IndexedDB 里的行（v2 形状），走 Web 端的装配路径。 */
const rows = {
  novel: { id: 'novel_1', title: '烟火纪', genre: '仙侠', description: '少年出山', word_count: 40, chapter_count: 3 },
  chapters: [
    { id: 'ch_1', order: 1, title: '山门', content: '明长老笑道：“不可下山。”当夜他在山门口战死。', word_count: 21 },
    { id: 'ch_2', order: 2, title: '夜袭', content: '明长老推开门，径直走进内堂。林烟火抬起断臂挡下。', word_count: 22 },
    { id: 'ch_3', order: 3, title: '下山', content: '林烟火挥了挥断臂，独自离去。', word_count: 12 },
  ],
  characters: [
    { id: 'char_ming', name: '明长老', role: '导师', status: 'deceased', 'died-in': 'ch_1', personality: '持重', appearance_tokens: [] },
    { id: 'char_lin', name: '林烟火', role: '主角', status: 'alive',
      appearance: '灰袍', appearance_tokens: [{ key: '断臂', since: 'ch_2', until: 'ch_2' }] },
  ],
  world: [{ id: 'wb_1', name: '青雾山', type: 'location', description: '终年大雾，山门三千阶。' }],
  promises: [{ id: 'p_1', novel_id: 'novel_1', type: 'promise', title: '半枚铜印', status: 'planted', weight: 'major',
    setup: { chapter: 'ch_1', evidence: '师父塞给他' }, payoff: { chapter: null, due: 'ch_2' }, created_at: 1, updated_at: 2 }],
  timeline: [{ id: 'ev_1', novel_id: 'novel_1', chapter: 'ch_1', label: '山门夜火', day: 1, clock: '夜', confidence: 'author' }],
  suppressions: [],
};

test('Web 端装配出的 ctx 能喂给同一份引擎，并查出死人出场', () => {
  const ctx = NWStory.buildCtx(rows);
  assert.equal(ctx.chapters.length, 3);
  assert.deepEqual([...ctx.chapterNumbers.entries()], [['ch_1', 1], ['ch_2', 2], ['ch_3', 3]]);
  const rules = NWRules.runRules(ctx).map((d) => d.rule);
  assert.ok(rules.includes('dead-character-on-stage'), 'R1 应命中');
  assert.ok(rules.includes('appearance-token-violation'), 'R7 应命中（断臂只到 ch_2，ch_3 又用左臂）');
  assert.ok(rules.includes('promise-overdue'), 'R3b 应命中（期限 ch_2 已过）');
});

test('引擎是确定性的：同一 ctx 跑两次，fingerprint 集合完全相同', () => {
  const ctx = NWStory.buildCtx(rows);
  const a = NWRules.runRules(ctx).map((d) => d.fingerprint).sort();
  const b = NWRules.runRules(ctx).map((d) => d.fingerprint).sort();
  assert.deepEqual(a, b);
  assert.ok(a.length >= 3, '至少应命中三条');
  assert.ok(a.every((fp) => fp.split(':').length === 3), 'fingerprint 必须是 rule:chapter:entity 三段式');
});

test('Web 装配出的记录符合 schema 契约（导出的文件 agent 拿去才能用）', () => {
  const ctx = NWStory.buildCtx(rows);
  const root = readSchema();
  const check = (kind, value) => assert.deepEqual(
    NWBible.validate(root.$defs[kind], value, root), [], `${kind} 不合契约`);

  check('character', ctx.characters[0]);
  check('character', ctx.characters[1]);
  check('worldEntry', ctx.world[0]);
  check('promises', ctx.promises);
  check('timeline', ctx.timeline);
  check('lexicon', ctx.lexicon);
  for (const ch of ctx.chapters) {
    // 章节 frontmatter 的契约形状（body 不在 schema 范围内）
    check('chapter', { id: ch.id, number: ch.number, title: ch.title, status: ch.status, slug: ch.slug,
      pov: ch.pov, time_anchor: ch.time_anchor, locations: ch.locations, characters: ch.characters,
      mentions: ch.mentions, flags: ch.flags, summary: ch.summary });
  }
});

test('角色卡的中文定位映射到英文枚举，appearance 拆成 summary + tokens', () => {
  const card = NWStory.toCharacter(rows.characters[1]);
  assert.equal(card.role, 'protagonist');
  assert.equal(card.role_zh, '主角'); // 原值保留，导出与回读都不丢信息
  assert.equal(card.appearance.summary, '灰袍');
  assert.deepEqual(card.appearance.tokens, [{ key: '断臂', since: 'ch_2', until: 'ch_2' }]);
});

test('角色卡往返不丢字段（导入 Web 时必须能还原成行）', () => {
  const card = NWStory.toCharacter(rows.characters[0]);
  const back = NWStory.fromCharacter(card, 'novel_1');
  assert.equal(back.status, 'deceased');
  assert.equal(back['died-in'], 'ch_1');
  assert.equal(back.role, '导师');
  assert.equal(back.novel_id, 'novel_1');
});

test('未声明出场角色时按名字命中推导 mentions，但不替作者声明 characters', () => {
  const ch = NWStory.toChapter(rows.chapters[1], rows.characters);
  assert.deepEqual(ch.mentions.sort(), ['char_lin', 'char_ming']);
  assert.deepEqual(ch.characters, [], 'characters 只能由作者显式声明，脚本不得代填');
});

test('世界条目一名三写：name / comment / keys[0]，constant 由类型推得', () => {
  const w = NWStory.toWorld(rows.world[0]);
  assert.equal(w.comment, '青雾山');
  assert.deepEqual(w.keys, ['青雾山']);
  assert.equal(w.constant, false);
  assert.equal(NWStory.toWorld({ id: 'wb_r', name: '灵气九境', type: 'rule', description: 'x' }).constant, true);
});

test('豁免记录进入 ctx 后，诊断被标记 suppressedBy 而不是凭空消失', () => {
  const ctx = NWStory.buildCtx(rows);
  const raw = NWRules.runRules(ctx);
  const fp = raw.find((d) => d.rule === 'dead-character-on-stage').fingerprint;
  const ctx2 = NWStory.buildCtx({ ...rows, suppressions: [{ fingerprint: fp, reason: '闪回', at: 1 }] });
  const raw2 = NWRules.runRules(ctx2);
  assert.equal(raw2.length, raw.length, '豁免不该删除诊断');
  assert.equal(raw2.find((d) => d.fingerprint === fp).suppressedBy, '闪回');
});

test('空库（新书）不该炸，也不该报任何东西', () => {
  const ctx = NWStory.buildCtx({ novel: { id: 'n', title: 'x', word_count: 0, chapter_count: 0 }, chapters: [], characters: [], world: [], promises: [], timeline: [], suppressions: [] });
  assert.deepEqual(NWRules.runRules(ctx), []);
  assert.equal(ctx.lexicon.names && Object.keys(ctx.lexicon.names).length, 0);
});

test('states：行聚合会丢掉空维度（空不是事实，否则 R2 会拿空去比角色卡）', () => {
  const states = NWStory.statesFromRows([
    { chapter: 'ch-001', entity: 'char-a', loc: '青雾山', alive: 'alive', injury: [], items: ['铜印'], knows: [], goal: '' },
    { chapter: 'ch-001', entity: 'char-b', loc: '', alive: '', injury: [], items: [], knows: [], goal: '' },
  ]);
  assert.deepEqual(states.byChapter['ch-001']['char-a'], { loc: '青雾山', alive: 'alive', items: ['铜印'] });
  assert.deepEqual(states.byChapter['ch-001']['char-b'], {}, '全空的行不该产出任何维度');
  assert.equal(states.budgetPerChapter, 3072);
});

test('states：行 ⇄ 文件 双向可逆', () => {
  const file = NWStory.statesFromRows([
    { chapter: 'ch-001', entity: 'char-a', loc: '山门', alive: 'deceased', injury: ['断臂'], items: [], knows: ['师父已死'], goal: '下山' },
  ]);
  const back = NWStory.stateRowsFromFile(file, 'n1');
  assert.equal(back.length, 1);
  assert.equal(back[0].id, 'ch-001|char-a', '主键必须保持 章节|实体，合并才能按记录对齐');
  assert.equal(back[0].alive, 'deceased');
  assert.deepEqual(back[0].injury, ['断臂']);
  assert.deepEqual(back[0].items, [], '列表维度缺值应是空数组而不是空串');
});

test('states：快照与角色卡互斥时，浏览器装配路径必须报出 R2', () => {
  const ctx = NWStory.buildCtx({
    novel: { id: 'n1', title: '测试', genre: '玄幻', word_count: 0, chapter_count: 2 },
    chapters: [
      { id: 'ch-001', order: 1, title: '一', content: '甲还活着。' },
      { id: 'ch-002', order: 2, title: '二', content: '乙死了。' },
    ],
    characters: [{ id: 'char-a', name: '甲某', role: '主角', status: 'alive' }],
    world: [], promises: [], timeline: [], suppressions: [],
    states: [{ id: 'ch-002|char-a', novel_id: 'n1', chapter: 'ch-002', entity: 'char-a',
      loc: '', alive: 'deceased', injury: [], items: [], knows: [], goal: '' }],
  });
  assert.equal(ctx.states.byChapter['ch-002']['char-a'].alive, 'deceased', 'buildCtx 应把行聚合成 byChapter');
  const d = NWRules.runRules(ctx).filter((x) => x.rule === 'status-declared-contradiction');
  assert.equal(d.length, 1, 'R2 的快照分支在 Web 端此前从未被触发');
  assert.equal(d[0].chapter, 'ch-002');
  assert.ok(d[0].evidence.basis.join().includes('character.status=alive'));
});

test('旧库（v1 行，缺全部新字段）归一化后仍可跑', () => {
  const legacy = { ...rows, characters: [{ id: 'char_ming', name: '明长老', role: '导师' }] };
  const ctx = NWStory.buildCtx(legacy);
  assert.equal(ctx.characters[0].status, 'alive', '缺 status 必须默认在世，否则 R1 全线静默');
  assert.equal(ctx.characters[0].role, 'deuteragonist');
  assert.deepEqual(ctx.characters[0].appearance, { summary: '', tokens: [] });
});
