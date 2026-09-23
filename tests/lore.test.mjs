import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NovelLLM, NWStory, NWContext, NWText, NWProject, repoPath } from './_load.mjs';

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

// ═══════════════ M 族：世界书递归触发（第 2 层从已注入条目的正文里再命中）═══════════════

const chain = () => [
  wb({ id: 'wb-a', name: '青雾山', description: '山门三千阶，终年大雾。' }),
  wb({ id: 'wb-b', name: '山门', description: '刻着守拙二字，背后是试剑石。' }),
  wb({ id: 'wb-c', name: '试剑石', description: '裂了三瓣。' }),
];

test('递归触发：正文点了 A，A 的设定里点了 B，B 也进来，并记下是谁带的', () => {
  const r = NWStory.loreTrigger('他踏上青雾山的石阶。', chain());
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-a', 'wb-b']);
  assert.equal(r.entries[0].loreRound, 1);
  assert.equal(r.entries[1].loreRound, 2);
  assert.deepEqual(r.entries[1].draggedBy, ['青雾山'], '要说清这条不是正文点名的，是设定带出来的');
});

test('只递归到声明的层数：三跳不发生（顺着一串设定把整本书拖进 prompt 是灾难）', () => {
  const r = NWStory.loreTrigger('他踏上青雾山的石阶。', chain());
  assert.equal(r.entries.some((e) => e.id === 'wb-c'), false, '试剑石要靠第 3 层才命中，不该出现');
});

test('关掉 recursive 就是原来的单层扫描', () => {
  const r = NWStory.loreTrigger('他踏上青雾山的石阶。', chain(), { recursive: false });
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-a']);
});

test('被额度裁掉的条目不许当二跳的来源：它的内容模型根本没看到', () => {
  const list = [
    wb({ id: 'wb-a', name: '青雾山', description: `${'山道'.repeat(30)}上有山门` }),
    wb({ id: 'wb-d', name: '黑水泽', description: '泽。' }),
    wb({ id: 'wb-b', name: '山门', description: '门。' }),
  ];
  // a 太大挤不进去，而只有 a 的正文里写着「山门」。
  // 若拿「命中但被裁掉」的 a 去带同乡，b 会凭空出现在 prompt 里。
  const r = NWStory.loreTrigger('青雾山 黑水泽', list, { loreBytes: 40 });
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-d']);
  assert.deepEqual(r.dropped, ['wb-a']);
  assert.equal(r.entries.some((e) => e.id === 'wb-b'), false, '山门只出现在没被注入的那条设定里，不该进来');
});

test('二跳不抢一跳的额度：层数先于 priority，第 1 层没挤满才轮到第 2 层', () => {
  const list = [
    wb({ id: 'wb-z', name: '镇碑', description: '无字。', priority: 99 }),
    wb({ id: 'wb-a', name: '青雾山', description: `${'雾'.repeat(10)}。` }),
    wb({ id: 'wb-d', name: '黑水泽', description: `泽底压着镇碑。${'水'.repeat(10)}` }),
  ];
  const sizes = ['wb-a', 'wb-d', 'wb-z'].map((id) => {
    const e = list.find((x) => x.id === id);
    return NWText.bytesOf(`【${e.name}】${e.description}`);
  });
  const budget = sizes[0] + sizes[1];   // 刚好只够两条第 1 层命中的
  const r = NWStory.loreTrigger('青雾山 黑水泽', list, { loreBytes: budget });
  assert.deepEqual(r.entries.map((e) => `${e.id}#${e.loreRound}`), ['wb-a#1', 'wb-d#1'],
    'priority 99 的镇碑排在第 1 层两条之后，于是挤不进来');
  assert.deepEqual(r.dropped, ['wb-z'], '让位要报出来，不许静默消失');
});

test('二跳挤不进额度时如实报 dropped，不许静默消失', () => {
  const list = [
    wb({ id: 'wb-a', name: '青雾山', description: '山门三千阶。' }),
    wb({ id: 'wb-b', name: '山门', description: 'z'.repeat(400) }),
  ];
  const r = NWStory.loreTrigger('青雾山', list, { loreBytes: 60 });
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-a']);
  assert.deepEqual(r.dropped, ['wb-b']);
});

test('设定互相引用不许死循环，也不许同一条注入两遍', () => {
  const list = [
    wb({ id: 'wb-a', name: '青雾山', description: '山门与试剑石都在此。' }),
    wb({ id: 'wb-b', name: '山门', description: '青雾山的山门，望得见试剑石。' }),
    wb({ id: 'wb-c', name: '试剑石', description: '山门背后。' }),
  ];
  // b、c 都由 a 带出，算第 2 层
  const r = NWStory.loreTrigger('青雾山', list);
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-a', 'wb-b', 'wb-c']);
  assert.deepEqual(r.entries.map((e) => e.loreRound), [1, 2, 2]);
  assert.equal(new Set(r.entries.map((e) => e.id)).size, r.entries.length);

  // 真正会重复的那一种：正文同时点了两条，而其中一条的设定里又提到另一条。
  // 第 2 层的扫描文本正是第 1 层注入进来的内容，所以「已注入」的条目必然再次命中 —— 必须跳过。
  const twice = NWStory.loreTrigger('青雾山的山门下站着人', [
    wb({ id: 'wb-a', name: '青雾山', description: '山门三千阶。' }),
    wb({ id: 'wb-b', name: '山门', description: '刻着守拙。' }),
  ]);
  assert.deepEqual(twice.entries.map((e) => `${e.id}#${e.loreRound}`), ['wb-a#1', 'wb-b#1'],
    `实得 ${twice.entries.map((e) => e.id).join(',')} —— 第 2 层把已注入的又加了一遍，还多占一次额度`);
});

test('selective 条目在二跳同样要主副键齐命中', () => {
  const list = [
    wb({ id: 'wb-a', name: '青雾山', description: '山门三千阶。' }),
    wb({ id: 'wb-b', name: '石阶', secondary_keys: ['不存在'], selective: true, description: '青石。' }),
  ];
  assert.deepEqual(NWStory.loreTrigger('青雾山', list).entries.map((e) => e.id), ['wb-a']);
});

test('constant 条目无条件在场，且第 1 层收齐后二跳不会再重复收', () => {
  const list = [
    wb({ id: 'wb-r', name: '灵气九境', type: 'rule', description: '不可逾越。' }),
    wb({ id: 'wb-x', name: '雾', description: '水汽。' }),
  ];
  const r = NWStory.loreTrigger('与设定无关的一句话', list);
  assert.deepEqual(r.entries.map((e) => e.id), ['wb-r']);
});

test('守卫：_index.json 写的扫描配置必须等于引擎真做的', async () => {
  const cfg = NWStory.loreIndexConfig();
  // 1) 值来自常量，且 recursive 与「默认能不能二跳」一致
  assert.equal(cfg.recursive_scanning, true);
  assert.equal(cfg.scan_depth, NWStory.LORE_RECURSION.rounds);
  assert.equal(cfg.token_budget, Math.round(NWStory.LORE_BUDGET.loreBytes / 3),
    'token_budget 必须是字节额度的换算，不许又变成一个孤立字面量');
  const canCascade = NWStory.loreTrigger('青雾山', chain()).entries.length > 1;
  assert.equal(canCascade, cfg.recursive_scanning, '声明递归就必须真能递归');
  const deepest = Math.max(...NWStory.loreTrigger('青雾山', [
    ...chain(), wb({ id: 'wb-z', name: '裂', description: '痕。' }),
  ]).entries.map((e) => e.loreRound));
  assert.ok(deepest <= cfg.scan_depth, `实际扫到第 ${deepest} 层，超过声明的 ${cfg.scan_depth}`);
  // 2) 两份 exporter 都不许再手抄字面量
  for (const [f, label] of [['src/core/project.js', 'Web 导出'], ['scripts/lib/book.mjs', 'CLI 存盘']]) {
    const src = readFileSync(repoPath(...f.split('/')), 'utf8');
    assert.ok(src.includes('loreIndexConfig()'), `${label} 必须用 loreIndexConfig() 派生`);
    assert.equal(/scan_depth:\s*\d/.test(src), false, `${label} 又写回了字面量 scan_depth`);
  }
  // 3) 真导出的那份文件里，三个字段逐项相等
  const ctx = NWStory.buildCtx({
    novel: { id: 'novel_m', title: '烟火纪', genre: '仙侠', word_count: 0, chapter_count: 1 },
    chapters: [{ id: 'ch_a', order: 1, title: '山门', content: '起' }],
    characters: [], world: [wb({})], promises: [], timeline: [], suppressions: [],
  });
  const tree = await NWProject.buildProjectTree(ctx);
  const key = Object.keys(tree).find((k) => k.endsWith('bible/world/_index.json'));
  const idx = JSON.parse(tree[key]);
  assert.deepEqual(
    { scan_depth: idx.scan_depth, token_budget: idx.token_budget, recursive_scanning: idx.recursive_scanning },
    cfg);
});
