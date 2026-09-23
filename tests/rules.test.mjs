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
