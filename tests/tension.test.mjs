import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWRules, NWTension } from './_load.mjs';

const ch = (n, over = {}) => ({
  id: `ch-${String(n).padStart(3, '0')}`, number: n, title: `第${n}章`, status: 'draft',
  body: '', characters: [], mentions: [], locations: [], flags: [], ...over,
});
const ctx = (over = {}) => ({
  book: { id: 'novel_t', title: '测试书', genre: '玄幻' },
  chapters: [], characters: [], world: [],
  promises: { items: [] }, states: { byChapter: {} },
  timeline: { anchors: [], backstory: [] }, lexicon: { names: {} }, secrets: [], ...over,
});
const of = (diags, rule) => diags.filter((d) => d.rule === rule);

/** 一段约 n 个汉字的纯叙述（标点不计字数，所以乘 2 足够粗）。 */
function narration(n, seed = 0) {
  const units = [
    '他沿着石阶往上走，雾贴着脚背流动，山门还在很远的地方。',
    '林中的光线一寸一寸暗下去，风从谷口灌进来，吹得衣袍猎猎作响。',
    '他停下脚步回头看去，来路已经被雾填满，看不出是第几道弯。',
    '钟声从崖下传上来，一声隔着一声，像是有人在替谁数着时辰。',
  ];
  let s = '';
  for (let i = 0; i < n; i++) s += units[(i + seed) % units.length] + '\n\n';
  return s.trim();
}
const line = (t) => `“${t}”`;

// ═════════════════ NWTension 统计层 ═════════════════

test('对话占比只认成对引号：漏了后引号的那一段不算对话，占比不会虚高', () => {
  const paired = NWTension.stats(`${line('你来了。')}\n\n${narration(40, 0)}`);
  assert.ok(paired.dialogueWords >= 3 && paired.dialogueWords < 20, `对话字数异常：${paired.dialogueWords}`);

  const broken = NWTension.stats(`他说：“这里一直往前都是别人的地盘，我们不能停下来。${narration(40, 1)}`);
  assert.equal(broken.dialogueWords, 0, '没有后引号却被算成对话，占比会一路虚高');
});

test('最长纯叙述连段在有人开口处归零，不跨对话累计', () => {
  const interrupted = NWTension.stats(`${narration(20, 0)}\n\n${line('剑呢？')}\n\n${narration(20, 1)}`);
  const whole = NWTension.stats(narration(40, 0));
  assert.ok(interrupted.plainRuns.words < whole.plainRuns.words, '对话把叙述切断了，最长连段却照旧');
  assert.ok(interrupted.plainRuns.words > 100, '连段短得不真实');
});

test('钩子分类只认问句与突转，认不出的一律 null', () => {
  assert.equal(NWTension.hookKind(NWTension.tailOf('他到底还是来了？')), 'question');
  assert.equal(NWTension.hookKind(NWTension.tailOf('话音未落，山门外传来一声巨响。')), 'twist');
  assert.equal(NWTension.hookKind(NWTension.tailOf('他吹熄了灯，和衣躺下。')), null);
  assert.equal(NWTension.hookKind(''), null);
});

test('配额按版式取档，认不出的 format 落回长篇', () => {
  assert.equal(NWTension.quotaFor({ format: 'short' }).minWords, NWTension.QUOTAS.short.minWords);
  assert.equal(NWTension.quotaFor({}).minWords, NWTension.QUOTAS.long.minWords);
  assert.equal(NWTension.quotaFor(null).minWords, NWTension.QUOTAS.long.minWords);
});

test('promptBlock：没登记伏笔时不写那行动态数字', () => {
  assert.ok(!NWTension.promptBlock({ format: 'long' }).includes('未收伏笔'));
  const withTally = NWTension.promptBlock({ format: 'long' }, { open: 7, overdue: 2, oldest: 23 });
  assert.match(withTally, /未收伏笔 7 条，其中 2 条已过/);
  assert.match(withTally, /最久的一条已经 23 章/);
});

// ═════════════════ R23 dialogue-ratio ═════════════════

test('R23 整章没人开口 → info，并给出占比', () => {
  const d = of(NWRules.runRules(ctx({ chapters: [ch(1, { body: narration(90, 0) })] })), 'dialogue-ratio');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'info');
  assert.equal(d[0].chapter, 'ch-001');
  assert.ok(d[0].message.includes('对话只占 0%'), d[0].message);
  assert.ok(d[0].evidence.basis.join().includes('最长'), d[0].evidence.basis.join());
});

test('R23 对话达标的章不报', () => {
  let body = '';
  for (let i = 0; i < 30; i++) body += `${line('这件事不能再拖了，你必须现在就下山去。')}\n\n${narration(1, i)}\n\n`;
  const d = of(NWRules.runRules(ctx({ chapters: [ch(1, { body: body.trim() })] })), 'dialogue-ratio');
  assert.deepEqual(d, [], '对话过半的章被误报成没人开口');
});

test('R23 短章与豁免标记章不评', () => {
  const shortBook = ctx({ book: { format: 'long' }, chapters: [ch(1, { body: narration(12, 0) })] });
  assert.deepEqual(of(NWRules.runRules(shortBook), 'dialogue-ratio'), []);
  const flagged = ctx({ chapters: [ch(1, { body: narration(90, 0), flags: ['montage'] })] });
  assert.equal(of(NWRules.runRules(flagged), 'dialogue-ratio').length, 1, 'montage 不在豁免名单里，这是有意的');
  const exempt = ctx({ chapters: [ch(1, { body: narration(90, 0), flags: ['offscreen'] })] });
  assert.deepEqual(of(NWRules.runRules(exempt), 'dialogue-ratio'), []);
});

test('R23 只有一长段没台词时说的是连段，不是说整章没人开口', () => {
  // 对话铺在前面把占比抬过 8% 门槛，后面接一大段没人说话的叙述
  const dlg = [
    '水还剩多少，够不够走一个来回？', '不能再拖了，你必须今天就下山去。', '山门那边到底有没有动静？',
    '他若不来，我们明日便亲自去请。', '这条路我走过，闭着眼也不会走错。', '既然如此，那就分头行事，天黑前在渡口碰头。',
  ];
  let body = '';
  for (let i = 0; i < 13; i++) body += `${line(dlg[i % dlg.length])}\n\n${narration(1, i)}\n\n`;
  body += narration(52, 1);
  const d = of(NWRules.runRules(ctx({ chapters: [ch(1, { body: body.trim() })] })), 'dialogue-ratio');
  assert.equal(d.length, 1);
  assert.match(d[0].message, /连续 \d+ 字没有一句台词/);
  assert.ok(!d[0].message.includes('对话只占'), `占比 ${(d[0].evidence.ratio * 100).toFixed(1)}% 已过门槛，不该提占比`);
});

// ═════════════════ R24 chapter-no-change ═════════════════

test('R24 全书一条登记都没有时整条规则闭嘴（不惩罚不记账的作者）', () => {
  const c = ctx({ chapters: [ch(1, { body: narration(60, 0) }), ch(2, { body: narration(60, 1) })] });
  assert.deepEqual(of(NWRules.runRules(c), 'chapter-no-change'), []);
});

test('R24 有账本可查却什么都没动 → info，连续两章时说明是连着', () => {
  const c = ctx({
    chapters: [ch(1, { body: narration(60, 0) }), ch(2, { body: narration(60, 1) })],
    // 账本开门：第 1 章给某实体记了第一笔状态。首次登记不算变化，所以两章都还是平章。
    states: { byChapter: { 'ch-001': { 'char-a': { loc: '山门' } } } },
  });
  const d = of(NWRules.runRules(c), 'chapter-no-change');
  assert.equal(d.length, 2);
  assert.ok(d.every((x) => x.severity === 'info'));
  assert.ok(!d[0].message.includes('上一章同样如此'));
  assert.match(d[1].message, /上一章同样如此/);
  assert.match(d[1].suggestion, /连着两章/);
});

test('R24 四种变化点各自都能让本章免报', () => {
  const base = {
    chapters: [ch(1, { body: narration(60, 0) })],
    promises: { items: [{ id: 'p-1', type: 'promise', status: 'planted', weight: 'major', setup: { chapter: 'ch-999' }, payoff: { chapter: null, due: null } }] },
  };
  const withSetup = of(NWRules.runRules(ctx({
    ...base, promises: { items: [{ ...base.promises.items[0], setup: { chapter: 'ch-001' } }] },
  })), 'chapter-no-change');
  assert.deepEqual(withSetup, [], '本章埋了伏笔还报平章');

  const withPayoff = of(NWRules.runRules(ctx({
    ...base, promises: { items: [{ ...base.promises.items[0], payoff: { chapter: 'ch-001', due: null } }] },
  })), 'chapter-no-change');
  assert.deepEqual(withPayoff, [], '本章收了伏笔还报平章');

  const withSecret = of(NWRules.runRules(ctx({
    ...base, secrets: [{ id: 'sec-1', term: '身世', enabled: true, reveal_chapter: 'ch-001' }],
  })), 'chapter-no-change');
  assert.deepEqual(withSecret, [], '本章揭了信息差还报平章');

  const withState = of(NWRules.runRules(ctx({
    ...base,
    chapters: [ch(1, { body: narration(60, 0) }), ch(2, { body: narration(60, 1) })],
    states: { byChapter: { 'ch-001': { 'char-a': { loc: '山门' } }, 'ch-002': { 'char-a': { loc: '谷底' } } } },
  })), 'chapter-no-change');
  assert.deepEqual(withState.map((d) => d.chapter), ['ch-001'], '位置变了的那章不该报');
});

test('R24 首次登记某实体不算变化，补账不会把平章洗白', () => {
  const c = ctx({
    chapters: [ch(1, { body: narration(60, 0) })],
    promises: { items: [{ id: 'p-1', type: 'promise', status: 'planted', weight: 'major', setup: { chapter: 'ch-002' } }] },
    states: { byChapter: { 'ch-001': { 'char-a': { loc: '山门', injury: [], items: [], knows: [] } } } },
  });
  const d = of(NWRules.runRules(c), 'chapter-no-change');
  assert.equal(d.length, 1);
  assert.equal(d[0].chapter, 'ch-001');
});

test('R24 列表维度只多了一条空记录不算变化（免得把平章洗白）', () => {
  const c = ctx({
    chapters: [ch(1, { body: narration(60, 0) }), ch(2, { body: narration(60, 1) })],
    promises: { items: [{ id: 'p-1', type: 'promise', status: 'planted', weight: 'major', setup: { chapter: 'ch-001' } }] },
    states: {
      byChapter: {
        'ch-001': { 'char-a': { items: ['剑', '符'] } },
        'ch-002': { 'char-a': { items: ['剑', '符', ''] } },
      },
    },
  });
  const d = of(NWRules.runRules(c), 'chapter-no-change');
  assert.deepEqual(d.map((x) => x.chapter), ['ch-002'], '空记录被当成了实质变化，平章就此被洗白');
});

test('R24 正文不足门槛的章不评（大纲章不该被催登记）', () => {
  const c = ctx({
    chapters: [ch(1, { body: narration(60, 0) }), ch(2, { body: '（大纲）下山，遇伏。' })],
    promises: { items: [{ id: 'p-1', type: 'promise', status: 'planted', weight: 'major', setup: { chapter: 'ch-001' } }] },
  });
  assert.deepEqual(of(NWRules.runRules(c), 'chapter-no-change'), []);
});

// ═════════════════ R25 same-hook-streak ═════════════════

test('R25 连续三章问句收尾 → 一条诊断，落在段首章', () => {
  const body = (seed) => `${narration(45, seed)}\n\n他还能赶得上吗？`;
  const c = ctx({ chapters: [ch(1, { body: body(0) }), ch(2, { body: body(1) }), ch(3, { body: body(2) })] });
  const d = of(NWRules.runRules(c), 'same-hook-streak');
  assert.equal(d.length, 1);
  assert.equal(d[0].chapter, 'ch-001');
  assert.equal(d[0].entity, 'question');
  assert.equal(d[0].severity, 'info');
  assert.match(d[0].message, /第 1–3 章连续 3 章都是问句收尾/);
});

test('R25 钩子换型或中间断掉就不算偷懒', () => {
  const q = (s) => `${narration(45, s)}\n\n这一下他怎么接？`;
  const t = (s) => `${narration(45, s)}\n\n话音未落，门开了。`;
  const plain = (s) => `${narration(45, s)}\n\n他吹熄了灯。`;
  const mixed = ctx({ chapters: [ch(1, { body: q(0) }), ch(2, { body: t(1) }), ch(3, { body: q(2) })] });
  assert.deepEqual(of(NWRules.runRules(mixed), 'same-hook-streak'), []);
  const broken = ctx({ chapters: [ch(1, { body: q(0) }), ch(2, { body: q(1) }), ch(3, { body: plain(2) }), ch(4, { body: q(3) }), ch(5, { body: q(4) })] });
  assert.deepEqual(of(NWRules.runRules(broken), 'same-hook-streak'), [], '被平收尾打断后又在计数');
  const four = ctx({ chapters: [1, 2, 3, 4].map((n) => ch(n, { body: t(n) })) });
  const d = of(NWRules.runRules(four), 'same-hook-streak');
  assert.equal(d.length, 1, '四章连击该合并成一条');
  assert.match(d[0].message, /连续 4 章/);
});

test('三条新规则永不抬到 warn 以上（自修补写不该去凑配额）', () => {
  const c = ctx({
    chapters: [ch(1, { body: narration(90, 0) + '\n\n他到底来不来？' }), ch(2, { body: narration(90, 1) + '\n\n他到底来不来？' })],
    promises: { items: [{ id: 'p-1', type: 'promise', status: 'planted', weight: 'major', setup: { chapter: 'ch-001' } }] },
  });
  const d = of(NWRules.runRules(c), 'dialogue-ratio')
    .concat(of(NWRules.runRules(c), 'chapter-no-change'), of(NWRules.runRules(c), 'same-hook-streak'));
  assert.ok(d.length >= 3, `期望至少三条提示，实得 ${d.length}`);
  assert.ok(d.every((x) => x.severity === 'info'), d.map((x) => `${x.rule}=${x.severity}`).join());
});

test('三条新规则的指纹稳定：同一本书跑两次，指纹一字不差', () => {
  const c = () => ctx({
    chapters: [ch(1, { body: narration(90, 0) }), ch(2, { body: narration(90, 1) })],
    promises: { items: [{ id: 'p-1', type: 'promise', status: 'planted', weight: 'major', setup: { chapter: 'ch-001' } }] },
  });
  const once = NWRules.runRules(c()).filter((d) => ['dialogue-ratio', 'chapter-no-change', 'same-hook-streak'].includes(d.rule));
  const twice = NWRules.runRules(c()).filter((d) => ['dialogue-ratio', 'chapter-no-change', 'same-hook-streak'].includes(d.rule));
  assert.deepEqual(once.map((d) => d.fingerprint), twice.map((d) => d.fingerprint));
  assert.ok(once.length && once.every((d) => d.source === 'machine'));
});
