import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWRules, NWText, NWTension, NWVolume, NWRelationGraph } from './_load.mjs';

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

// ═══════════════ R20 提前点破 / R21 排期未揭 ═══════════════
// 数据来自信息差账本（secrets 表）。账本没登记时两条规则全线静默 ——
// 机器无法凭空知道哪句话算剧透。

const secret = (over = {}) => ({
  id: 'sec_1', term: '玄冰令', truth: '玄冰令是掌门害死林父的信物',
  first_chapter: null, reveal_chapter: 'ch-005', revealed_at: null,
  informed: [], enabled: true, ...over,
});
const six = (bodies = {}) => [1, 2, 3, 4, 5, 6].map((n) => ch(n, { body: bodies[n] || `第${n}章正文。` }));

test('R20：登记的秘密在揭示章之前就出现 → error，定位到点破的那一章', () => {
  const c = ctx({ chapters: six({ 3: '他认得这枚玄冰令，指尖一抖。' }), secrets: [secret()] });
  const d = of(NWRules.runRules(c), 'premature-reveal');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'error');
  assert.equal(d[0].chapter, 'ch-003');
  assert.equal(d[0].entity, 'sec_1');
  assert.ok(d[0].evidence.quote.includes('玄冰令'));
  assert.ok(d[0].fingerprint.includes('ch-003'));
});

test('R20：按计划揭示 → 不报', () => {
  const c = ctx({ chapters: six({ 5: '她把玄冰令的来历说了出来。' }), secrets: [secret()] });
  assert.deepEqual(of(NWRules.runRules(c), 'premature-reveal'), []);
});

test('R20：账本为空或正文没出现该 term → 不报（没登记就没有这条）', () => {
  assert.deepEqual(of(NWRules.runRules(ctx({ chapters: six() })), 'premature-reveal'), []);
  assert.deepEqual(of(NWRules.runRules(ctx({ chapters: six(), secrets: [secret()] })), 'premature-reveal'), []);
});

test('R20：enabled:false 的登记不参与检查', () => {
  const c = ctx({ chapters: six({ 3: '这枚玄冰令他见过。' }), secrets: [secret({ enabled: false })] });
  assert.deepEqual(of(NWRules.runRules(c), 'premature-reveal'), []);
});

test('R20：登记了 first_chapter（铺垫起点）→ 降为 info 而不是 error', () => {
  const c = ctx({ chapters: six({ 3: '这枚玄冰令他见过。' }), secrets: [secret({ first_chapter: 'ch-002' })] });
  const d = of(NWRules.runRules(c), 'premature-reveal');
  assert.equal(d[0].severity, 'info');
  // 命中章早于铺垫起点时仍然是 error
  const earlier = of(NWRules.runRules(ctx({
    chapters: six({ 1: '袖中露出一角玄冰令。' }), secrets: [secret({ first_chapter: 'ch-002' })],
  })), 'premature-reveal');
  assert.equal(earlier[0].severity, 'error');
});

test('R20：flashback / dream / quoted 章的命中豁免，与 R1 同一套标记', () => {
  const c = ctx({
    chapters: [1, 2, 3, 4, 5, 6].map((n) => ch(n, {
      body: n === 3 ? '当年，师父把玄冰令交给了他。' : `第${n}章正文。`,
      flags: n === 3 ? ['flashback'] : [],
    })),
    secrets: [secret()],
  });
  assert.deepEqual(of(NWRules.runRules(c), 'premature-reveal'), []);
});

test('R20：基线取 revealed_at（已回填的实际揭示章）', () => {
  const c = ctx({
    chapters: six({ 2: '玄冰令的事他早有耳闻。', 4: '她把玄冰令的来历说了出来。' }),
    secrets: [secret({ revealed_at: 'ch-004' })],
  });
  const d = of(NWRules.runRules(c), 'premature-reveal');
  assert.equal(d[0].chapter, 'ch-002');
  assert.ok(d[0].evidence.basis.join().includes('revealed') || d[0].evidence.basis.join().includes('ch-004'));
});

test('R20：既无排期也无回填、但正文已出现 → warn 催登记，不断言剧透', () => {
  const c = ctx({ chapters: six({ 2: '玄冰令就在他怀里。' }), secrets: [secret({ reveal_chapter: null })] });
  const d = of(NWRules.runRules(c), 'premature-reveal');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'warn');
  assert.ok(d[0].suggestion.includes('reveal_chapter'));
});

test('R20：揭示章 id 指向不存在的章 → 跳过（错引由 R15 负责，不重复报）', () => {
  const c = ctx({ chapters: six({ 3: '玄冰令就在桌上。' }), secrets: [secret({ reveal_chapter: 'ch-999' })] });
  assert.deepEqual(of(NWRules.runRules(c), 'premature-reveal'), []);
});

test('R21：排期已过、正文从未出现 → warn', () => {
  const c = ctx({ chapters: six(), secrets: [secret({ reveal_chapter: 'ch-002' })] });
  const d = of(NWRules.runRules(c), 'unresolved-secret');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'warn');
  assert.equal(d[0].entity, 'sec_1');
  assert.equal(d[0].chapter, null, '书级诊断不该定位到某一章');
  assert.equal(d[0].fingerprint, 'unresolved-secret:-:sec_1');
});

test('R21：尚未到期、已回填、正文已出现 → 三种情况都不报', () => {
  const sixBodies = six();
  const notDue = ctx({ chapters: sixBodies, secrets: [secret({ reveal_chapter: 'ch-006' })] });
  assert.deepEqual(of(NWRules.runRules(notDue), 'unresolved-secret'), []);
  const backfilled = ctx({
    chapters: six({ 2: '她把玄冰令的来历说了出来。' }),
    secrets: [secret({ reveal_chapter: 'ch-002', revealed_at: 'ch-002' })],
  });
  assert.deepEqual(of(NWRules.runRules(backfilled), 'unresolved-secret'), []);
  // 排期章之后才出现：账本没回填，但信息确实揭了 —— 归 R20/作者补记，不该由 R21 喊"从未出现"
  const appeared = ctx({
    chapters: six({ 4: '她把玄冰令的来历说了出来。' }),
    secrets: [secret({ reveal_chapter: 'ch-002' })],
  });
  assert.deepEqual(of(NWRules.runRules(appeared), 'unresolved-secret'), []);
});

test('R21：enabled:false 与缺 term 的行不参与检查', () => {
  const c = ctx({ chapters: six(), secrets: [secret({ reveal_chapter: 'ch-002', enabled: false }), secret({ id: 'sec_2', term: '  ', reveal_chapter: 'ch-002' })] });
  assert.deepEqual(of(NWRules.runRules(c), 'unresolved-secret'), []);
});

// ═══════════════════ R22 去 AI 味（规则包见 src/core/stylepack.js） ═══════════════════
// 这三段文本是校准用的样本，改动前请先跑 tests/stylepack.test.mjs：
// plainBlock 是刻意写干净的人话（729 字，禁词 0、句式 0），aiLine 是典型 AI 腔。
const PLAIN = [
  '师父把匣子推到桌心，火漆上还留着几道很新的划痕。他说这东西原本有半枚，另半枚随葬在山上，谁也取不回来了。',
  '林烟火没有立刻接。她盯着那道火漆看了很久，久到廊下的影子从第三步挪到第五步，才伸手把匣子接过来压在掌心。',
  '「拿着。」他说完就转过身去，手在袖子里握了握，把那二十年一并递了过来。',
  '匣底的铜印断口很新。她用指腹擦过那道缺口，碎屑落在袖口上，像一小片没有烧尽的雪，落在地上就找不着了。',
  '她在阶前站住，回头看了一眼亮着灯的那间屋子，屋里的人已经睡下，灯是她进门之前就被谁点上的。',
  '「为什么不打开？」她问了一句，声音落在石阶上，没有回音，夜风把它送进林子里去了。',
];
const plain = (times = 3) => PLAIN.join('\n\n').repeat(times);
const AI_LINE = '他仿佛望出去，那一刻只觉得十分疲惫，又格外冷清。';
const SIMILE_LINE = '他仿佛望出去，夜里的山门比白日更静，灯火一盏一盏往后退去，退到石阶下面看不见的地方。';

test('R22：AI 腔长章 → warn，证据里带密度与高频词', () => {
  const c = ctx({ chapters: [ch(1, { body: AI_LINE.repeat(30) })] });
  const d = of(NWRules.runRules(c), 'ai-flavor');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'warn');
  assert.equal(d[0].chapter, 'ch-001');
  assert.equal(d[0].fingerprint, 'ai-flavor:ch-001:-');
  assert.ok(d[0].evidence.basis.join('）').includes('禁词密度'), d[0].evidence.basis.join(' / '));
  assert.ok(d[0].evidence.basis.some((b) => b.includes('仿佛×')), '高频命中清单没带出来');
  assert.ok(d[0].evidence.quote.includes('仿佛'), '引证要指到踩词的那一句');
});

test('R22：干净长章不报（这条是整套阈值的下界，阈值一放宽就会红）', () => {
  const c = ctx({ chapters: [ch(1, { body: plain() })] });
  assert.deepEqual(of(NWRules.runRules(c), 'ai-flavor'), []);
});

test('R22：只踩密度是 info，不升 warn', () => {
  const body = plain() + '\n\n' + SIMILE_LINE + '\n\n' + SIMILE_LINE;
  const c = ctx({ chapters: [ch(1, { body })] });
  const d = of(NWRules.runRules(c), 'ai-flavor');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'info');
});

test('R22：不足 500 字的章节不评', () => {
  const c = ctx({ chapters: [ch(1, { body: AI_LINE.repeat(6) }), ch(2, { body: '' })] });
  assert.deepEqual(of(NWRules.runRules(c), 'ai-flavor'), []);
});

test('R22：本书 stylePack 关掉那组，就不再用它计分', () => {
  const body = plain(4) + '\n\n' + SIMILE_LINE.repeat(24);
  const on = ctx({ chapters: [ch(1, { body })] });
  const off = ctx({
    book: { id: 'novel_t', title: '测试书', genre: '玄幻', stylePack: { disabled: ['simile'] } },
    chapters: [ch(1, { body })],
  });
  const warned = of(NWRules.runRules(on), 'ai-flavor');
  const after = of(NWRules.runRules(off), 'ai-flavor');
  assert.equal(warned[0].severity, 'warn');
  assert.equal(after[0].severity, 'info', '关掉比喻组后仍该由句式给出 info，而不是整条消失');
});

test('R22：自定义禁词进得了本书的账', () => {
  const custom = [
    '他祭出紫气东来，掌风压得阶前碎石纷纷后退，退成一道窄窄的缝。',
    '紫气东来这个名字是师父取的，说来也俗，可当年凭这一口剑，山中无人应战。',
    '她把紫气东来横在膝上，一夜没有拔鞘，天亮才起身去敲师兄的房门。',
  ].join('\n\n').repeat(6);
  const body = plain() + '\n\n' + custom;
  const bare = ctx({ chapters: [ch(1, { body })] });
  const withCustom = ctx({
    book: { id: 'novel_t', title: '测试书', genre: '玄幻', stylePack: { extraBanned: ['紫气东来'] } },
    chapters: [ch(1, { body })],
  });
  assert.deepEqual(of(NWRules.runRules(bare), 'ai-flavor'), [], '没登记的词不该凭空报');
  const d = of(NWRules.runRules(withCustom), 'ai-flavor');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'warn');
  assert.ok(d[0].evidence.basis.some((b) => b.includes('紫气东来×')), d[0].evidence.basis.join(' / '));
});

test('R22：suppressions 按指纹豁免本章', () => {
  const c = ctx({ chapters: [ch(1, { body: AI_LINE.repeat(30) })] });
  const fp = 'ai-flavor:ch-001:-';
  const run = NWRules.runRules(c, { suppressions: { items: [{ fingerprint: fp, reason: '本书刻意用这种腔调' }] } });
  const d = of(run, 'ai-flavor')[0];
  assert.equal(d.suppressedBy, '本书刻意用这种腔调');
});

// ═════════════════ R26 整句重复 ═════════════════
// 模型续写最典型的两种毛病都在这里：改写时没删掉旧句（同章两遍），
// 以及拿原句复述上一章来「承接」（跨章一字不差）。判据是逐字比对，不做主观评价。

const SENT_A = '他沿着石阶往上走，雾贴着脚背流动，山门还在很远的地方。';
const SENT_B = '林中的光线一寸一寸暗下去，风从谷口灌进来，吹得衣袍猎猎作响。';
const SENT_C = '他停下脚步回头看去，来路已经被雾填满，看不出是第几道弯。';

test('R26 同一章里整句重复两遍 → warn，证据指向第二处', () => {
  const body = `${SENT_A}\n\n${SENT_B}\n\n${SENT_A}`;
  const d = of(NWRules.runRules(ctx({ chapters: [ch(1, { body })] })), 'repeated-sentence');
  assert.equal(d.length, 1, '一句重复只报一条');
  assert.equal(d[0].severity, 'warn');
  assert.equal(d[0].chapter, 'ch-001');
  assert.ok(d[0].evidence.basis[0].includes('2 次'), d[0].evidence.basis.join(' / '));
  const [from, to] = d[0].evidence.offset;
  assert.equal(from, body.indexOf(SENT_A, 1), 'offset 应落在第二处句首');
  const sent = SENT_A.replace(/。$/, '');   // 句切分不含 terminator，证据长度按这一句本身算
  assert.equal(to - from, sent.length);
  assert.equal(body.slice(from, to), sent);
});

test('R26 跨章一字不差地复述 → info，且落在后一章上（--from/--to 才筛得到）', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: `${SENT_A}\n\n${SENT_B}` }), ch(2, { body: `${SENT_C}\n\n${SENT_A}` })],
  })), 'repeated-sentence');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'info', '跨章复述不该触发同章那种改写');
  assert.equal(d[0].chapter, 'ch-002');
  assert.ok(d[0].message.includes('第 1 章') && d[0].message.includes('第 2 章'), d[0].message);
});

test('R26 同一句在三章以上重复：只报一条，并说它像固定用语', () => {
  const d = of(NWRules.runRules(ctx({ chapters: [
    ch(1, { body: SENT_A }), ch(2, { body: `${SENT_B}\n\n${SENT_A}` }), ch(3, { body: `${SENT_C}\n\n${SENT_A}` }),
  ] })), 'repeated-sentence');
  assert.equal(d.length, 1);
  assert.ok(d[0].evidence.basis.some((b) => b.includes('共 3 章')), d[0].evidence.basis.join(' / '));
});

test('R26 台词重复不算：对白里的整句一律不参与比对', () => {
  const spoken = SENT_A.slice(0, -1);
  const d = of(NWRules.runRules(ctx({ chapters: [
    ch(1, { body: `“${spoken}”\n\n${SENT_B}` }), ch(2, { body: `“${spoken}”\n\n${SENT_C}` }),
  ] })), 'repeated-sentence');
  assert.deepEqual(d, [], '复沓式台词是有意为之，机器分不开就别报');
  // 切分器不认引号：这句会被切成「他说：“……」+「”」，前一段是带说话人前缀的，
  // 所以判据只能是"含开引号"，不是"以引号开头"。
  const said = of(NWRules.runRules(ctx({ chapters: [
    ch(1, { body: `他说：“${spoken}”\n\n${SENT_B}` }), ch(2, { body: `她说：“${spoken}”\n\n${SENT_C}` }),
  ] })), 'repeated-sentence');
  assert.deepEqual(said, [], '带说话人前缀的台词同样是台词');
});

test('R26 回忆章整章不参与（旧场景本来就该重演）', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_A }), ch(2, { body: SENT_A, flags: ['flashback'] })],
  })), 'repeated-sentence');
  assert.deepEqual(d, []);
});

test('R26 比对忽略标点与空白：改了标点没改字仍然算重复', () => {
  const d = of(NWRules.runRules(ctx({ chapters: [
    ch(1, { body: '他沿着石阶往上走雾贴着脚背流动山门还在很远的地方' }), ch(2, { body: SENT_A }),
  ] })), 'repeated-sentence');
  assert.equal(d.length, 1);
  assert.ok(d[0].evidence.quote.includes('他沿着石阶'), d[0].evidence.quote);
});

test('R26 短句不参与：称呼与常见四字格重复不是毛病', () => {
  const d = of(NWRules.runRules(ctx({ chapters: [
    ch(1, { body: '他来了。\n\n他来了。' }), ch(2, { body: '他来了。\n\n他来了。' }),
  ] })), 'repeated-sentence');
  assert.deepEqual(d, []);
});

// ═════════════════ R27 依据回查 ═════════════════

const prom = (over = {}) => ({
  id: 'p-1', type: 'promise', title: '半枚铜印', status: 'planted', weight: 'minor',
  setup: { chapter: 'ch-001', evidence: SENT_A }, payoff: { chapter: null, evidence: '' },
  characters: [], notes: '', ...over,
});

test('R27 依据就在标的那一章 → 不报', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: `${SENT_A}\n\n${SENT_B}` }), ch(2)], promises: { items: [prom()] },
  })), 'evidence-mismatch');
  assert.deepEqual(d, []);
});

test('R27 依据其实在别的章：报「章标错了」，并把作者送到那一章', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_B }), ch(2, { body: SENT_A })], promises: { items: [prom()] },
  })), 'evidence-mismatch');
  assert.equal(d.length, 1);
  assert.equal(d[0].chapter, 'ch-002');
  assert.equal(d[0].severity, 'info');
  assert.ok(d[0].message.includes('不在第 1 章') && d[0].message.includes('第 2 章里找得到'), d[0].message);
});

test('R27 全书都找不到：落在埋设章上，说清可能是改写冲掉了依据', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_B }), ch(2, { body: SENT_C })], promises: { items: [prom()] },
  })), 'evidence-mismatch');
  assert.equal(d.length, 1);
  assert.equal(d[0].chapter, 'ch-001');
  assert.ok(d[0].suggestion.includes('R3'), d[0].suggestion);
});

test('R27 不查这些：依据太短、那一章还没写正文、登记已作废', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_B }), ch(2), ch(3, { body: SENT_C })],
    promises: { items: [
      prom({ id: 'short', setup: { chapter: 'ch-001', evidence: '半枚铜印' } }),
      prom({ id: 'unwritten', setup: { chapter: 'ch-002', evidence: SENT_A } }),
      prom({ id: 'void', status: 'cancelled', setup: { chapter: 'ch-001', evidence: SENT_A } }),
    ] },
  })), 'evidence-mismatch');
  assert.deepEqual(d.map((x) => x.entity), [], d.map((x) => x.message).join(' / '));
});

test('R26/R27/R28 遇到边界输入不许崩：崩了只剩一条 rule-crashed，其余诊断全丢', () => {
  const c = ctx({
    chapters: [ch(1, { body: SENT_B }), ch(2), ch(3, { body: SENT_C }), ch(4, { body: SENT_A })],
    promises: { items: [
      prom({ id: 'ghost', setup: { chapter: 'ch-999', evidence: SENT_A } }),
      prom({ id: 'nochapter', setup: { chapter: null, evidence: SENT_A } }),
      prom({ id: 'noev', setup: { chapter: 'ch-001', evidence: '' } }),
      prom({ id: 'q', type: 'question', setup: { chapter: 'ch-001', evidence: SENT_C } }),
    ] },
    world: [
      wb({ lifecycle: { 'destroyed-in': 'ch-999' } }),
      wb({ id: 'wb-null', lifecycle: { 'destroyed-in': null } }),
      wb({ id: 'wb-nokey', name: '山', keys: [] }),
      wb({ id: 'wb-off', enabled: false, lifecycle: { 'destroyed-in': 'ch-001' } }),
    ],
  });
  const all = NWRules.runRules(c);
  assert.deepEqual(all.filter((d) => d.rule === 'rule-crashed'), [],
    all.filter((d) => d.rule === 'rule-crashed').map((d) => d.message).join(' / '));
  // 关掉的、名字太短的、销毁章是幽灵章的，都不该报
  assert.deepEqual(of(all, 'world-destroyed-after').map((d) => d.entity), []);
});

test('R27 只有 payoff 回填了依据 → 不去当埋设依据查', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_B }), ch(2, { body: SENT_C })],
    promises: { items: [prom({ setup: { chapter: 'ch-001', evidence: '' }, payoff: { chapter: 'ch-002', evidence: SENT_A } })] },
  })), 'evidence-mismatch');
  assert.deepEqual(d, []);
});

// ═════════════════ R28 世界设定生命周期 ═════════════════

const wb = (over = {}) => ({
  id: 'wb-1', name: '青冥山', type: 'location', keys: ['青冥山'], enabled: true,
  lifecycle: { 'destroyed-in': 'ch-001', 'revealed-in': null }, ...over,
});

test('R28 登记毁灭之后正文还原样点名 → info，offset 指到那一处', () => {
  // 两个称呼都在同一章出现，且**别名在前**：offset 必须指到全书最早撞见的那一个，不是列表里第一个
  const body = '路过时听人说起，那座山曾经很高；他在青冥山的废墟前站住。';
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_A }), ch(2, { body })], world: [wb({ keys: ['青冥山', '那座山'] })],
  })), 'world-destroyed-after');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'info', '写废墟与忘了它已毁掉机器分不开，所以不给 warn');
  assert.equal(d[0].chapter, 'ch-002');
  assert.equal(body.slice(d[0].evidence.offset[0], d[0].evidence.offset[1]), '那座山',
    d[0].evidence.basis.join(' / '));
});

test('R28 销毁章本身与它之前的正文不报', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '青冥山在这一剑之下塌了。' }), ch(2, { body: SENT_A })], world: [wb()],
  })), 'world-destroyed-after');
  assert.deepEqual(d, []);
});

test('R28 回忆/引文标记章跳过；一条设定只在最早撞见的那一章报一次', () => {
  const flashback = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_A }), ch(2, { body: '他想起青冥山的雪。', flags: ['flashback'] })], world: [wb()],
  })), 'world-destroyed-after');
  assert.deepEqual(flashback, []);
  const many = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_A }), ch(2, { body: '青冥山的风很大。' }), ch(3, { body: '青冥山的雪很冷。' })], world: [wb()],
  })), 'world-destroyed-after');
  assert.equal(many.length, 1);
  assert.equal(many[0].chapter, 'ch-002');
});

test('R28 没登记 lifecycle 的书整条静默（零登记 ≠ 一堆问题）', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_A }), ch(2, { body: '青冥山的雪落了一夜。' })],
    world: [wb({ lifecycle: {} }), wb({ id: 'wb-2', lifecycle: { 'destroyed-in': 'ch-999' } })],
  })), 'world-destroyed-after');
  assert.deepEqual(d, [], '没写销毁章、或销毁章 id 不存在（那是 R15 的活）都不该报');
  const off = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_A }), ch(2, { body: '他在青冥山的废墟前站住。' })],
    world: [wb({ enabled: false })],
  })), 'world-destroyed-after');
  assert.deepEqual(off, [], '作者关掉的设定不再参与检查，与 R22／信息差那几条同口径');
});

test('R28 单字称呼不参与比对，别名（keys）参与', () => {
  const short = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_A }), ch(2, { body: '山上的雪很冷。' })], world: [wb({ keys: ['山'] })],
  })), 'world-destroyed-after');
  assert.deepEqual(short, []);
  const alias = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: SENT_A }), ch(2, { body: '东宗已经没了。' })],
    world: [wb({ name: '青冥山', keys: ['青冥山', '东宗'] })],
  })), 'world-destroyed-after');
  assert.equal(alias.length, 1);
  assert.ok(alias[0].evidence.basis[0].includes('东宗'), alias[0].evidence.basis.join(' / '));
});

test('R26/R27/R28 都不产出 error，指纹各占一位（豁免不会连带关掉另一条）', () => {
  const c = ctx({
    chapters: [
      ch(1, { body: `${SENT_A}\n\n${SENT_A}` }),
      ch(2, { body: `${SENT_A}\n\n他在青冥山的废墟前站住。` }),
    ],
    world: [wb()], promises: { items: [prom({ setup: { chapter: 'ch-001', evidence: SENT_C } })] },
  });
  const picked = (x) => NWRules.runRules(x)
    .filter((d) => ['repeated-sentence', 'evidence-mismatch', 'world-destroyed-after'].includes(d.rule));
  const d = picked(c);
  assert.equal(d.length, 3, d.map((x) => `${x.rule}@${x.chapter}`).join(' / '));
  assert.ok(d.every((x) => x.severity !== 'error'), '这批只做提示，不做门禁');
  assert.ok(d.every((x) => x.source === 'machine' && x.confidence > 0 && x.confidence <= 1));
  const fps = d.map((x) => x.fingerprint);
  assert.deepEqual(fps, [...new Set(fps)], `指纹必须互不相同：${fps.join(' / ')}`);
  const sameChapter = d.filter((x) => x.chapter === 'ch-002');
  assert.equal(new Set(sameChapter.map((x) => x.fingerprint)).size, sameChapter.length);
  assert.deepEqual(picked(c).map((x) => x.fingerprint), fps, '同一输入两次跑，指纹必须一模一样');
});

// ─────────────── L 族：账本登记了、正文从没配合（R29/R30/R31）───────────────

const rel = (over = {}) => ({ id: 'rel-1', from: 'char-lin', to: 'char-ming', kind: '师徒', address: '', ...over });

test('R29 first 写早了：登记那一章没点到名，正文里更后面才露面', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '他挑着水桶上了井台。' }), ch(2, { body: '井绳冻得硬邦邦。' }),
      ch(3, { body: '他数着石阶。' }), ch(4, { body: '林烟火终于下山了。' })],
    characters: [char('char-lin', { name: '林烟火', first: 'ch-002' })],
  })), 'first-appearance-mismatch');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'info');
  assert.equal(d[0].chapter, 'ch-002', '要把作者送到他登记错的那一章');
  assert.ok(d[0].message.includes('最早露面是在第 4 章'), d[0].message);
  assert.equal(d[0].evidence.suggestFirst, null,
    '「写早了」那一支不许给出可写回的章：照着改等于把「那一章根本没点名」这件事抹平');
});

test('R29 first 写晚了：第 2 章就露面、卡上却写第 4 章 → 落在实际那一章，offset 指到称呼', () => {
  const body = '林烟火把药布递过去。';
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '鸡叫头遍。' }), ch(2, { body }), ch(3, { body: '火起三千阶。' }), ch(4, { body: '他站在门口。' })],
    characters: [char('char-lin', { name: '林烟火', first: 'ch-004' })],
  })), 'first-appearance-mismatch');
  assert.equal(d.length, 1);
  assert.equal(d[0].chapter, 'ch-002');
  assert.equal(body.slice(d[0].evidence.offset[0], d[0].evidence.offset[1]), '林烟火');
  assert.ok(d[0].message.includes('正文里他早在第 2 章就露面'), d[0].message);
  assert.equal(d[0].evidence.suggestFirst, 'ch-002', '界面上的「照正文改」写的就是这一格');
});

test('R29 对得上就不报，且不许靠崩来对得上', () => {
  const all = NWRules.runRules(ctx({
    chapters: [ch(1, { body: '井台。' }), ch(2, { body: '火。' }), ch(3, { body: '林烟火下山。' })],
    characters: [char('char-lin', { name: '林烟火', first: 'ch-003' })],
  }));
  assert.deepEqual(of(all, 'first-appearance-mismatch'), []);
  assert.deepEqual(all.filter((x) => x.rule === 'rule-crashed'), [], '抛错会让整条规则静默消失');
});

test('R29 回忆章里的称呼不算露面（旧场景重演说明不了出场次序）', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '井台。' }), ch(2, { body: '林烟火三岁时上了山。', flags: ['flashback'] }),
      ch(3, { body: '别的谁。' }), ch(4, { body: '林烟火推开门。' })],
    characters: [char('char-lin', { name: '林烟火', first: 'ch-004' })],
  })), 'first-appearance-mismatch');
  assert.deepEqual(d, [], '第 4 章才是第一次「现在时」出场，卡上填对了');
});

test('R29 不查这些：没填 first、章不存在、只有单字称呼、卡已关掉', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '井台。' }), ch(2, { body: '火。' }), ch(3, { body: '林烟火下山。' })],
    characters: [
      char('char-none', { name: '秦叔', aliases: [] }),
      char('char-ghost', { name: '苏晚', first: 'ch-999' }),
      char('char-one', { name: '山', first: 'ch-001' }),
      char('char-off', { name: '明长老', first: 'ch-001', enabled: false }),
    ],
  })), 'first-appearance-mismatch');
  assert.deepEqual(d.map((x) => x.entity), [], d.map((x) => x.message).join(' / '));
});

test('R29 全书没露面的角色不在这里报（那是 R30 的活，免得一件事说两遍）', () => {
  const c = ctx({
    chapters: [ch(1, { body: '井台。' }), ch(2, { body: '火。' }), ch(3, { body: '他挑水。' })],
    characters: [char('char-lin', { name: '林烟火', first: 'ch-002' })],
  });
  const all = NWRules.runRules(c);
  assert.deepEqual(of(all, 'first-appearance-mismatch'), []);
  assert.deepEqual(all.filter((x) => x.rule === 'rule-crashed'), [],
    '不许靠抛错来"不报"：崩了整条规则对这本书就永久失明');
  assert.equal(of(all, 'entry-never-mentioned').length, 1);
});

test('R30 角色建了档、三章正文里一个称呼都没出现 → info，且不指向任何一章', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '井台。' }), ch(2, { body: '苏晚来了。' }), ch(3, { body: '他挑水。' })],
    characters: [
      char('char-ghost', { name: '无名者', aliases: [{ text: '那个外乡人' }] }),
      char('char-seen', { name: '苏晚' }),
    ],
  })), 'entry-never-mentioned');
  assert.deepEqual(d.map((x) => x.entity), ['char-ghost'], '露过面的角色必须被 seen 挡掉');
  assert.equal(d[0].chapter, null, '没有哪一章可跳，指向某一章反而误导');
  assert.equal(d[0].severity, 'info');
  assert.ok(d[0].evidence.basis.join('、').includes('那个外乡人'), d[0].evidence.basis.join(' / '));
});

test('R30 世界条目同理：keys 或 secondary_keys 里任一称呼被写到就不报', () => {
  const run = (body3) => of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '井台。' }), ch(2, { body: '火。' }), ch(3, { body: body3 })],
    world: [{ id: 'wb-1', name: '青冥山', keys: ['青冥'], secondary_keys: ['北宗'], enabled: true }],
  })), 'entry-never-mentioned');
  assert.deepEqual(run('他去了别处。').map((x) => x.entity), ['wb-1']);
  assert.deepEqual(run('北宗的人来了。'), [], 'secondary_keys 也是正文里的称呼');
});

test('R28 与 R30 用的是同一把尺：只被副键点名的设定，一条不报、另一条必报', () => {
  // 「北宗」只在 secondary_keys 里。R30 认副键 → 它算露过面，不报僵尸卡；
  // R28 也认副键 → 它毁于第 1 章、第 3 章又拿副键点名，必须报。
  // 两边都改成「只认 keys」的话，这条测试的两半不会同时坏 —— 所以必须同时断言两条规则。
  const c = ctx({
    chapters: [ch(1, { body: '北宗在这一剑之下没了。' }), ch(2, { body: '井台。' }), ch(3, { body: '北宗的人来了。' })],
    world: [{ id: 'wb-1', name: '青冥山', keys: ['青冥山'], secondary_keys: ['北宗'], enabled: true,
      lifecycle: { 'destroyed-in': 'ch-001', 'revealed-in': null } }],
  });
  const all = NWRules.runRules(c);
  assert.deepEqual(of(all, 'entry-never-mentioned').map((x) => x.entity), [],
    '副键被点过名就不算僵尸卡');
  const dead = of(all, 'world-destroyed-after');
  assert.equal(dead.length, 1, '同一个称呼在毁灭之后出现，R28 不许因为它是副键就当没看见');
  assert.equal(dead[0].chapter, 'ch-003');
  assert.ok(dead[0].evidence.basis[0].includes('北宗'), dead[0].evidence.basis.join(' / '));
});

test('R30 已写正文不足 3 章整条静默（新书期卡片先建、正文后写）', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '井台。' }), ch(2, { body: '火。' }), ch(3, { body: '' })],
    characters: [char('char-ghost', { name: '无名者' })],
  })), 'entry-never-mentioned');
  assert.deepEqual(d, []);
});

test('R30 误报控制：关掉的卡不查、单字称呼不查、回忆章里点过名就算露面', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '井台。' }), ch(2, { body: '火。' }),
      ch(3, { body: '他想起旧人。', flags: ['flashback'] })],
    characters: [
      char('char-off', { name: '已废弃', enabled: false }),
      char('char-one', { name: '山' }),
      char('char-past', { name: '明长老', aliases: ['明长老'] }),
    ],
    world: [{ id: 'wb-past', name: '青冥山', keys: ['青冥山'], enabled: true }],
  })), 'entry-never-mentioned');
  // 明长老与青冥山在第 3 章（回忆章）都没被点名，所以仍该报 —— 关键是别报「已废弃」和单字的「山」
  assert.deepEqual(d.map((x) => x.entity).sort(), ['char-past', 'wb-past'], d.map((x) => x.entity).join(' / '));
});

test('R31 登记的边两端各自露面，却从未同章出现', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '林烟火挑水。' }), ch(2, { body: '明长老咳了两声。' }), ch(3, { body: '火起了。' })],
    characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
    relations: { edges: [rel()] },
  })), 'relation-pair-never-together');
  assert.equal(d.length, 1);
  assert.equal(d[0].entity, 'rel-1');
  assert.equal(d[0].severity, 'info');
  assert.ok(d[0].message.includes('师徒'), d[0].message);
  assert.ok(d[0].evidence.basis.join('、').includes('两人同框 0 章'), d[0].evidence.basis.join(' / '));
});

test('R31 同过框就闭嘴 —— 回忆章里同框也算同框', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '林烟火挑水。' }),
      ch(2, { body: '明长老牵着小林烟火。', flags: ['flashback'] }), ch(3, { body: '火起了。' })],
    characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
    relations: { edges: [rel()] },
  })), 'relation-pair-never-together');
  assert.deepEqual(d, []);
});

test('R31 不查这些：有一端从未露面（那是 R30）、角色 id 解析不到（R15）、自环边、没有关系的书', () => {
  const two = (edges, chars) => of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '林烟火挑水。' }), ch(2, { body: '他咳了两声。' }), ch(3, { body: '火起了。' })],
    characters: chars, relations: { edges },
  })), 'relation-pair-never-together');
  const lin = [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })];
  assert.deepEqual(two([rel()], lin).map((x) => x.entity), [], '明长老从未露面，交给 R30');
  assert.deepEqual(two([rel({ to: 'char-ghost' })], lin), [], '边指向没建档的角色');
  assert.deepEqual(two([rel({ to: 'char-lin' })], lin), [], '自环边不是关系');
  assert.deepEqual(of(NWRules.runRules(ctx({ chapters: [ch(1, { body: '林烟火挑水。' })] })),
    'relation-pair-never-together'), [], '没有 relations 的老书必须整条静默');
});

// 「让给 R15」这句话得有守卫：从前删掉那句 continue 什么红都没有 —— 端点解析不到时它会抛，
// 而抛错被引擎收成一条 rule-crashed，R31 这一整条规则连同其余边的检查一起静默消失。
test('R31 让给 R15 的那些边是跳过，不是抛：崩一次等于全书的关系边都不查了', () => {
  const all = NWRules.runRules(ctx({
    chapters: [ch(1, { body: '林烟火挑水。' }), ch(2, { body: '他咳了两声。' })],
    characters: [char('char-lin', { name: '林烟火' })],
    relations: { edges: [rel({ to: 'char-ghost' }), rel({ id: 'rel-2', from: 'char-ghost', to: 'char-ming' })] },
  }));
  assert.deepEqual(all.filter((x) => x.rule === 'rule-crashed').map((x) => x.message), [],
    '解析不到的端点必须被跳过，而不是把整条规则崩掉');
});

test('R29/R30/R31 遇到边界输入不许崩，且都不产出 error', () => {
  const c = ctx({
    chapters: [ch(1, { body: '井台。' }), ch(2, { body: '火。' }), ch(3, { body: '林烟火与明长老同框。' })],
    characters: [
      char('char-lin', { name: '林烟火', first: 'ch-001' }),
      char('char-ming', { name: '明长老', first: 'ch-009' }),
      char('char-empty', { name: '', aliases: [null, 12, '好'] }),
    ],
    world: [{ id: 'wb-x', name: '', keys: [null, '夜袭'], enabled: true }, { id: 'wb-y' }],
    relations: { edges: [rel({ id: 'rel-a' }), rel({ id: 'rel-b', from: null, to: undefined }), null, {}] },
  });
  const all = NWRules.runRules(c);
  assert.deepEqual(all.filter((x) => x.rule === 'rule-crashed'), [],
    all.filter((x) => x.rule === 'rule-crashed').map((x) => x.message).join(' / '));
  const picked = all.filter((x) => ['first-appearance-mismatch', 'entry-never-mentioned', 'relation-pair-never-together'].includes(x.rule));
  assert.ok(picked.every((x) => x.severity === 'info'), '这批只做提示，不做门禁');
  assert.deepEqual(picked.map((x) => x.fingerprint), [...new Set(picked.map((x) => x.fingerprint))],
    picked.map((x) => x.fingerprint).join(' / '));
});

// ═══════════════════ R32 style-drift（文风基准偏离）═══════════════════
//
// 夹具给的是「整章」不是一句话：指纹按字数加权，同一支单位重复几十遍就是一章 600 字以上的正文。
// 四支笔法各自卡在不同数量的格上，整组测试才有意义：
//   A（基准）长句、无对话、段均一句、零禁词
//   B 短句加对话 —— 句均/对话/段均三格一起越界
//   C 只加禁词 —— 只越一格，按判据不许报
//   F 短句加禁词 —— 越两格（正好过线），禁词那一格一消失就退回一格
const A_BASE = '他沿着石阶往上走，雾贴着脚背流动，山门还在很远的地方，钟声从崖下传上来一声隔着一声。';
const B_DIALOG = '“你来晚了。”他低声说。\n“我知道。”她没有回头。';
const C_CLICHE = '他沿着石阶往上走，雾贴着脚背流动，山门还在很远的地方，钟声传来，仿佛很静，一声隔着一声。';
const F_SHORT = '他沿着石阶往上走，雾贴着脚背流动，仿佛山门还在很远的地方。';
const rep = (n, unit) => Array.from({ length: n }, () => unit).join('\n\n');
const BODY_A = rep(24, A_BASE), BODY_B = rep(40, B_DIALOG), BODY_C = rep(24, C_CLICHE), BODY_F = rep(24, F_SHORT);
/** 基准永远勾前两章：这两章同文，基准指纹就是 BODY_A 本身（912 字 × 2）。 */
const bookFit = (over = {}) => ({ id: 'novel_t', title: '测试书', genre: '玄幻',
  styleAnchor: { chapterIds: ['ch-001', 'ch-002'] }, ...over });
const fitChapters = (thirdBody, thirdOver = {}) => [
  ch(1, { body: BODY_A }), ch(2, { body: BODY_A }), ch(3, { body: thirdBody, ...thirdOver }),
];

test('R32 文风漂移：两格以上同时越界才报，报出来的是实测数字不是形容词', () => {
  const d = of(NWRules.runRules(ctx({ book: bookFit(), chapters: fitChapters(BODY_B) })), 'style-drift');
  assert.equal(d.length, 1);
  assert.equal(d[0].chapter, 'ch-003');
  assert.equal(d[0].severity, 'info', '文体永远是建议，任何一格都不许把它升成 error');
  assert.equal(d[0].confidence, 0.6, '这条是统计数字，置信度就固定在「拿不准」那一档');
  assert.equal(NWRules.RULES['style-drift'].defaultSeverity, 'info',
    '规格上声明的档位与实际发出来的是两回事，两边都要钉住');
  // 数字是夹具算出来的，写死在这里是有意的：它同时钉住「话术里真带实测值」和「基准按两章加权」
  assert.ok(d[0].message.includes('38.0 字→4.0 字'), d[0].message);
  assert.ok(d[0].message.includes('0%→44%'), d[0].message);
  assert.ok(d[0].message.includes('1.0 句→2.0 句'), d[0].message);
  // basis 是「有顺序的四件事」，少一行作者就少一个判断依据（两章的基准本来比二十章的抖，
  // 全靠「基准几章几字 / 本章几字」那两行说话）。整串写死，删一行或换顺序都会红。
  assert.deepEqual(d[0].evidence.basis, [
    'book.styleAnchor.chapterIds=ch-001,ch-002',
    '基准指纹 2 章 / 1824 字',
    '本章 640 字',
    '同时越界 3 格（门槛：句均 30%、对话 12 个百分点、段均 40%、禁词 1.5 处/千字）',
  ], d[0].evidence.basis.join(' / '));
  assert.equal(d[0].fingerprint, 'style-drift:ch-003:-');
});

test('R32 误报控制：只越一格不报 —— 这一章本来就可能就是动作场面或独白', () => {
  // BODY_C 与基准只差禁词密度那一格（0 → 26.32 处/千字），越得再狠也只有一格
  const d = of(NWRules.runRules(ctx({ book: bookFit(), chapters: fitChapters(BODY_C) })), 'style-drift');
  assert.deepEqual(d, [], '单格越界不该自成一条诊断');
});

test('R32 作者没勾基准：整条闭嘴，一条都不报', () => {
  const all = NWRules.runRules(ctx({
    book: { id: 'novel_t', title: '测试书', genre: '玄幻' },
    chapters: fitChapters(BODY_B),
  }));
  assert.deepEqual(of(all, 'style-drift'), [],
    '没有作者勾的基准时绝不能拿「就近取两章」顶上 —— 长篇里那恰好是漂移最远的两章');
  assert.deepEqual(all.filter((x) => x.rule === 'rule-crashed'), []);
});

test('R32 基准章自己不评，哪怕两章基准彼此就差得很远', () => {
  const d = of(NWRules.runRules(ctx({
    book: bookFit(),
    chapters: [ch(1, { body: BODY_A }), ch(2, { body: BODY_B }), ch(3, { body: BODY_B })],
  })), 'style-drift');
  assert.deepEqual(d.map((x) => x.chapter), ['ch-003'], '勾进基准的章是尺子，不是被量的东西');
});

test('R32 勾的基准章正文都不够长：没有基准，整条静默', () => {
  const d = of(NWRules.runRules(ctx({
    book: { id: 'novel_t', title: '测试书', genre: '玄幻', styleAnchor: { chapterIds: ['ch-001', 'ch-999'] } },
    chapters: [ch(1, { body: '他挑水。' }), ch(2, { body: BODY_B }), ch(3, { body: BODY_A })],
  })), 'style-drift');
  assert.deepEqual(d, [], '基准章全被 600 字门槛挡掉时不许拿半句话评全书（这两章互为基准能越三格）');
});

test('R32 不评：带 flashback/dream 等标记的章、正文不足 600 字的章', () => {
  const d = of(NWRules.runRules(ctx({
    book: bookFit(),
    chapters: [ch(1, { body: BODY_A }), ch(2, { body: BODY_A }),
      ch(3, { body: BODY_B, flags: ['dream'] }), ch(4, { body: BODY_B.slice(0, 300) })],
  })), 'style-drift');
  assert.deepEqual(d, [], '梦境章与短章都不该出现在这份名单里');
});

test('R32 认作者关掉的词组：禁词那一格一消失，两格退回一格就不报了', () => {
  const chapters = fitChapters(BODY_F);
  // 夹具自己得先卡在门槛这一侧，否则下面两个「不报」是白过的
  assert.deepEqual(of(NWRules.runRules(ctx({ book: bookFit(), chapters })), 'style-drift')
    .map((x) => x.chapter), ['ch-003'], 'BODY_F 要正好越两格（句均 + 禁词）');
  assert.deepEqual(of(NWRules.runRules(ctx({ book: bookFit({ stylePack: { enabled: false } }), chapters })), 'style-drift'),
    [], '整包关掉 → 只剩句均一格');
  assert.deepEqual(of(NWRules.runRules(ctx({ book: bookFit({ stylePack: { disabled: ['simile'] } }), chapters })), 'style-drift'),
    [], '只关掉比喻那一组，走的必须是同一条路');
});

test('R32 遇到脏 styleAnchor 不许崩，也不许凭空造出基准', () => {
  for (const v of [undefined, null, 'ch-001', {}, { chapterIds: null }, { chapterIds: 'ch-001' },
    { chapterIds: [null, 12, '', 'ch-404'] }]) {
    const all = NWRules.runRules(ctx({ book: { id: 'novel_t', title: '测试书', genre: '玄幻', styleAnchor: v },
      chapters: fitChapters(BODY_B) }));
    const tag = JSON.stringify(v) + '';
    assert.deepEqual(all.filter((x) => x.rule === 'rule-crashed').map((x) => x.message), [], tag);
    assert.deepEqual(of(all, 'style-drift'), [], tag + ' 里没有一个 id 解析得到，必须整条静默');
  }
});

// ═══════════════ R33 卷级压缩缺口 ═══════════════

const sumCh = (n) => ch(n, { summary: `第${n}章：做了一件事` });
const manySum = (n) => Array.from({ length: n }, (_, i) => sumCh(i + 1));
const vol = (from, to, over = {}) => ({
  id: `vol_${from}_${to}`, order: from, title: `卷${from}`,
  fromChapter: `ch-00${from}`, toChapter: `ch-00${to}`,
  summary: `第${from}到${to}章的往事`, ...over,
});

test('R33 一本没建卷的书一条都不报 —— 那是还没用这套东西，不是缺陷', () => {
  const c = ctx({ chapters: manySum(60) });
  assert.deepEqual(of(NWRules.runRules(c), 'volume-gap'), []);
  assert.deepEqual(of(NWRules.runRules(ctx({ chapters: manySum(60), volumes: [] })), 'volume-gap'), []);
});

test('R33 建了卷却没盖住：报出「几章不在任何卷里」，数字是超出摘要那两级之后剩下的', () => {
  const c = ctx({ chapters: manySum(60), volumes: [vol(1, 5)] });
  const d = of(NWRules.runRules(c), 'volume-gap');
  assert.equal(d.length, 1, JSON.stringify(d.map((x) => x.message)));
  assert.equal(d[0].severity, 'info');
  assert.equal(d[0].chapter, null, '书级诊断不挂章');
  // 60 章 - 5 章被卷接管 - 细窗口 12 行 - 章名层 24 章 = 19 章真的看不见
  assert.match(d[0].message, /仍有 19 章不在任何卷里/);
  assert.match(d[0].message, /最早约在第 6 章/, '要说得出这一断从哪儿开始，否则作者得自己去数');
  assert.equal(d[0].confidence, 0.9, '「看不见细节」是算出来的，但不是硬事实：留一档不确定');
  // basis 三行是作者核对这条的唯一依据：总数、两级窗口、余下的数，少一行就得自己重算
  assert.deepEqual(d[0].evidence.basis, ['本书 60 章、1 卷，卷压掉 5 章', '细窗口 12 行、章名层 24 章', '余 19 章']);
});

test('R33 该盖的都盖住了就闭嘴：细窗口那 12 章本来逐章列着，不该被说成缺口', () => {
  const c = ctx({ chapters: manySum(60), volumes: [vol(1, 24), vol(25, 48)] });
  assert.deepEqual(of(NWRules.runRules(c), 'volume-gap'), [], '两卷连着盖住 1–48，12 章在细窗口里');
});

test('R33 空摘要的卷：框住了章却没压，单独报这一卷', () => {
  const c = ctx({ chapters: manySum(60), volumes: [vol(1, 20, { summary: '  ' }), vol(21, 48)] });
  const d = of(NWRules.runRules(c), 'volume-gap');
  assert.equal(d.length, 1);
  assert.equal(d[0].entity, 'vol_1_20');
  assert.match(d[0].message, /「卷1」 框住了 20 章却没写摘要/);
  assert.equal(d[0].confidence, 0.95, '这一条是「卷行了但摘要为空」，比推断类硬一档');
  // 空卷那条也得说得出区间：作者要知道补这 120 字要覆盖多少章
  assert.deepEqual(d[0].evidence.basis, ['volume.summary 为空', '区间 第 1–20 章·20 章']);
  assert.match(d[0].suggestion, /删掉/);
});

test('R33 起止读不出来：说清是被删了还是填反了，绝不按 order 猜区间', () => {
  const gone = { ...vol(1, 20), id: 'vGone', fromChapter: 'ch-999' };
  const flip = { ...vol(30, 10), id: 'vFlip', title: '卷反了' };
  const d = of(NWRules.runRules(ctx({ chapters: manySum(60), volumes: [gone, flip] })), 'volume-gap');
  const bad = d.filter((x) => /读不出来/.test(x.message));
  assert.ok(!d.some((x) => /重叠/.test(x.message)), '两卷都没有区间，重叠那条冒出来就是叫作者去挪不存在的边界');
  assert.equal(bad.length, 2, JSON.stringify(d.map((x) => x.message)));
  assert.deepEqual(bad.map((x) => x.entity).sort(), ['vFlip', 'vGone']);
  assert.match(bad.find((x) => x.entity === 'vFlip').message, /结束章排在起始章之前/);
  assert.match(bad.find((x) => x.entity === 'vGone').message, /已被删掉/);
  assert.deepEqual(bad.map((x) => x.severity).sort(), ['info', 'info'], '读不出来不等于作者错了');
  // basis 里那三行是「按不按章号猜」的分界：填的起止与 reason 原样摊开，作者一眼看得出差在哪
  assert.deepEqual(bad.find((x) => x.entity === 'vGone').evidence.basis,
    ['volume.fromChapter=ch-999', 'volume.toChapter=ch-0020', 'reason=missing']);
  assert.equal(bad.find((x) => x.entity === 'vGone').confidence, 1, '起止章在不在书里是事实判断，不该留置信度');
});

test('R33 两卷的起止都读不出来：不许在 -1 这个下标上算出「重叠」', () => {
  const a = { ...vol(1, 20), id: 'vA', fromChapter: 'ch-900' };
  const b = { ...vol(21, 30), id: 'vB', toChapter: 'ch-901' };
  const d = of(NWRules.runRules(ctx({ chapters: manySum(60), volumes: [a, b] })), 'volume-gap');
  assert.ok(!d.some((x) => /重叠/.test(x.message)), JSON.stringify(d.map((x) => x.message)));
  assert.deepEqual(d.filter((x) => /读不出来/.test(x.message)).map((x) => x.entity).sort(), ['vA', 'vB']);
});

test('R33 两卷重叠：报那对卷，也说清「压掉 N 章」里有水分', () => {
  const c = ctx({ chapters: manySum(60), volumes: [vol(1, 20), vol(15, 30), vol(31, 48)] });
  const d = of(NWRules.runRules(c), 'volume-gap');
  assert.equal(d.length, 1);
  assert.equal(d[0].entity, 'vol_1_20');
  assert.match(d[0].message, /在同一段上重叠 6 章/);
  assert.equal(d[0].confidence, 1, '两卷的区间写在一起就是明摆着的，不用留余地');
  // 三行按顺序是「谁、谁、重叠几章」：换成写死的 1 章或少一行，作者就没法挪边界
  assert.deepEqual(d[0].evidence.basis, ['卷1=第 1–20 章', '卷15=第 15–30 章', '重叠 6 章']);
});

test('R33 短篇不报：它的摘要本来就不封顶，卷层根本不参与', () => {
  const c = ctx({ book: { id: 'novel_t', title: '测试书', genre: '玄幻', format: 'short' },
    chapters: manySum(60), volumes: [vol(1, 5)] });
  assert.deepEqual(of(NWRules.runRules(c), 'volume-gap'), []);
});

test('R33 遇到脏卷不许崩，也不产出 error', () => {
  for (const v of [[{}], [null], [{ id: 'v1', title: '没起止' }], [{ id: 'v2', fromChapter: null, toChapter: undefined, summary: 'x' }],
    [{ id: 'v3', fromChapter: 'ch-001', toChapter: 'ch-002', summary: 42 }]]) {
    const all = NWRules.runRules(ctx({ chapters: manySum(60), volumes: v }));
    assert.deepEqual(all.filter((x) => x.rule === 'rule-crashed').map((x) => x.message), [], JSON.stringify(v));
    assert.deepEqual(of(all, 'volume-gap').filter((x) => x.severity !== 'info'), [], '这条规则不许命令作者');
  }
});

test('R33 与侧栏面板同一个数：规则报的缺口章数就是 gapNotice 那句里的数', () => {
  const chapters = manySum(60);
  const volumes = [vol(1, 5)];
  const plan = NWVolume.recapPlan({ chapters, currentId: null, volumes });
  const d = of(NWRules.runRules(ctx({ chapters, volumes })), 'volume-gap');
  assert.equal(d[0].message.match(/仍有 (\d+) 章/)[1], String(plan.counts.uncovered));
  assert.match(NWVolume.gapNotice(plan), new RegExp(`${plan.counts.uncovered} 章不在任何卷里`));
});

// ═══════════════ T 族：关系账本（R15 扫边、R31 认名字、R34 那四类）═══════════════

test('R15 现在也扫关系边：端点指向没建档的角色 → error，说清是哪条边哪一头', () => {
  const c = ctx({
    chapters: [ch(1)],
    characters: [char('char-lin', { name: '林烟火' })],
    relations: { edges: [rel({ to: 'char-ghost' })] },
  });
  const d = of(NWRules.runRules(c), 'dangling-reference');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'error');
  assert.equal(d[0].entity, 'rel-1');
  assert.match(d[0].message, /关系边 rel-1 的客体「char-ghost」在角色卡上没有这个人/, d[0].message);
  assert.deepEqual(d[0].evidence.basis, ['relation.to=char-ghost', 'unknown']);
});

test('R15 两头都断就报两条：主体与客体各说一次，不含糊成「这条边有问题」', () => {
  const c = ctx({
    chapters: [ch(1)],
    characters: [char('char-lin', { name: '林烟火' })],
    relations: { edges: [rel({ id: 'rel-9', from: 'char-ghost', to: 'char-nope' })] },
  });
  const d = of(NWRules.runRules(c), 'dangling-reference');
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => (x.message.includes('主体') ? 'from' : 'to')), ['from', 'to']);
});

test('R15 认名字：边里写的是角色名而本书只有一个此人 → 不算断链（AI 抽关系存的就是名字）', () => {
  const c = ctx({
    chapters: [ch(1, { body: '林烟火挑水。明长老咳了两声。' })],
    characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
    relations: { edges: [rel({ from: '林烟火', to: '明长老' })] },
  });
  assert.deepEqual(of(NWRules.runRules(c), 'dangling-reference'), []);
});

test('R15 名字撞车与端点留空各说各的：修法不同，混成「不存在」作者就不知道改哪一头', () => {
  const nameClash = of(NWRules.runRules(ctx({
    chapters: [ch(1)],
    characters: [char('char-lin', { name: '林烟火' }), char('char-a', { name: '甲' }), char('char-b', { name: '甲' })],
    relations: { edges: [rel({ to: '甲' })] },
  })), 'dangling-reference');
  assert.equal(nameClash.length, 1);
  assert.match(nameClash[0].message, /客体「甲」在角色卡上撞名，不知连到哪一个/, nameClash[0].message);
  assert.match(nameClash[0].suggestion, /改用角色 id/);
  const blank = of(NWRules.runRules(ctx({
    chapters: [ch(1)],
    characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
    relations: { edges: [rel({ from: null })] },
  })), 'dangling-reference');
  assert.equal(blank.length, 1);
  assert.match(blank[0].message, /没填主体/, blank[0].message);
});

test('R15 扫关系的起止章：指向被删掉的章要报，留空不报（留空 = 一直如此）', () => {
  const base = {
    chapters: [ch(1), ch(2), ch(3)],
    characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
  };
  const d = of(NWRules.runRules(ctx({ ...base, relations: { edges: [rel({ since: 'ch-001', until: 'ch-009' })] } })),
    'dangling-reference');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /失效章节「ch-009」不存在/, d[0].message);
  assert.deepEqual(d[0].evidence.basis, ['未找到 ch-009', 'relation.until=ch-009']);
  assert.match(d[0].suggestion, /留空 = 一直如此/);
  assert.deepEqual(of(NWRules.runRules(ctx({ ...base, relations: { edges: [rel()] } })), 'dangling-reference'), [],
    '起止留空是合法值，不是缺陷');
});

test('R15 不替 R34 说话：没有 id 的边它报不出「哪条边」，一条都不许报', () => {
  const c = ctx({
    chapters: [ch(1)],
    characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
    relations: { edges: [rel({ id: '' }), rel({ id: null }), null, {}, { id: 'rel-x', from: 'char-ghost', to: 'char-ming' }] },
  });
  const d = of(NWRules.runRules(c), 'dangling-reference');
  assert.deepEqual(d.map((x) => x.entity), ['rel-x'], JSON.stringify(d.map((x) => x.message)));
});

test('R31 端点解析走同一份：边里存的是名字也照样查同框，只认 id 时这批边是隐身的', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '林烟火挑水。' }), ch(2, { body: '明长老咳了两声。' })],
    characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
    relations: { edges: [rel({ from: '林烟火', to: '明长老' })] },
  })), 'relation-pair-never-together');
  assert.equal(d.length, 1);
  assert.equal(d[0].entity, 'rel-1');
  // 引证里给的是解析后的角色 id：作者据此去改的是那两条边的两端，不是那两个名字
  assert.match(d[0].evidence.basis[0], /^边 char-lin→char-ming/, d[0].evidence.basis.join(' / '));
});

test('R31 不查名字撞车的边：不知道连到哪一个，就不替作者挑一个人判他从未同框', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '林烟火挑水。甲在门口。' }), ch(2, { body: '林烟火挑水。' })],
    characters: [char('char-lin', { name: '林烟火' }), char('char-a', { name: '甲' }), char('char-b', { name: '甲' })],
    relations: { edges: [rel({ to: '甲' })] },
  })), 'relation-pair-never-together');
  assert.deepEqual(d, []);
});

test('R34 一条边都没有就整条闭嘴：连「关系」这一栏都没填过的书不是有缺口', () => {
  const base = { chapters: [ch(1)], characters: [char('char-lin', { name: '林烟火' })] };
  assert.deepEqual(of(NWRules.runRules(ctx(base)), 'relation-gap'), []);
  assert.deepEqual(of(NWRules.runRules(ctx({ ...base, relations: { edges: [] } })), 'relation-gap'), []);
  assert.deepEqual(of(NWRules.runRules(ctx({ ...base, relations: {} })), 'relation-gap'), []);
});

test('R34 四类各说一句，顺序固定：撞 id → 自环 → 填反 → 靠名字', () => {
  const c = ctx({
    chapters: [ch(1), ch(2), ch(3)],
    characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
    relations: { edges: [
      rel({ id: 'rel-1' }),
      rel({ id: 'rel-1', to: 'char-lin' }),                              // 与上一条同 id → skipped
      rel({ id: 'rel-2', to: 'char-lin' }),                               // 自环
      rel({ id: 'rel-3', since: 'ch-003', until: 'ch-001' }),             // 区间填反
      rel({ id: 'rel-4', from: '林烟火' }),                               // 靠名字连着
    ] },
  });
  const d = of(NWRules.runRules(c), 'relation-gap');
  assert.equal(d.length, 4, d.map((x) => x.message).join(' / '));
  assert.deepEqual(d.map((x) => x.entity), [null, 'rel-2', 'rel-3', 'rel-4']);
  assert.match(d[0].message, /^1 条关系边没有 id、或与别的边撞了同一个 id/, d[0].message);
  // 账本里那一行「5 条边」数的是记录条数（含画不出来的那条），不是图上的线数
  assert.match(d[0].evidence.basis[0], /账本里 5 条边，其中 1 条/, d[0].evidence.basis.join(' / '));
  assert.match(d[1].message, /林烟火 → 林烟火/, d[1].message);
  assert.match(d[2].message, /林烟火→明长老（师徒）的生效区间填反了/, d[2].message);
  assert.deepEqual(d[2].evidence.basis, ['since=ch-003（第 3 章）', 'until=ch-001（第 1 章）']);
  assert.match(d[3].message, /有一端写的是名字不是角色 id/, d[3].message);
  assert.deepEqual(d[3].evidence.basis, ['from=林烟火', '角色卡上有唯一的「林烟火」']);
  assert.deepEqual(d.map((x) => x.fingerprint), [...new Set(d.map((x) => x.fingerprint))]);
  assert.ok(d.every((x) => x.severity === 'info' && x.confidence === 1), '恒为 info，且不猜');
});

test('R34 不重复报 R15 的坏消息：端点没建档、起止章被删，一份坏消息说两遍只是吵', () => {
  const base = {
    chapters: [ch(1), ch(2)],
    characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
  };
  const edges = [
    rel({ id: 'rel-1', to: 'char-ghost' }),
    rel({ id: 'rel-2', since: 'ch-009' }),
  ];
  const all = NWRules.runRules(ctx({ ...base, relations: { edges } }));
  assert.deepEqual(of(all, 'relation-gap'), [], of(all, 'relation-gap').map((x) => x.message).join(' / '));
  assert.equal(of(all, 'dangling-reference').length, 2, '同一批坏边由 R15 报出，一条不漏');
});

test('R34 也不报「谁在网外」与「图分了几块」：没登记关系不是缺陷，两条不相干的故事线也不是', () => {
  const d = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: '甲。乙。丙。丁。' })],
    characters: [char('a', { name: '甲' }), char('b', { name: '乙' }), char('c', { name: '丙' }), char('d', { name: '丁' })],
    relations: { edges: [rel({ id: 'rel-1', from: 'a', to: 'b' }), rel({ id: 'rel-2', from: 'c', to: 'd' })] },
  })), 'relation-gap');
  assert.deepEqual(d, [], d.map((x) => x.message).join(' / '));
});

test('R34 遇到脏边不许崩，也不产出 error', () => {
  for (const edges of [[null], [{}], [{ id: 'e1', from: 42, to: [] }], [{ id: 'e2', from: 'a', to: 'a', since: 7, until: null }],
    [{ id: 'e3', from: 'char-lin', to: 'char-ming', since: 'ch-003', until: 'ch-001' }]]) {
    const all = NWRules.runRules(ctx({
      chapters: [ch(1), ch(2), ch(3)],
      characters: [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })],
      relations: { edges },
    }));
    assert.deepEqual(all.filter((x) => x.rule === 'rule-crashed').map((x) => x.message), [], JSON.stringify(edges));
    assert.deepEqual(of(all, 'relation-gap').filter((x) => x.severity !== 'info'), [], '这条规则不许命令作者');
  }
});

test('R34 与那张图同一个数：报出去的每一类都等于 NWRelationGraph 的桶，改判据只改一处', () => {
  const chapters = [ch(1), ch(2), ch(3)];
  const characters = [char('char-lin', { name: '林烟火' }), char('char-ming', { name: '明长老' })];
  const edges = [rel({ id: 'rel-1' }), rel({ id: 'rel-1' }), rel({ id: 'rel-2', to: 'char-lin' }),
    rel({ id: 'rel-3', since: 'ch-003', until: 'ch-002' }), rel({ id: 'rel-4', to: '明长老' })];
  const g = NWRelationGraph.build({ characters, edges, chapters, cut: null });
  const d = of(NWRules.runRules(ctx({ chapters, characters, relations: { edges } })), 'relation-gap');
  const spoken = (re) => d.filter((x) => re.test(x.message)).length;
  assert.equal(spoken(/没有 id/), g.counts.skipped ? 1 : 0);
  assert.equal(spoken(/两头是同一个人/), g.selfLoops.length);
  assert.equal(spoken(/填反了/), g.links.filter((x) => x.range.reason === 'reversed').length);
  assert.equal(spoken(/名字不是角色 id/), g.links.filter((x) => x.via.from === 'name' || x.via.to === 'name').length);
  assert.match(d[0].message, new RegExp(`${g.counts.skipped} 条关系边`), d[0].message);
});

// ═══════════════ R35 单章字数 ═══════════════

const bodyOf = (n) => '字'.repeat(n);
// 数字都写死（1200 / 4000 / 400）：断言若写成「等于 chapterRange 给的数」，
// 改了 CHAPTER_RANGE 两头一起变，测试照样绿 —— 那正是这个项目反复中招的假绿。
const lenDiags = (body, bookOver = {}) => of(NWRules.runRules(ctx({
  book: { id: 'novel_t', title: '测试书', genre: '玄幻', ...bookOver },
  chapters: [ch(1, { body })],
})), 'chapter-length');

test('R35 长篇低于下限 → info，说清是下限、差多少字', () => {
  const d = lenDiags(bodyOf(900));
  assert.equal(d.length, 1, d.map((x) => x.message).join(' / '));
  assert.equal(d[0].severity, 'info', '一章多长是节奏决定，不许命令作者');
  assert.equal(d[0].chapter, 'ch-001');
  assert.match(d[0].message, /第 1 章 正文 900 字，低于长篇那一档的下限 1200 字/);
  assert.match(d[0].message, /差 300 字/);
  assert.ok(d[0].evidence.basis.includes('countWords 900 字'), JSON.stringify(d[0].evidence.basis));
  assert.ok(d[0].evidence.basis.includes('本书按长篇那一档 1200-4000 字'));
  assert.match(d[0].suggestion, /并进相邻那章/);
});

test('R35 长篇高于上限 → info，说的是溢出多少字与拆章', () => {
  const d = lenDiags(bodyOf(4200));
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'info');
  assert.match(d[0].message, /4200 字，高于长篇那一档的上限 4000 字/);
  assert.match(d[0].message, /溢出 200 字/);
  assert.match(d[0].suggestion, /转折处拆一刀/);
});

test('R35 区间内不报，两个端点都算达标', () => {
  for (const n of [1200, 4000, 2000]) {
    assert.deepEqual(lenDiags(bodyOf(n)), [], `${n} 字该免报`);
  }
});

test('R35 换挡只看 book.format：同一章长篇报「低于下限」、短篇不报', () => {
  const d = lenDiags(bodyOf(500));
  assert.equal(d.length, 1, '500 字在长篇档低于 1200');
  assert.match(d[0].message, /低于长篇那一档的下限 1200 字/);
  assert.deepEqual(lenDiags(bodyOf(500), { format: 'short' }), [], '短篇档下限 400，这章达标');
  const s = lenDiags(bodyOf(300), { format: 'short' });
  assert.equal(s.length, 1);
  assert.match(s[0].message, /低于短篇那一档的下限 400 字 —— 差 100 字/);
  assert.ok(s[0].evidence.basis.includes('本书按短篇那一档 400 字起，上不封顶'), JSON.stringify(s[0].evidence.basis));
  // 认不出的 format 落回长篇，与 NWTension.quotaFor 同一口径
  assert.match(lenDiags(bodyOf(500), { format: 'novella' })[0].message, /长篇那一档/);
});

test('R35 短篇上不封顶：向导自己承诺的形状不许天天报', () => {
  // llm.js 那三档写着「微型 3k-6k 字，1-2 章」「盐选 5 万字 / 6-10 章」，摊到单章最坏 8300 字。
  // 给短篇安上限就是机器在报作者照着界面选出来的计划 —— 这一条钉的是「不该报」。
  assert.deepEqual(lenDiags(bodyOf(6000), { format: 'short' }), [], '微型档一章 6000 字是本书自己承诺的');
  assert.deepEqual(lenDiags(bodyOf(20000), { format: 'short' }), [], '短篇再长也不封顶');
  // 反方向：长篇那一头的上限还在，别把「不封顶」做成两边都不封顶
  const long = lenDiags(bodyOf(6000));
  assert.equal(long.length, 1, '同样 6000 字在长篇档仍要说一句');
  assert.match(long[0].message, /高于长篇那一档的上限 4000 字 —— 溢出 2000 字/);
});

test('R35 空章与没开写的章不评', () => {
  for (const body of ['', '   \n　  ', undefined, null]) {
    assert.deepEqual(lenDiags(body), [], JSON.stringify(body));
  }
});

test('R35 豁免标记的章不评，但 montage 不在豁免里', () => {
  for (const flag of ['flashback', 'dream', 'quoted', 'offscreen']) {
    const diags = of(NWRules.runRules(ctx({
      chapters: [ch(1, { body: bodyOf(900), flags: [flag] })],
    })), 'chapter-length');
    assert.deepEqual(diags, [], `${flag} 章不该被评字数`);
  }
  const montage = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: bodyOf(900), flags: ['montage'] })],
  })), 'chapter-length');
  assert.equal(montage.length, 1, 'montage 不是豁免标记，短了照样说');
});

test('R35 数的是 countWords 不是字符数：一堆标点抬不进区间', () => {
  const body = `${bodyOf(1150)}${'，。！？、；：'.repeat(60)}`; // 1570 字符 / 1150 字
  assert.ok(body.length > 1200, '夹具得是「按字符数已达标」那种，否则什么都没钉');
  assert.equal(NWText.countWords(body), 1150);
  const d = lenDiags(body);
  assert.equal(d.length, 1, d.map((x) => x.message).join(' / '));
  assert.match(d[0].message, /正文 1150 字/);
  assert.ok(d[0].evidence.basis.some((b) => /body 1570 字符（含标点，不参与判定）/.test(b)),
    JSON.stringify(d[0].evidence.basis));
});

test('R35 不碰目标字数，也不因一章超上限而重复报', () => {
  assert.deepEqual(lenDiags(bodyOf(900), { target_words: 300000 }).map((x) => x.chapter), ['ch-001'],
    '总字数是计划那一路的事，评分卡的 length 维才比它');
  const many = of(NWRules.runRules(ctx({
    chapters: [ch(1, { body: bodyOf(900) }), ch(2, { body: bodyOf(5000) })],
  })), 'chapter-length');
  assert.equal(many.length, 2, JSON.stringify(many.map((x) => x.message)));
  assert.equal(new Set(many.map((x) => x.fingerprint)).size, 2, '两章两条，指纹不得撞车');
});
