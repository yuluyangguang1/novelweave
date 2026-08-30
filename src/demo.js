/**
 * NovelWeave · 织文 — 示例书（首启无 Key 也能玩）
 *
 * 为什么要有它：访客点进「进入织文」原本只看到一个索要 API Key 的空表单，
 * 等于把产品最值钱的部分（结构化状态 + 机器连续性检查）全藏起来了。
 * 示例书让这一切在不配 Key 的情况下当场可玩：续写 / 润色才需要 Key，
 * 状态矩阵、伏笔、时间线、连续性检查全部本地跑。
 *
 * 内容是一本能自检的小书：4 章带正文与摘要、3 个角色（其一已故）、
 * 世界条目、一条未收伏笔、时间线锚点、分章状态矩阵。
 * 它刻意保持「0 个 error」，但带一条未收伏笔与一个未建档人名，
 * 让连续性与未结线索面板有真实内容可看，又不显得这本示例是坏的。
 *
 * 数据用固定 id 写进 IndexedDB（putRow 尊重给定主键），删了可再载入。
 */
(function (root) {
  'use strict';

  const DEMO_ID = 'novel_demo';
  const isDemo = (id) => id === DEMO_ID;

  async function seed() {
    const DB = root.NovelDB;
    if (await DB.novels.get(DEMO_ID)) return DEMO_ID;
    const now = Date.now();

    await DB.putRow('novels', {
      id: DEMO_ID, title: '烟火纪（示例）', genre: '仙侠',
      description: '少年带着半枚铜印下山，查一场烧到师门的夜火。',
      word_count: 0, chapter_count: 0, created_at: now, updated_at: now,
    });

    const ch = (id, order, title, content, summary) => DB.putRow('chapters', {
      id, novel_id: DEMO_ID, title, content, summary,
      word_count: 0, order, created_at: now, updated_at: now,
    });
    await ch('ch-001', 1, '山门',
      '明长老把半枚铜印塞进林烟火手里，说不可下山。\n\n雾从三千阶下漫上来，明长老的影子很快就看不见了。林烟火在原地站到天黑。',
      '核心事件：明长老拒林烟火下山，塞半枚铜印\n出场角色：明长老、林烟火\n状态变化：铜印入林烟火之手\n新埋或回收的伏笔：埋下半枚铜印');
    await ch('ch-002', 2, '夜袭',
      '夜里火起。林烟火冲回山门时，明长老已经倒在阶前。\n\n他抬起左臂挡下那一击，听见骨头裂开的声音。灰衣人掠过火场，没有回头。',
      '核心事件：夜袭，明长老战死，林烟火断臂\n出场角色：林烟火、明长老、灰衣人\n状态变化：明长老死亡；林烟火左臂断裂\n新埋或回收的伏笔：灰衣人现身');
    await ch('ch-003', 3, '下山',
      '苏晚在山脚接住他，药布缠了三层。\n\n「师父不让你下山。」她说，「可你现在不下山，就没人查那把火了。」林烟火用右手握紧铜印。',
      '核心事件：林烟火下山，苏晚接应\n出场角色：林烟火、苏晚\n状态变化：林烟火位置转至山下\n新埋或回收的伏笔：无');
    // 第 4 章故意不填摘要：首页会标「摘缺」，教这个功能长什么样
    await ch('ch-004', 4, '旧账',
      '客栈里，苏晚把一张旧账摊开，火漆的印痕和铜印的断口对得上。\n\n窗外有人影一闪。林烟火按住铜印，它比往常烫。',
      '');

    await DB.putRow('characters', {
      id: 'char-lin', novel_id: DEMO_ID, name: '林烟火', role: '主角',
      personality: '沉默，认死理', appearance: '灰袍，左臂断后缠药布',
      background: '明长老唯一弟子', notes: '', status: 'alive',
      'died-in': null, first: 'ch-001', aliases: [], appearance_tokens: [
        { key: '断臂', since: 'ch-002', until: null },
      ], enabled: true, created_at: now,
    });
    await DB.putRow('characters', {
      id: 'char-ming', novel_id: DEMO_ID, name: '明长老', role: '导师',
      personality: '持重', appearance: '白眉', background: '守山门三十年',
      notes: '', status: 'deceased', 'died-in': 'ch-002', first: 'ch-001',
      aliases: [], appearance_tokens: [], enabled: true, created_at: now,
    });
    await DB.putRow('characters', {
      id: 'char-su', novel_id: DEMO_ID, name: '苏晚', role: '配角',
      personality: '利落', appearance: '青衫，背药篓', background: '山下药铺',
      notes: '', status: 'alive', 'died-in': null, first: 'ch-003',
      aliases: [], appearance_tokens: [], enabled: true, created_at: now,
    });

    await DB.putRow('worldbuilding', {
      id: 'wb-shan', novel_id: DEMO_ID, type: 'location', name: '青雾山',
      description: '终年大雾，山门三千阶。', details: {},
      keys: ['青雾山', '山门'], secondary_keys: [], constant: false, selective: false,
      content: '终年大雾，山门三千阶，雾散时可见旧石阶。', created_at: now,
    });
    await DB.putRow('worldbuilding', {
      id: 'wb-yin', novel_id: DEMO_ID, type: 'custom', name: '半枚铜印',
      description: '断口参差，另半枚下落不明；遇火则烫。', details: {},
      keys: ['铜印'], secondary_keys: [], constant: false, selective: false,
      content: '半枚铜印，断口参差，另半枚下落不明；遇火则烫。', created_at: now,
    });

    await DB.putRow('promises', {
      id: 'p-yin', novel_id: DEMO_ID, type: 'promise', title: '半枚铜印',
      status: 'planted', weight: 'major',
      setup: { chapter: 'ch-001', evidence: '师父塞给我' },
      payoff: { chapter: null, due: 'ch-004' }, characters: ['char-lin'],
      notes: '', created_at: now, updated_at: now,
    });

    await DB.putRow('timeline', { id: 'ev-1', novel_id: DEMO_ID, chapter: 'ch-001', label: '拒下山', day: 1, clock: '暮', thread: '主线', entities: ['char-lin', 'char-ming'], confidence: 'explicit', created_at: now });
    await DB.putRow('timeline', { id: 'ev-2', novel_id: DEMO_ID, chapter: 'ch-002', label: '夜袭', day: 1, clock: '夜', thread: '主线', entities: ['char-lin', 'char-ming'], confidence: 'explicit', created_at: now });
    await DB.putRow('timeline', { id: 'ev-3', novel_id: DEMO_ID, chapter: 'ch-003', label: '下山', day: 2, clock: '晨', thread: '主线', entities: ['char-lin', 'char-su'], confidence: 'explicit', created_at: now });
    await DB.putRow('timeline', { id: 'ev-4', novel_id: DEMO_ID, chapter: 'ch-004', label: '对火漆', day: 3, clock: '午', thread: '主线', entities: ['char-lin', 'char-su'], confidence: 'explicit', created_at: now });

    const st = (chapter, entity, loc, alive, injury, items, knows, goal) => DB.putRow('states', {
      id: `${chapter}|${entity}`, novel_id: DEMO_ID, chapter, entity,
      loc, alive, injury, items, knows, goal, updated_at: now,
    });
    await st('ch-002', 'char-ming', '山门', 'deceased', [], [], [], '');
    await st('ch-002', 'char-lin', '山门', 'alive', ['左臂断裂'], ['半枚铜印'], ['师父死于夜袭'], '查夜火');
    await st('ch-003', 'char-lin', '山下', 'alive', ['左臂断裂'], ['半枚铜印'], ['苏晚愿同行'], '查夜火');
    await st('ch-004', 'char-lin', '客栈', 'alive', ['左臂断裂'], ['半枚铜印'], ['火漆印痕对得上'], '追灰衣人');

    await DB.recountNovelStats(DEMO_ID);
    return DEMO_ID;
  }

  root.NWDemo = { seed, isDemo, DEMO_ID };
  if (typeof module === 'object' && module.exports) module.exports = { seed, isDemo, DEMO_ID };
})(typeof globalThis !== 'undefined' ? globalThis : this);
