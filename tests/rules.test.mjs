import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWRules } from './_load.mjs';

const ch = (n, over = {}) => ({
  id: `ch-00${n}`, number: n, title: `第${n}章`, status: 'draft',
  body: '', characters: [], mentions: [], locations: [], flags: [], ...over,
});
const char = (id, over = {}) => ({
  id, name: over.name || id, role: 'supporting', status: 'alive', 'died-in': null,
  aliases: [], appearance: { summary: '', tokens: [] }, ...over,
});
const ctx = (over = {}) => ({
  book: { id: 'novel_t', title: '测试书', genre: '玄幻' },
  chapters: [], characters: [], world: [],
  promises: { items: [] }, states: { byChapter: {} },
  timeline: { anchors: [], backstory: [] }, lexicon: { names: {} }, ...over,
});
const rules = (diags) => diags.map((d) => d.rule);
const of = (diags, rule) => diags.filter((d) => d.rule === rule);

test('R1 死人出场：死亡章之后被写成正在行动 → error', () => {
  const c = ctx({
    chapters: [ch(1), ch(2), ch(3, { body: '明长老推开山门，径直走到林烟火面前。' })],
    characters: [char('char-ming', { name: '明长老', status: 'deceased', 'died-in': 'ch-002' })],
  });
  const d = of(NWRules.runRules(c), 'dead-character-on-stage');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'error');
  assert.equal(d[0].chapter, 'ch-003');
  assert.ok(d[0].evidence.quote.includes('明长老'));
  assert.ok(d[0].fingerprint.includes('ch-003'));
});

test('R1 章内声明出场（frontmatter.characters）优先级最高，直接 error', () => {
  const c = ctx({
    chapters: [ch(1), ch(2, { characters: ['char-ming'], body: '众人沉默。' })],
    characters: [char('char-ming', { name: '明长老', status: 'deceased', 'died-in': 'ch-001' })],
  });
  const d = of(NWRules.runRules(c), 'dead-character-on-stage');
  assert.equal(d[0].severity, 'error');
  assert.ok(d[0].evidence.basis.join().includes('chapter.characters'));
});

test('R1 误报控制：flashback 标记章完全豁免', () => {
  const c = ctx({
    chapters: [ch(1), ch(2, { flags: ['flashback'], body: '明长老推开山门，走到他面前。' })],
    characters: [char('char-ming', { name: '明长老', status: 'deceased', 'died-in': 'ch-001' })],
  });
  assert.deepEqual(of(NWRules.runRules(c), 'dead-character-on-stage'), []);
});

test('R1 误报控制：领属提及与回忆语境不算出场', () => {
  const base = { characters: [char('char-ming', { name: '明长老', status: 'deceased', 'died-in': 'ch-001' })] };
  // 「明长老的说法」是所有格，本人在第 2 章已死，不该报
  const possessive = NWRules.runRules(ctx({ ...base, chapters: [ch(1), ch(2, { body: '他想起明长老的说法，觉得其中必有隐情。' })] }));
  assert.deepEqual(of(possessive, 'dead-character-on-stage'), [], '领属提及被误判成出场');
  // 回忆标记词命中 → 降到 info 而不是闭嘴
  const recalled = of(NWRules.runRules(ctx({ ...base, chapters: [ch(1), ch(2, { body: '当年，明长老也曾站在这里。' })] })), 'dead-character-on-stage');
  assert.equal(recalled[0].severity, 'info');
});

test('R1 死亡之前的章节不报', () => {
  const c = ctx({
    chapters: [ch(1, { body: '明长老笑着说：不可下山。' }), ch(2), ch(3)],
    characters: [char('char-ming', { name: '明长老', status: 'deceased', 'died-in': 'ch-003' })],
  });
  assert.deepEqual(of(NWRules.runRules(c), 'dead-character-on-stage'), []);
});

test('R2 deceased 却没写 died-in → 单独报出来（否则后续所有出场检查都失效）', () => {
  const c = ctx({ chapters: [ch(1)], characters: [char('char-m', { name: '某甲', status: 'deceased' })] });
  const d = of(NWRules.runRules(c), 'status-declared-contradiction');
  assert.equal(d[0].severity, 'error');
  assert.ok(d[0].message.includes('没有写明死于哪一章'));
});

test('R2 角色卡状态与分章快照互斥', () => {
  const c = ctx({
    chapters: [ch(1), ch(2)],
    characters: [char('char-a', { name: '甲', status: 'alive' })],
    states: { byChapter: { 'ch-002': { 'char-a': { alive: 'deceased' } } } },
  });
  const d = of(NWRules.runRules(c), 'status-declared-contradiction');
  assert.equal(d[0].chapter, 'ch-002');
});

test('R3 伏笔逾期梯度：major 10 章 warn、20 章 error；candidate 一律不报', () => {
  const mk = (gap, weight) => ctx({
    chapters: Array.from({ length: gap + 1 }, (_, i) => ch(i + 1)),
    promises: { items: [{ id: 'p-001', type: 'promise', title: '铜印', status: 'planted', weight, setup: { chapter: 'ch-001' } }] },
  });
  assert.equal(of(NWRules.runRules(mk(12, 'major')), 'promise-unpaid')[0].severity, 'warn');
  assert.equal(of(NWRules.runRules(mk(25, 'major')), 'promise-unpaid')[0].severity, 'error');
  assert.deepEqual(of(NWRules.runRules(mk(30, 'candidate')), 'promise-unpaid'), [], '未确认的候选伏笔不该打扰作者');
  assert.deepEqual(of(NWRules.runRules(mk(5, 'major')), 'promise-unpaid'), []);
});

test('R3b 设了 due 就走过期规则，不再走通用未回收（避免同一伏笔报两条）', () => {
  const c = ctx({
    chapters: [ch(1), ch(2), ch(3)],
    promises: { items: [{ id: 'p-002', type: 'promise', title: '密道', status: 'planted', weight: 'major', setup: { chapter: 'ch-001' }, payoff: { due: 'ch-002' } }] },
  });
  const diags = NWRules.runRules(c);
  assert.deepEqual(of(diags, 'promise-unpaid'), []);
  assert.equal(of(diags, 'promise-overdue').length, 1);
});

test('R4 回收早于埋设 → error；声明已埋却没登记埋设章 → error', () => {
  const a = ctx({
    chapters: [ch(1), ch(2)],
    promises: { items: [{ id: 'p-003', type: 'promise', title: 'x', status: 'paid-off', setup: { chapter: 'ch-002' }, payoff: { chapter: 'ch-001' } }] },
  });
  assert.equal(of(NWRules.runRules(a), 'payoff-before-setup').length, 1);
  const b = ctx({ chapters: [ch(1)], promises: { items: [{ id: 'p-004', type: 'promise', title: 'y', status: 'planted' }] } });
  assert.equal(of(NWRules.runRules(b), 'payoff-before-setup').length, 1);
});

test('R7 外貌区间：until 之后仍描述 = 特征复活（error），since 之前出现 = 提前（warn）', () => {
  const withTok = (tokens) => ctx({
    chapters: [ch(1, { body: '她左臂完好，提着药篮。' }), ch(2, { body: '她抬起断臂示意。' }), ch(3, { body: '她用左臂推开木门。' })],
    characters: [char('char-lin', { name: '林', appearance: { summary: '', tokens } })],
  });
  const stale = of(NWRules.runRules(withTok([{ key: '左臂', since: 'ch-001', until: 'ch-002' }])), 'appearance-token-violation');
  assert.ok(stale.some((d) => d.chapter === 'ch-003' && d.severity === 'error'));
  const early = of(NWRules.runRules(withTok([{ key: '左臂', since: 'ch-003' }])), 'appearance-token-violation');
  assert.ok(early.some((d) => d.chapter === 'ch-001' && d.severity === 'warn'));
  // 白名单章跳过
  assert.deepEqual(of(NWRules.runRules(withTok([{ key: '左臂', since: 'ch-001', until: 'ch-002', allowIn: ['ch-003'] }])), 'appearance-token-violation'), []);
});

test('R9 未登记实体：跨章反复出现才报，且聚合成一条 info', () => {
  const c = ctx({
    chapters: [
      ch(1, { body: '沈夜舟站在桥头。沈夜舟抬头看月。' }),
      ch(2, { body: '沈夜舟再次出现在渡口，众人哗然。' }),
    ],
    characters: [char('char-a', { name: '甲某' })],
  });
  const d = of(NWRules.runRules(c), 'unregistered-entity');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'info');
  assert.ok(d[0].message.includes('沈夜舟'));
  // 建档之后就不再报
  const known = ctx({ ...c, lexicon: { names: { 沈夜舟: 'char-x' }, allowlist: [] } });
  assert.deepEqual(of(NWRules.runRules(known), 'unregistered-entity'), []);
});

test('R14 结构非法：章号重复是 error，slug 重复是 warn', () => {
  const c = ctx({
    chapters: [ch(1, { slug: 'dup' }), ch(1, { slug: 'other', id: 'ch-00x' }), ch(2, { slug: 'dup', id: 'ch-00y' })],
  });
  const d = of(NWRules.runRules(c), 'structure-invalid');
  assert.ok(d.some((x) => x.message.includes('章号 1 被') && x.severity === 'error'));
  assert.ok(d.some((x) => x.message.includes('slug') && x.severity === 'warn'));
});

test('R15 引用断链全部报出，否则别的规则会静默失效', () => {
  const c = ctx({
    chapters: [ch(1, { characters: ['char-nope'], locations: ['wb-nope'], time_anchor: 'ev-999' })],
  });
  const d = of(NWRules.runRules(c), 'dangling-reference');
  assert.equal(d.length, 3);
});

test('R16 派生字段被手改要报出来', () => {
  const c = ctx({ chapters: [ch(1, { body: '正文一共十个字才对', xWords: 999 })] });
  assert.equal(of(NWRules.runRules(c), 'derived-field-touched').length, 1);
});

test('R6 时间线倒流：同日更早的时辰排在后面要抓到', () => {
  const c = ctx({
    chapters: [ch(1), ch(2)],
    timeline: { anchors: [
      { id: 'ev-001', chapter: 'ch-001', label: '山门夜火', at: { day: 1, clock: '夜' }, confidence: 'author' },
      { id: 'ev-002', chapter: 'ch-002', label: '次日清晨', at: { day: 1, clock: '晨' }, confidence: 'author' },
    ], backstory: [] },
  });
  const d = of(NWRules.runRules(c), 'timeline-regression');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'error');
  assert.ok(d[0].message.includes('第1天·夜'), '应引用两个锚点的时间，便于作者核对');
});

test('R6 正常推进不报', () => {
  const run = (anchors) => of(NWRules.runRules(ctx({ chapters: [ch(1), ch(2)], timeline: { anchors, backstory: [] } })), 'timeline-regression');
  assert.deepEqual(run([
    { id: 'a', chapter: 'ch-001', label: 'x', at: { day: 1 }, confidence: 'author' },
    { id: 'b', chapter: 'ch-002', label: 'y', at: { day: 2 }, confidence: 'author' },
  ]), [], '跨天前进不该报');
  assert.deepEqual(run([
    { id: 'a', chapter: 'ch-001', label: 'x', at: { day: 3, clock: '晨' }, confidence: 'author' },
    { id: 'b', chapter: 'ch-002', label: 'y', at: { day: 3, clock: '夜' }, confidence: 'author' },
  ]), [], '同日里 晨→夜 是前进，不该报');
});

test('R6 不同 thread 永不互比（多线并行是合法叙事）', () => {
  const c = ctx({
    chapters: [ch(1), ch(2)],
    timeline: { anchors: [
      { id: 'a', chapter: 'ch-001', label: '甲线', at: { day: 9 }, thread: '甲', confidence: 'author' },
      { id: 'b', chapter: 'ch-002', label: '乙线', at: { day: 2 }, thread: '乙', confidence: 'author' },
    ], backstory: [] },
  });
  assert.deepEqual(of(NWRules.runRules(c), 'timeline-regression'), []);
});

test('R6 误报控制：implied 只出 info，闪回章直接跳过', () => {
  const anchors = [
    { id: 'a', chapter: 'ch-001', label: 'x', at: { day: 5, clock: '夜' }, confidence: 'author' },
    { id: 'b', chapter: 'ch-002', label: 'y', at: { day: 5, clock: '晨' }, confidence: 'implied' },
  ];
  const implied = of(NWRules.runRules(ctx({ chapters: [ch(1), ch(2)], timeline: { anchors, backstory: [] } })), 'timeline-regression');
  assert.equal(implied[0].severity, 'info', '推断出的时间不该阻断写作');

  const fb = of(NWRules.runRules(ctx({
    chapters: [ch(1), ch(2, { flags: ['flashback'] })], timeline: { anchors, backstory: [] },
  })), 'timeline-regression');
  assert.deepEqual(fb, []);
});

test('R6 一处回退不该引发后续连锁误报', () => {
  const c = ctx({
    chapters: [ch(1), ch(2), ch(3)],
    timeline: { anchors: [
      { id: 'a', chapter: 'ch-001', label: '第一天', at: { day: 5 }, confidence: 'author' },
      { id: 'b', chapter: 'ch-002', label: '填错了', at: { day: 2 }, confidence: 'author' },
      { id: 'c', chapter: 'ch-003', label: '第六天', at: { day: 6 }, confidence: 'author' },
    ], backstory: [] },
  });
  const d = of(NWRules.runRules(c), 'timeline-regression');
  assert.equal(d.length, 1, '只该报那个填错的锚点');
  assert.equal(d[0].entity, 'b');
});

test('suppressions 命中 fingerprint 后标记 suppressedBy（作者豁免要留痕，不能当没发生）', () => {
  const base = {
    chapters: [ch(1), ch(2, { body: '明长老推门进来。' })],
    characters: [char('char-ming', { name: '明长老', status: 'deceased', 'died-in': 'ch-001' })],
  };
  const fp = 'dead-character-on-stage:ch-002:char-ming';
  const d = NWRules.runRules(ctx(base), { suppressions: { items: [{ fingerprint: fp, reason: '闪回' }] } });
  const hit = of(d, 'dead-character-on-stage')[0];
  assert.equal(hit.suppressedBy, '闪回');
});

test('only / from / to 作用域过滤生效', () => {
  const base = {
    chapters: [ch(1), ch(2, { body: '明长老推门进来。' }), ch(3, { body: '明长老坐下喝茶。' })],
    characters: [char('char-ming', { name: '明长老', status: 'deceased', 'died-in': 'ch-001' })],
  };
  assert.equal(of(NWRules.runRules(ctx(base), { from: 'ch-003' }), 'dead-character-on-stage').length, 1);
  assert.equal(of(NWRules.runRules(ctx(base), { only: ['promise-unpaid'] }), 'dead-character-on-stage').length, 0);
});

test('fingerprint 可复现：同一本书跑两次，诊断集合完全相同', () => {
  const base = ctx({
    chapters: [ch(1), ch(2, { body: '明长老推门进来说了句话。' })],
    characters: [char('char-ming', { name: '明长老', status: 'deceased', 'died-in': 'ch-001' })],
    promises: { items: [{ id: 'p-001', type: 'promise', title: 't', status: 'planted', weight: 'major', setup: { chapter: 'ch-001' }, payoff: { chapter: 'ch-002' } }] },
  });
  const a = NWRules.runRules(base).map((d) => d.fingerprint).sort();
  const b = NWRules.runRules(base).map((d) => d.fingerprint).sort();
  assert.deepEqual(a, b);
  assert.ok(a.length >= 1);
});

test('干净的书不该产出任何 error（否则检查器会被作者关掉）', () => {
  const c = ctx({
    chapters: [
      ch(1, { characters: ['char-lin'], locations: ['wb-1'], body: '林烟火走进青雾山，师父跟在后面。' }),
      ch(2, { characters: ['char-lin'], body: '林烟火说：“山门已破。”' }),
    ],
    characters: [char('char-lin', { name: '林烟火', role: 'protagonist' })],
    world: [{ id: 'wb-1', name: '青雾山', type: 'location', content: '终年大雾', keys: ['青雾山'] }],
    promises: { items: [{ id: 'p-001', type: 'promise', title: '铜印', status: 'paid-off', weight: 'major', setup: { chapter: 'ch-001' }, payoff: { chapter: 'ch-002' } }] },
  });
  const diags = NWRules.runRules(c);
  assert.deepEqual(diags.filter((d) => d.severity === 'error' || d.severity === 'warn'), [], JSON.stringify(diags, null, 2));
});
