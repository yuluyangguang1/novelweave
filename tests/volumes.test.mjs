import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWVolume as V, NWContext } from './_load.mjs';

// ═══════════════ 夹具 ═══════════════

/** n 章、章号连号、每章都有摘要的一本长篇；id 是 c1…cn */
const mk = (n, { summary = true } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`, order: i + 1, number: i + 1, title: `第${i + 1}章`,
    summary: summary ? `核心事件：第${i + 1}章的事` : '',
  }));

/** 盖住第 a 到 b 章（含）的一卷，默认带摘要 */
const vol = (a, b, extra = {}) => ({
  id: `v${a}`, novel_id: 'n1', order: a, title: `卷${a}`,
  fromChapter: `c${a}`, toChapter: `c${b}`, summary: `第${a}到${b}章的往事`, ...extra,
});

const FINE = 12, MID = 24;
/** currentId 传 null = 整本都算「过去」（写到最后一章之后） */
const plan = (chapters, volumes, currentId = null, opt = {}) =>
  V.recapPlan({ chapters, volumes, currentId, fine: FINE, mid: MID, ...opt });

// ═══════════════ 区间定位 ═══════════════

test('boundsOf 把起止章 id 落成下标，反填与缺失各判一种坏', () => {
  const ch = mk(30);
  assert.deepEqual(V.boundsOf(vol(3, 9), ch), { ok: true, from: 2, to: 8 });
  assert.equal(V.boundsOf(vol(9, 3), ch).reason, 'reversed');
  assert.equal(V.boundsOf({ ...vol(3, 9), toChapter: 'c999' }, ch).reason, 'missing');
  assert.equal(V.boundsOf(vol(3, 3), ch).ok, true, '起止同章是一章的卷，不是坏卷');
});

test('spans 保留坏卷并按卷序排一次', () => {
  const ch = mk(30);
  const s = V.spans([vol(15, 20), vol(1, 5, { id: 'vA' }), { ...vol(25, 30), id: 'vBad', toChapter: '没了' }], ch);
  assert.deepEqual(s.map((x) => x.vol.id), ['vA', 'v15', 'vBad']);
  assert.equal(s.filter((x) => !x.ok).length, 1, '坏卷被静默丢掉的话，作者永远不会知道有一卷读不出来');
});

test('rangeText 说起止的实际章号，coveredCount 数的是书里真有的章', () => {
  const ch = mk(30).filter((c) => c.order !== 12);  // 删过第 12 章
  const s = V.spans([vol(10, 20)], ch)[0];
  assert.equal(V.rangeText(s, ch), '第 10–20 章', '区间说法照实报起止');
  assert.equal(V.coveredCount(s), 10, '章号断过，那一卷其实只盖着 10 章');
  assert.equal(V.rangeText({ from: 0, to: 0 }, ch), '第 1 章');
  assert.equal(V.rangeText({ from: 5, to: 99 }, ch), '起止章不在书里');
});

test('章形只有 number 没有 order（buildCtx 与 CLI 的产物）也要说清区间', () => {
  // 浏览器与 CLI 拿到的章是 {id, number, title}，order 已经不在对象上了；
  // rangeText 只看 order 会写成「第 undefined 章」，而它恰好是最显眼的那一行
  const ch = mk(30).map(({ order, ...c }) => c);
  const s = V.spans([vol(3, 9)], ch)[0];
  assert.equal(V.rangeText(s, ch), '第 3–9 章');
  assert.equal(V.lineOf(s, ch), '- 卷3（第 3–9 章·7 章）：第3到9章的往事');
});

test('库里的章只有 order 没有 number：面板那一行的区间照样是章号', () => {
  // 侧栏「卷」面板传的是 NovelDB.chapters.list 的行，那上面没有 number。
  // 只看 number 会写成「第 undefined 章」，而这一行是面板上唯一说清覆盖了哪几章的地方。
  const rows = mk(30).map(({ number, ...c }) => c);
  const s = V.spans([vol(3, 9)], rows)[0];
  assert.equal(V.rangeText(s, rows), '第 3–9 章');
});

// ═══════════════ 三条不可让的判据 ═══════════════

test('判据一：没写摘要的卷不盖章，它盖住的章一律退回原层级', () => {
  const p = plan(mk(60), [vol(1, 30, { summary: '   ' })]);
  assert.equal(p.empty.length, 1, '空卷要进 empty 桶说出口');
  assert.equal(p.volumes.length, 0);
  assert.equal(p.covered.has('c5'), false, '空卷盖章就是把「记不全」伪装成「压缩过了」');
  assert.equal(p.titles.length + p.uncovered.length, 60 - FINE, '一章都没少，只是没压成一行');
});

test('判据二：终点落在目标章之后的卷不注入，那是剧透', () => {
  const p = plan(mk(60), [vol(1, 20), vol(31, 60)], 'c45');
  assert.equal(p.volumes.length, 1);
  assert.equal(p.volumes[0].vol.title, '卷1');
  assert.equal(p.deferred.length, 1, '卷31–60 含着第 45 章之后的一切，必须说得出为什么没用');
  assert.equal(p.covered.has('c20'), true);
  assert.equal(p.covered.has('c35'), false);
});

test('判据二的边界：终点是目标章前一章不算剧透，但压着细窗口就不参与', () => {
  const p = plan(mk(60), [vol(1, 44)], 'c45');
  assert.equal(p.deferred.length, 0, '到第 44 章为止，没越界');
  assert.equal(p.partial.length, 1, '它盖着最近 12 章那一段，再说一遍是重复');
  assert.equal(p.volumes.length, 0);
  const q = plan(mk(60), [vol(1, 32)], 'c45');
  assert.equal(q.volumes.length, 1, '整卷都在细窗口之前才真起到压缩作用');
});

/** fineStart 这一头是「差一章」的边界：卷的终点正好是细窗口第一章时，那一章会被说两遍。 */
test('终点正好落在细窗口第一章上的卷算重复，不注入也不计入压缩', () => {
  // c45 之前那 12 章从 c33 起。卷到 c32 为止是纯压缩（whole），卷到 c33 就与章行撞了一章。
  const hit = plan(mk(60), [vol(1, 33)], 'c45');
  assert.equal(hit.partial.length, 1, '压着细窗口的卷进 partial');
  assert.equal(hit.volumes.length, 0, '它不该出现在注入清单里');
  assert.equal(hit.counts.covered, 0, '没参与的卷一章也没盖住，压缩数不许把它算进去');
  const justBefore = plan(mk(60), [vol(1, 32)], 'c45');
  assert.equal(justBefore.volumes.length, 1);
  assert.equal(justBefore.counts.covered, 32);
});

test('判据三：删章后不靠 order 猜区间，起止读不出来就当坏', () => {
  const ch = mk(60).filter((c) => ![5, 28].includes(c.order));
  const p = plan(ch, [{ ...vol(1, 30), toChapter: 'c28' }]);
  assert.equal(p.bad.length, 1);
  assert.equal(p.volumes.length, 0, '按 order 硬凑会把盖不住的章说成盖住了');
  assert.ok(V.gapNotice(p).includes('1 卷的起止章在书里读不出来'), V.gapNotice(p));
});

// ═══════════════ 分层 ═══════════════

test('没有卷时逐层退回今天的行为：12 细 / 24 章名 / 更早只报数', () => {
  const p = plan(mk(60), []);
  assert.equal(p.fine.length, FINE);
  assert.equal(p.titles.length, MID);
  assert.equal(p.uncovered.length, 60 - FINE - MID);
  assert.equal(p.volumes.length, 0);
  assert.equal(p.compressed, 0);
});

/** 层数对了不等于拿对了章：章名层取的必须是紧邻细窗口那一段，取最老那 24 章层数一样、内容全错。 */
test('章名层取的是紧邻细窗口的 24 章，剩下的那段才降级成计数', () => {
  const p = plan(mk(60), []);
  assert.equal(p.fine[0].id, 'c49', '细窗口是最近 12 章');
  assert.deepEqual([p.titles[0].id, p.titles[p.titles.length - 1].id], ['c25', 'c48']);
  assert.equal(p.uncovered[p.uncovered.length - 1].id, 'c24', '计数那一段要接着章名层往前，中间不许跳章');
  assert.equal(p.uncovered.length, 24);
});

test('一卷压住「更早」那一段：未提数缩，卷行替它说话', () => {
  const p = plan(mk(60), [vol(1, 20)]);
  assert.equal(p.volumes.length, 1);
  assert.equal(p.fine.length, FINE, '细窗口一章不许被卷挤掉');
  assert.equal(p.titles.length, MID, '章名层仍是 24 章 —— 被盖走的 20 章本来在未提那一段里');
  assert.equal(p.uncovered.length, 60 - FINE - MID - 20);
  assert.equal(p.compressed, 20);
});

test('压在细窗口上的卷不参与，那几十章本来就逐章列着', () => {
  const p = plan(mk(60), [vol(45, 60)]);
  assert.equal(p.volumes.length, 0);
  assert.equal(p.partial.length, 1, '要说得出「这一卷没压，因为它还盖着最近那段」');
  assert.equal(p.covered.has('c50'), false);
});

test('超过 VOL_WINDOW 卷就折最老的，折掉的说的是几卷几章而不是「没提」', () => {
  const ch = mk(300);
  const vs = [];
  for (let a = 1; a <= 281; a += 20) vs.push(vol(a, a + 19));
  const p = plan(ch, vs);
  assert.equal(vs.length, 15);
  assert.equal(p.partial.length, 1, '最后一卷（281–300）压着细窗口');
  assert.equal(p.volumes.length, V.VOL_WINDOW);
  assert.equal(p.folded.length, 14 - V.VOL_WINDOW);
  assert.equal(p.volumes[0].vol.title, '卷41', '14 卷参与、折最老的 2 卷，留下的是最近那 12 卷');
  assert.equal(p.compressed, 280, '折掉的卷照样盖着章');
  assert.equal(V.foldedText(p.folded), '（更早 2 卷、约 40 章已折）');
  assert.equal(p.titles.length, 8, '288 章里 280 章已被接管，章名层只剩 8 章');
  assert.equal(p.uncovered.length, 0);
});

test('折掉的卷不重复出现在章名层，也不报成未覆盖', () => {
  const p = plan(mk(100), [vol(1, 20), vol(21, 40), vol(41, 60)], null, { volumeWindow: 1 });
  assert.equal(p.volumes.length, 1);
  assert.equal(p.volumes[0].vol.title, '卷41', '留的是最近那一卷');
  assert.equal(p.titles.length + p.uncovered.length, 100 - FINE - 60, '60 章已被三卷接管，不能再逐章出场');
  assert.equal(V.gapNotice(p), '4 章不在任何卷里', V.gapNotice(p));
});

// ═══════════════ 渲染与话术 ═══════════════

/** volumeWindow 是调用方给的，给成 0 时 slice(-0) 会把所有卷一起注入 —— 上限那一档等于消失。 */
test('volumeWindow 给成 0 也至少注入最近一卷', () => {
  const p = plan(mk(60), [vol(1, 20), vol(21, 32)], null, { volumeWindow: 0 });
  assert.equal(p.volumes.length, 1, '一行都不注入等于这套东西消失了');
  assert.equal(p.folded.length, 1, '多出来的那卷折掉，不是丢掉');
});

test('lineOf 一行里卷名、区间、章数、摘要齐备；摘要截到 VOL_LINE_CHARS', () => {
  const ch = mk(30);
  const s = V.spans([vol(3, 9)], ch)[0];
  assert.equal(V.lineOf(s, ch), '- 卷3（第 3–9 章·7 章）：第3到9章的往事');
  const long = V.spans([vol(3, 9, { summary: '字'.repeat(200) })], ch)[0];
  assert.equal(V.lineOf(long, ch), `- 卷3（第 3–9 章·7 章）：${'字'.repeat(V.VOL_LINE_CHARS)}…`);
});

test('clip 把换行与空白收成单空格，不照抄整段卷稿', () => {
  assert.equal(V.clip('  甲\n\n 乙   丙  '), '甲 乙 丙');
  assert.equal(V.clip(''), '');
  assert.equal(V.clip(null), '');
});

test('gapNotice 五种成因各说一句、顺序固定；没缺口就是空串', () => {
  assert.equal(V.gapNotice(plan(mk(60), [])), '', '没建卷的书不该被说成有缺口');
  const p = plan(mk(60), [
    vol(1, 10, { summary: '' }),
    { ...vol(11, 20), id: 'vBad', fromChapter: '没了' },
    vol(21, 36),
    { ...vol(31, 44), id: 'vOver', order: 99 },
    vol(45, 60),
  ], 'c45');
  assert.deepEqual(V.gapNotice(p).split(' · '), [
    '8 章不在任何卷里',
    '1 卷还没写摘要，它盖住的章没被压缩',
    '1 卷的起止章在书里读不出来',
    '1 对卷的起止重叠，那几章被算了两遍',
    '1 卷越过本章，没用它（用了就是剧透）',
  ], V.gapNotice(p));
});

test('overlaps 只按真区间认重叠，坏卷不参与；共享一章也算', () => {
  const ch = mk(30);
  const s = V.spans([vol(1, 10), vol(8, 12)], ch);
  assert.deepEqual(V.overlaps(s).map((o) => o.chapters), [3]);
  assert.equal(V.overlaps(V.spans([vol(1, 10), vol(11, 20)], ch)).length, 0, '首尾相接不是重叠');
  assert.deepEqual(V.overlaps(V.spans([vol(1, 10), vol(10, 20)], ch)).map((o) => o.chapters), [1],
    '共用第 10 章也算一次重叠');
  const bad = V.spans([vol(1, 10), { ...vol(5, 8), fromChapter: '没了' }], ch);
  assert.equal(V.overlaps(bad).length, 0, '起止都读不出来的卷没有区间，谈不上重叠');
  // 读不出来的卷 from/to 都是 -1：两卷凑一起，不 filter 就会在 -1 上算出「重叠 1 章」
  const twoBad = V.spans([{ ...vol(5, 8), fromChapter: '没了' }, { ...vol(12, 15), toChapter: '也没了' }], ch);
  assert.deepEqual(V.overlaps(twoBad), [], '两卷都读不出来时，不许在 -1 这个下标上算出一次重叠');
  assert.doesNotMatch(V.gapNotice(V.recapPlan({ chapters: mk(60), currentId: null, volumes: twoBad.map((s) => s.vol) })),
    /重叠/, '假重叠会跑到缺口那句话里，叫作者去挪一对根本不存在的边界');
});

test('重叠的卷不许把压缩数说大：covered 是集合，重叠部分只算一遍', () => {
  const p = plan(mk(30), [vol(1, 10), vol(8, 12)], 'c29');
  assert.equal(p.counts.overlaps, 1);
  assert.equal(p.compressed, 12, '1–12 章，不是 10+5=15');
});

// ═══════════════ 残缺输入 ═══════════════

test('残缺输入一律不抛：空书、没卷、没目标章、fine/mid 没传', () => {
  assert.equal(plan([], [], null).counts.head, 0);
  assert.equal(V.recapPlan({}).counts.fine, 0);
  assert.equal(V.recapPlan({ chapters: mk(5), currentId: 'c3' }).fine.length, 2);
  assert.equal(plan(mk(20), null).volumes.length, 0);
  assert.equal(V.gapNotice(null), '');
  assert.equal(V.foldedText([]), '');
  assert.ok(V.lineOf({ vol: {}, from: 0, to: 0 }, []).includes('未命名卷'));
});

test('目标章不在书里：不猜位置，head 为空、整卷算越前', () => {
  const p = plan(mk(30), [vol(1, 10)], 'c999');
  assert.equal(p.counts.head, 0);
  assert.equal(p.deferred.length, 1);
});

test('版本与窗口常量写死：改了它们就得同时改这里与模块注释', () => {
  assert.equal(V.VOLUME_VERSION, '1.0.0');
  assert.equal(V.VOL_LINE_CHARS, 120);
  assert.equal(V.VOL_WINDOW, 12);
  // 摘要那两级窗口的**值**住在这里：context.js 与 rules.js 读的是同一个数，
  // 谁再写一遍 12 / 24，两处就从此各长各的。
  assert.equal(V.RECAP_FINE, 12);
  assert.equal(V.RECAP_MID, 24);
  assert.equal(NWContext.RECAP_ITEMS, V.RECAP_FINE, 'context.js 里的别名断了');
  assert.equal(NWContext.RECAP_MID, V.RECAP_MID, 'context.js 里的别名断了');
  const p = V.recapPlan({ chapters: mk(FINE + MID + 3), volumes: [] });
  assert.deepEqual([p.counts.fine, p.counts.titles, p.counts.uncovered], [FINE, MID, 3],
    '不传 fine / mid 时走的必须是这两个默认值');
});
