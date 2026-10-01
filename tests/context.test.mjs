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

test('超出 12 章的前情降级为章名行，而不是静默丢掉', () => {
  const many = Array.from({ length: 16 }, (_, i) => ({
    id: 'ch_' + i, order: i + 1, title: '第' + (i + 1) + '章', content: '正文', summary: `事件${i + 1}`,
  }));
  many[15].content = '';
  const { text } = recapOf('ch_15', { chapters: many });
  assert.match(text, /更早 3 章：第1章《第1章》/, '窗口外的章降级为章名锚点，不再未列出');
  assert.ok(text.includes('- 第15章《第15章》：事件15'), '最近一章必须在');
  assert.ok(!text.includes('：事件3'), '章名层不带细摘要');
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

// ═══════════════ 卷级滚动压缩：「更早」那一段改由卷行说话 ═══════════════

function many40() {
  return Array.from({ length: 40 }, (_, i) => ({
    id: 'ch_' + i, order: i + 1, title: '第' + (i + 1) + '章', content: '正文', summary: `事件${i + 1}`,
  }));
}
const vol = (a, b, extra = {}) => ({
  id: `vol_${a}_${b}`, order: a, title: `卷${a}`,
  fromChapter: 'ch_' + a, toChapter: 'ch_' + b,
  summary: `第${a}到${b}章的往事`, ...extra,
});

test('建了卷：盖住的章不再逐章出章名，卷行一行替二十章说话', () => {
  const { text } = recapOf('ch_39', { chapters: many40(), volumes: [vol(0, 19)] });
  assert.match(text, /- 卷0（第 1–20 章·20 章）：第0到19章的往事/, '卷名、区间、章数、摘要齐备');
  assert.ok(!text.includes('第1章《第1章》'), '被卷盖住的章不该又在章名层出现');
  assert.match(text, /更早 7 章：第21章《第21章》/, '没盖住的 7 章照旧降级为章名');
  assert.ok(!text.includes('需要时回读原章'), '章名层装得下，就不该再报「更早 N 章未列」');
  assert.ok(text.includes('- 第39章《第39章》：事件39'), '窗口内最近一章必须在');
});

/** 折掉那一句是唯一交代「更早的卷去哪了」的话：只数层不说的话，作者以为那些卷被丢了。 */
test('超过注入上限的卷折成一行计数，这一行必须在 prompt 里说得出口', () => {
  const vols = Array.from({ length: 13 }, (_, i) => vol(i * 2, i * 2 + 1));
  const { text, built } = recapOf('ch_39', { chapters: many40(), volumes: vols });
  assert.equal(built.usage.recapTiers.folded, 1, '13 卷里折掉最老那一卷');
  assert.match(text, /（更早 1 卷、约 2 章已折）/);
  assert.match(text, /- 卷24（第 25–26 章·2 章）/, '留下的是最近那一卷');
  assert.ok(!text.includes('卷0（'), '折掉的卷不逐卷出行');
  assert.ok(!text.includes('缺口'), '已折不是缺口，别把上限内的正常行为报成缺陷');
});

test('没建卷的书一个字都不该变：卷层只加在「更早」那一段，不动 12/24/报数', () => {

  const { text } = recapOf('ch_39', { chapters: many40() });
  assert.match(text, /更早 3 章，需要时回读原章/, '今天最老那一级只报数');
  assert.ok(!text.includes('卷'), '没卷就不该出现卷的说法');
  assert.ok(!text.includes('缺口'), '没建卷不是有缺口，别去 nag 还没用这套东西的人');
});

test('空摘要的卷不许吞章：它盖住的 20 章退回原层级，并且说清为什么没压上', () => {
  const { text } = recapOf('ch_39', { chapters: many40(), volumes: [vol(0, 19, { summary: '   ' })] });
  assert.ok(!text.includes('卷0（'), '空卷不能出行');
  assert.match(text, /更早 \d+ 章：/, '章名层照旧');
  assert.match(text, /更早 3 章，需要时回读原章/, '退回没有卷时的降级');
  assert.match(text, /1 卷还没写摘要/, '要说得出这条缺口是哪种成因');
});

test('越过本章的卷不用它：那半卷剧情还没发生，用了就是剧透', () => {
  const { text } = recapOf('ch_39', { chapters: many40(), volumes: [vol(20, 39)] });
  assert.ok(!text.includes('卷20（'), '越前的卷不出行');
  assert.match(text, /1 卷越过本章/, '要说清是主动不用它，不是漏了');
});

test('分层数由 usage 报出来：界面与 CLI 不必照着常量自己数一遍', () => {
  const { built } = recapOf('ch_39', { chapters: many40(), volumes: [vol(0, 19)] });
  assert.deepEqual(built.usage.recapTiers, {
    head: 39, book: 1, fine: 12, titles: 7, volumes: 1, folded: 0, covered: 20, uncovered: 0, empty: 0, bad: 0, deferred: 0, overlaps: 0,
  });
  const sec = built.usage.sections.find((s) => s.name === '前情摘要');
  assert.deepEqual(sec.included, ['卷0'], '哪几卷进了 prompt 要能列出来');
});

test('短篇全量注入，卷层不参与：体量小，逐章摘要本来就装得下', () => {
  const ctx = NWStory.buildCtx({ ...rows({ chapters: many40() }), novel: { id: 'n', title: '烟火纪', format: 'short' } });
  const text = NWContext.buildSections(ctx, { chapterId: 'ch_39' })
    .sections.find((s) => s.name === '前情摘要').text;
  assert.equal(text.split('\n').length, 39, '39 章逐章列出，没有折叠行');
  assert.ok(!text.includes('更早'), '短篇没有"更早"这一级');
});

/**
 * 「不参与」必须是没喂进去，而不是「喂了但没画」。短篇的 cap 是 Infinity，
 * 整本都落在细摘要层，卷行确实一行都出不来 —— 但如果把卷照样喂进 recapPlan，
 * 盖到目标章那一卷会被判「越过本章」，于是 prompt 里凭空多出一句缺口：
 * 作者在短篇上建了卷，收到的是一条它根本不该有的提醒。
 */
test('短篇即使建了卷也不喂给摘要层：逐章 39 行，卷与缺口一个字都不出现', () => {
  const ctx = NWStory.buildCtx({
    ...rows({ chapters: many40(), volumes: [vol(0, 19), vol(35, 39)] }),
    novel: { id: 'n', title: '烟火纪', format: 'short' },
  });
  const built = NWContext.buildSections(ctx, { chapterId: 'ch_39' });
  const text = built.sections.find((s) => s.name === '前情摘要').text;
  assert.equal(text.split('\n').length, 39, '卷行一行都不该加进短篇的逐章列表');
  assert.ok(!text.includes('卷'), '短篇里不该出现卷的说法');
  assert.ok(!text.includes('缺口'), '没参与的卷不该被报成缺口');
  const t = built.usage.recapTiers;
  assert.equal(t.book, 0, '分层数字里卷那一层是空的：没喂进去，不是喂了没画');
  assert.equal(t.volumes, 0);
  assert.equal(t.covered, 0);
});

/**
 * 面板与 R33 走的是 recapPlanOf 这一个入口，所以「短篇不参与」得在这个入口也成立：
 * 喂进去再靠渲染层藏起来的话，盖到目标章之后的那一卷会被判「越过本章」，
 * 面板顶部与 prompt 里就凭空多出一句它根本没参与造成的缺口。
 */
test('recapPlanOf 在短篇里不喂卷：卷层是空的，不是算完再藏起来', () => {
  const short = NWContext.recapPlanOf(
    { book: { format: 'short' }, chapters: many40(), volumes: [vol(0, 19), vol(20, 39)] }, 'ch_20');
  assert.equal(short.counts.book, 0, '登记了两卷也不该进短篇的分层数');
  assert.deepEqual(short.volumes, []);
  assert.deepEqual(short.deferred, [], '不喂卷就不会冒出「越过本章」那句缺口');
  const long = NWContext.recapPlanOf({ book: {}, chapters: many40(), volumes: [vol(0, 19)] }, 'ch_20');
  assert.equal(long.counts.book, 1, '长篇照常喂，这一条不是把卷层整个关死');
});

test('多行摘要在库行与文件记录两种形状下哈希一致，否则导入必误报冲突', async () => {
  const dbRow = { id: 'ch_a', order: 1, title: '山门', content: '正文', summary: '核心事件：甲\n状态变化：乙' };
  const fileRow = { id: 'ch_a', number: 1, title: '山门', body: '正文', content: '正文', status: 'draft', summary: '核心事件：甲\n状态变化：乙' };
  assert.equal(await NWProject.hashRecord('chapter', dbRow), await NWProject.hashRecord('chapter', fileRow));
});

test('创作决策要一路走到 prompt：buildCtx 漏了它，界面记下的决定就永远进不了上下文', () => {
  const ctx = NWStory.buildCtx(rows({
    decisions: [
      { id: 'dec_a', title: '不让主角换城', reason: '保持主线紧凑', risk: '中', supersededBy: null },
      { id: 'dec_b', title: '第二人称试验', reason: '已放弃', supersededBy: 'dec_a' },
    ],
  }));
  const sec = NWContext.buildSections(ctx, { chapterId: 'ch_c' }).sections.find((s) => s.name === '创作决策');
  assert.ok(sec, '没有「创作决策」节');
  assert.equal(sec.text, '- 不让主角换城：保持主线紧凑（风险：中）');
});

test('一条决策都没有时不留空节', () => {
  const names = NWContext.buildSections(NWStory.buildCtx(rows()), { chapterId: 'ch_c' }).sections.map((s) => s.name);
  assert.ok(!names.includes('创作决策'), names.join(','));
});
