import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWContext, NWRules, NWSelfCheck, NWStory, NovelLLM } from './_load.mjs';

// ═══════════════ 夹具 ═══════════════

// 960 字、无钩子词的"平淡正文"——够 R17 的 800 字门槛，结尾也不含悬念标记
const PLAIN = '他往前走着，山道蜿蜒，两侧的松柏静静立着。'.repeat(60);
// 夹带"风格锚点"的正文：锚点放在约 30% 处，风格样例从中段节选时必然带上
const STYLED = '前'.repeat(250) + '风格锚点甲句。山影在他背后慢慢合拢。' + '后'.repeat(400);

function rows(overrides = {}) {
  return {
    novel: { id: 'novel_g', title: '问剑', genre: '仙侠', description: '少年出山' },
    chapters: [
      { id: 'ch-001', order: 1, title: '山门', content: STYLED },
      { id: 'ch-002', order: 2, title: '夜行', content: PLAIN },
      { id: 'ch-003', order: 3, title: '下山', content: '' },
    ],
    characters: [
      { id: 'c_ming', name: '明长老', role: '反派', status: 'deceased', 'died-in': 'ch-001' },
      { id: 'c_lin', name: '林烟火', role: '主角', status: 'alive' },
    ],
    promises: [
      { id: 'p_seal', type: 'promise', title: '半枚铜印的下落', status: 'planted',
        setup: { chapter: 'ch-002', evidence: '他在裂缝里摸到半枚铜印' },
        payoff: { due: 'ch-002' } },
    ],
    world: [], suppressions: [], states: [], timeline: [],
    ...overrides,
  };
}

function sectionNames(built) {
  return built.sections.map((s) => s.name);
}

// ═══════════════ 硬禁令 ═══════════════

test('硬禁令：死者与逾期伏笔钉在最前一节，预算再紧也先保它', () => {
  const ctx = NWStory.buildCtx(rows());
  const built = NWContext.buildSections(ctx, { chapterId: 'ch-003' });
  const names = sectionNames(built);
  assert.equal(names[0], '硬禁令', '硬禁令必须是第一节');
  const ban = built.sections.find((s) => s.name === '硬禁令');
  assert.match(ban.text, /明长老（卒于 ch-001）/, '死者名单要带死亡章');
  assert.match(ban.text, /半枚铜印的下落/, '逾期伏笔要列出');
  assert.match(ban.text, /期限 ch-002/, '期限要可读');
});

test('硬禁令：没有死者与到期伏笔时不占预算（节直接不存在）', () => {
  const ctx = NWStory.buildCtx(rows({
    characters: [{ id: 'c_lin', name: '林烟火', role: '主角', status: 'alive' }],
    promises: [],
  }));
  const built = NWContext.buildSections(ctx, { chapterId: 'ch-003' });
  assert.ok(!sectionNames(built).includes('硬禁令'));
});

// ═══════════════ 风格样例 ═══════════════

test('风格样例：opts.style 开启时注入，从上一章中段节选并带章名', () => {
  const ctx = NWStory.buildCtx(rows());
  const built = NWContext.buildSections(ctx, { chapterId: 'ch-003', style: true });
  const names = sectionNames(built);
  assert.ok(names.includes('风格样例'));
  const style = built.sections.find((s) => s.name === '风格样例');
  assert.match(style.text, /风格锚点甲句/, '节选要带作者正文的真实句子');
  assert.match(style.text, /第1章《山门》/, '样例要标来源章');
  assert.equal(names[names.length - 1], '风格样例', '风格样例是软上下文，排最末先被裁');
});

test('风格样例：默认关闭 —— 不传 style 就不注入，旧行为不变', () => {
  const ctx = NWStory.buildCtx(rows());
  const built = NWContext.buildSections(ctx, { chapterId: 'ch-003' });
  assert.ok(!sectionNames(built).includes('风格样例'));
  const usage = built.usage.sections.find((s) => s.name === '风格样例');
  assert.equal(usage, undefined);
});

// ═══════════════ R17 章末钩子 ═══════════════

test('R17：结尾平淡且本章未埋伏笔 → info 提示', () => {
  const ctx = NWStory.buildCtx(rows({ promises: [] }));
  const diags = NWRules.runRules(ctx, { only: ['chapter-end-hook'] });
  const hit = diags.find((d) => d.rule === 'chapter-end-hook' && d.chapter === 'ch-002');
  assert.ok(hit, 'ch-002 平淡收尾该被点名');
  assert.equal(hit.severity, 'info', '钩子质量无法机器判定，恒为 info');
  assert.match(hit.message, /ch-002/);
});

test('R17：结尾有悬念标记或本章新埋伏笔 → 不提示', () => {
  const hooked = rows({
    chapters: [
      { id: 'ch-001', order: 1, title: '山门', content: STYLED },
      { id: 'ch-002', order: 2, title: '夜行', content: PLAIN + '突然，身后传来一声轻响？' },
    ],
    promises: [],
  });
  const diags = NWRules.runRules(NWStory.buildCtx(hooked), { only: ['chapter-end-hook'] });
  assert.ok(!diags.some((d) => d.chapter === 'ch-002'), '问号 + 突转词在结尾窗口内，不该报');

  const planted = rows();
  const diags2 = NWRules.runRules(NWStory.buildCtx(planted), { only: ['chapter-end-hook'] });
  assert.ok(!diags2.some((d) => d.chapter === 'ch-002'), '本章新埋伏笔本身就是钩子');
});

test('R17：短章与豁免章（flashback）不评', () => {
  const short = rows({
    chapters: [
      { id: 'ch-001', order: 1, title: '山门', content: '太短了。' },
      { id: 'ch-002', order: 2, title: '夜行', content: PLAIN, flags: ['flashback'] },
    ],
    promises: [],
  });
  const diags = NWRules.runRules(NWStory.buildCtx(short), { only: ['chapter-end-hook'] });
  assert.equal(diags.filter((d) => d.rule === 'chapter-end-hook').length, 0);
});

// ═══════════════ 生成后自检 ═══════════════

test('runSelfCheck：草稿让死者开口 → 转成可执行的 error 诊断', () => {
  const ctx = NWStory.buildCtx(rows());
  const draft = '林烟火走进大堂。明长老说道："你终于来了。"两人相视而立。' + '。'.repeat(50);
  const sc = NWSelfCheck.runSelfCheck(ctx, { chapterId: 'ch-003', draft });
  const r1 = sc.actionable.find((d) => d.rule === 'dead-character-on-stage');
  assert.ok(r1, '死者行动必须被抓到');
  assert.equal(r1.severity, 'error');
  assert.equal(sc.draftChapterId, 'ch-003');
});

test('runSelfCheck：next 模式 —— 草稿作为临时章挂到书尾参与检查', () => {
  const ctx = NWStory.buildCtx(rows());
  const draft = '林烟火走进大堂。明长老说道："你终于来了。"两人相视而立。' + '。'.repeat(50);
  const sc = NWSelfCheck.runSelfCheck(ctx, { chapterId: 'next', draft, nextTitle: '试笔' });
  assert.equal(sc.draftChapterId, 'ch-draft');
  assert.ok(sc.actionable.some((d) => d.rule === 'dead-character-on-stage'));
});

test('runSelfCheck：干净草稿 → actionable 为空；书里既有的陈年问题不算草稿的账', () => {
  const ctx = NWStory.buildCtx(rows());
  const draft = '林烟火独自下山，夜色像水一样漫过肩头。' + '。'.repeat(50);
  const sc = NWSelfCheck.runSelfCheck(ctx, { chapterId: 'ch-003', draft });
  assert.equal(sc.actionable.length, 0);
  // 夹具里那条逾期伏笔是书的既有问题（基线），不触发本章自修轮，
  // 但仍出现在完整诊断里如实上报
  assert.ok(sc.diags.some((d) => d.rule === 'promise-overdue'));
  assert.ok(!sc.actionable.some((d) => d.rule === 'promise-overdue'));
});

test('runSelfCheck：空草稿直接短路', () => {
  const ctx = NWStory.buildCtx(rows());
  const sc = NWSelfCheck.runSelfCheck(ctx, { chapterId: 'ch-003', draft: '  ' });
  assert.deepEqual(sc.actionable, []);
  assert.equal(sc.draftChapterId, null);
});

test('buildRevisePrompt：诊断要变成带编号的修订指令，且携带原文', () => {
  const ctx = NWStory.buildCtx(rows());
  const draft = '林烟火走进大堂。明长老说道："你终于来了。"';
  const sc = NWSelfCheck.runSelfCheck(ctx, { chapterId: 'ch-003', draft });
  const prompt = NWSelfCheck.buildRevisePrompt(draft, sc.actionable);
  assert.match(prompt, /【问题清单】/);
  assert.match(prompt, /dead-character-on-stage/);
  assert.match(prompt, /最小改动/);
  assert.match(prompt, /林烟火走进大堂/, '草稿原文必须整段携带');
});

// ═══════════════ 短篇模式（format: short） ═══════════════

test('短篇：buildCtx 把 format 带进 ctx.book，默认长篇', () => {
  const short = NWStory.buildCtx(rows({ novel: { id: 'n', title: '问剑', genre: '仙侠', description: '', format: 'short' } }));
  const long = NWStory.buildCtx(rows());
  assert.equal(short.book.format, 'short');
  assert.equal(long.book.format, 'long');
});

test('短篇：前情摘要不封顶 —— 14 章全列出，长篇三级衰减不丢锚点', () => {
  const many = [];
  for (let i = 1; i <= 14; i++) {
    many.push({ id: `ch-${String(i).padStart(3, '0')}`, order: i, title: `第${i}章`, content: '正文。', summary: `核心事件：第${i}章的事` });
  }
  many.push({ id: 'ch-015', order: 15, title: '现在', content: '' });

  const shortCtx = NWStory.buildCtx(rows({
    novel: { id: 'n', title: '问剑', genre: '仙侠', description: '', format: 'short' },
    chapters: many,
  }));
  const longCtx = NWStory.buildCtx(rows({ chapters: many }));

  const shortRecap = NWContext.buildSections(shortCtx, { chapterId: 'ch-015' })
    .sections.find((s) => s.name === '前情摘要').text;
  const longRecap = NWContext.buildSections(longCtx, { chapterId: 'ch-015' })
    .sections.find((s) => s.name === '前情摘要').text;

  assert.ok(!shortRecap.includes('更早'), '短篇摘要全量列出，没有"更早 N 章"');
  assert.ok(shortRecap.includes('第1章的事'), '第 1 章也在');
  assert.match(longRecap, /更早 2 章：/, '长篇超出窗口的章节降级为章名行，不再"未列出"');
  assert.match(longRecap, /第1章《第1章》/, '章名锚点必须可见');
});

test('前情摘要三级衰减：12 细 / 24 章名 / 更早只报数量', () => {
  const many = [];
  for (let i = 1; i <= 40; i++) {
    many.push({ id: `ch-${String(i).padStart(3, '0')}`, order: i, title: `事件${i}`, content: '正文。', summary: `核心事件：第${i}件事` });
  }
  many.push({ id: 'ch-041', order: 41, title: '现在', content: '' });
  const ctx = NWStory.buildCtx(rows({ chapters: many }));
  const recap = NWContext.buildSections(ctx, { chapterId: 'ch-041' })
    .sections.find((s) => s.name === '前情摘要').text;

  const fullCount = (recap.match(/- 第\d+章《事件\d+》：/g) || []).length;
  assert.equal(fullCount, 12, '细摘要恰好 12 行');
  assert.ok(recap.includes('更早 24 章：第5章《事件5》'), '中间层 24 章名一行列出（第5章起）');
  assert.ok(recap.includes('第28章《事件28》）'), '中间层到第 28 章止');
  assert.ok(recap.includes('更早 4 章，需要时回读原章'), '最老 4 章只报数量');
});

test('R17 短篇阈值：400 字章节长篇不评、短篇评', () => {
  const body = '平淡叙事。'.repeat(66) + '灯灭了。'; // ~330 字 + 钩子词被去掉
  const noHook = (fmt) => {
    const r = rows({
      novel: { id: 'n', title: '问剑', genre: '仙侠', description: '', format: fmt },
      chapters: [{ id: 'ch-001', order: 1, title: '一', content: body }],
      promises: [],
    });
    return NWRules.runRules(NWStory.buildCtx(r), { only: ['chapter-end-hook'] });
  };
  assert.ok(!noHook('long').some((d) => d.rule === 'chapter-end-hook'), '长篇 800 字门槛，不评');
  assert.ok(noHook('short').some((d) => d.rule === 'chapter-end-hook' && d.severity === 'info'), '短篇 300 字门槛，评出 info');
});

test('R17 短篇：提示语知道自己是短篇', () => {
  const body = '平淡叙事。'.repeat(66);
  const r = rows({
    novel: { id: 'n', title: '问剑', genre: '仙侠', description: '', format: 'short' },
    chapters: [{ id: 'ch-001', order: 1, title: '一', content: body }],
    promises: [],
  });
  const diags = NWRules.runRules(NWStory.buildCtx(r), { only: ['chapter-end-hook'] });
  const hit = diags.find((d) => d.rule === 'chapter-end-hook');
  assert.ok(hit.suggestion.includes('屏末'), '短篇的钩子话术应该是"屏末"');
});

// ═══════════════ R18 物品失而复得 ═══════════════

test('R18：物品连续缺席后重现 → info 提示', () => {
  const many = [];
  for (let i = 1; i <= 5; i++) {
    many.push({ id: `ch-${String(i).padStart(3, '0')}`, order: i, title: `第${i}章`, content: '正文。', summary: '' });
  }
  const st = (ch, items) => ({ id: `ch-${String(ch).padStart(3, '0')}|c_lin`, chapter: `ch-${String(ch).padStart(3, '0')}`, entity: 'c_lin', loc: '', alive: 'alive', injury: [], items, knows: [], goal: '' });
  const r = rows({
    chapters: many,
    characters: [{ id: 'c_lin', name: '林烟火', role: '主角', status: 'alive' }],
    states: [st(1, ['铜印']), st(2, ['铜印']), st(3, []), st(4, []), st(5, ['铜印'])],
  });
  const diags = NWRules.runRules(NWStory.buildCtx(r), { only: ['item-reappear'] });
  const hit = diags.find((d) => d.rule === 'item-reappear');
  assert.ok(hit, '缺席后重现要提示');
  assert.equal(hit.severity, 'info', '矩阵没记不等于物品不存在，恒为 info');
  assert.match(hit.message, /铜印/);
});

test('R18：物品一直在持有 → 不提示', () => {
  const many = [];
  for (let i = 1; i <= 5; i++) {
    many.push({ id: `ch-${String(i).padStart(3, '0')}`, order: i, title: `第${i}章`, content: '正文。', summary: '' });
  }
  const st = (ch, items) => ({ id: `ch-${String(ch).padStart(3, '0')}|c_lin`, chapter: `ch-${String(ch).padStart(3, '0')}`, entity: 'c_lin', loc: '', alive: 'alive', injury: [], items, knows: [], goal: '' });
  const r = rows({
    chapters: many,
    characters: [{ id: 'c_lin', name: '林烟火', role: '主角', status: 'alive' }],
    states: [st(1, ['铜印']), st(2, ['铜印']), st(3, ['铜印']), st(4, ['铜印']), st(5, ['铜印'])],
  });
  const diags = NWRules.runRules(NWStory.buildCtx(r), { only: ['item-reappear'] });
  assert.equal(diags.filter((d) => d.rule === 'item-reappear').length, 0);
});

// ═══════════════ AI 起书（长篇从零向导） ═══════════════

test('AI 长篇起书 prompt：带想法 / 卷数 / 世界与卷纲要求', () => {
  const p = NovelLLM.buildLongConceptPrompt({ idea: '扫地少年与无面石像', genre: '玄幻', volumes: 3 });
  assert.match(p, /扫地少年与无面石像/);
  assert.match(p, /约 3 卷/);
  assert.match(p, /卷纲 3 卷/);
  assert.match(p, /世界设定 2-4 条/);
  assert.match(p, /只输出一个 JSON/);
});

test('parseConceptJSON：world 与 volumes 一并解析（长篇骨架）', () => {
  const raw = '```json\n{"title":"长篇","logline":"x","characters":[],"world":[{"name":"青雾山","content":"大雾"}],"volumes":[{"title":"卷一","summary":"出山"}],"chapters":[{"title":"第一章","beat":"出场"}]}\n```';
  const c = NovelLLM.parseConceptJSON(raw);
  assert.equal(c.world.length, 1);
  assert.equal(c.world[0].name, '青雾山');
  assert.equal(c.volumes.length, 1);
  assert.equal(c.volumes[0].title, '卷一');
});

// ═══════════════ 相关旧章检索 ═══════════════

test('相关旧章：按出场分量召回窗口外旧章，苏晚的高光章被带回来', () => {
  const many = [];
  for (let i = 1; i <= 40; i++) {
    many.push({ id: `ch-${String(i).padStart(3, '0')}`, order: i, title: `事件${i}`, content: '正文。', summary: `核心事件：第${i}件事` });
  }
  // 第 5 章和第 20 章是"苏晚的往事高光章"（苏晚反复出现），在细摘要窗口(29-40)之外
  many[4] = { id: 'ch-005', order: 5, title: '药庐初见', content: ('苏晚教林烟火认药。').repeat(6), summary: '核心事件：苏晚与林烟火初见' };
  many[19] = { id: 'ch-020', order: 20, title: '并肩', content: ('苏晚替林烟火挡了一箭。').repeat(8), summary: '核心事件：苏晚为林烟火挡箭' };
  many.push({ id: 'ch-041', order: 41, title: '重逢', content: '', characters: [], summary: '核心事件：苏晚与林烟火重逢' });

  const ctx = NWStory.buildCtx(rows({
    chapters: many,
    characters: [
      { id: 'c_lin', name: '林烟火', role: '主角', status: 'alive' },
      { id: 'c_su', name: '苏晚', role: '配角', status: 'alive' },
    ],
  }));
  const built = NWContext.buildSections(ctx, { chapterId: 'ch-041' });
  const names = built.sections.map((s) => s.name);
  assert.ok(names.includes('相关旧章'), '相关旧章节要出现');

  const rel = built.sections.find((s) => s.name === '相关旧章');
  assert.match(rel.text, /第5章《药庐初见》/, '高光旧章要被召回');
  assert.match(rel.text, /与林烟火、苏晚相关/, '相关人物要标注');
  const usage = built.usage.sections.find((s) => s.name === '相关旧章');
  assert.ok(usage.present && usage.included.includes('第20章《并肩》'), 'usage 要如实列出召回了哪些');
});

test('相关旧章：细摘要窗口内与上一章不重复召回；短篇不启用', () => {
  const many = [];
  for (let i = 1; i <= 40; i++) {
    many.push({ id: `ch-${String(i).padStart(3, '0')}`, order: i, title: `事件${i}`, content: ('林烟火与苏晚同行。').repeat(4), summary: `核心事件：第${i}件事` });
  }
  many.push({ id: 'ch-041', order: 41, title: '重逢', content: '', summary: '' });
  const base = {
    chapters: many,
    characters: [
      { id: 'c_lin', name: '林烟火', role: '主角', status: 'alive' },
      { id: 'c_su', name: '苏晚', role: '配角', status: 'alive' },
    ],
  };
  // 长篇：召回的只能是窗口外(≤28)的章
  const longBuilt = NWContext.buildSections(NWStory.buildCtx(rows(base)), { chapterId: 'ch-041' });
  const rel = longBuilt.sections.find((s) => s.name === '相关旧章');
  if (rel) assert.ok(!/第3[0-9]章|第4[0-1]章/.test(rel.text), '窗口内的章不进相关旧章');
  // 短篇：全量前情已覆盖，不启用相关旧章
  const shortBuilt = NWContext.buildSections(NWStory.buildCtx(rows({
    novel: { id: 'n', title: '问剑', genre: '仙侠', description: '', format: 'short' },
    chapters: many,
    characters: base.characters,
  })), { chapterId: 'ch-041' });
  assert.ok(!shortBuilt.sections.some((s) => s.name === '相关旧章'), '短篇不启用相关旧章');
});

// ═══════════════ AI 起书（短篇从零向导） ═══════════════

test('AI 起书 prompt：带想法 / 流派 / 篇幅档，并强制只输出 JSON', () => {
  const p = NovelLLM.buildShortConceptPrompt({ idea: '外卖员的第 43 单', genre: '悬疑', structure: '反转流', tier: '标准（8k-15k 字，3-6 章）' });
  assert.match(p, /外卖员的第 43 单/);
  assert.match(p, /反转流/);
  assert.match(p, /8k-15k/);
  assert.match(p, /只输出一个 JSON/);
});

test('parseConceptJSON：容忍代码块围栏与前后废话', () => {
  const raw = '好的，这是梗概：\n```json\n{"title":"第43单","logline":"一单回乡","characters":[{"name":"陈皮","role":"主角","personality":"闷"}],"chapters":[{"title":"43单","beat":"地址是老家"}]}\n```\n希望有帮助';
  const c = NovelLLM.parseConceptJSON(raw);
  assert.equal(c.title, '第43单');
  assert.equal(c.chapters.length, 1);
  assert.equal(c.characters[0].name, '陈皮');
});

test('parseConceptJSON：缺书名或缺章节必须拒绝，不能带病建档', () => {
  assert.throws(() => NovelLLM.parseConceptJSON('{"title":"只有书名"}'), /章节/);
  assert.throws(() => NovelLLM.parseConceptJSON('我觉得这个故事不错'), /JSON/);
});
