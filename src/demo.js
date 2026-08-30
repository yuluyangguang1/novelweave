/**
 * NovelWeave · 织文 — 示例书（首启无 Key 也能玩）
 *
 * 为什么要有它：访客点进「进入织文」原本只看到一个索要 API Key 的空表单，
 * 等于把产品最值钱的部分（结构化状态 + 机器连续性检查）全藏起来了。
 * 示例书让这一切在不配 Key 的情况下当场可玩：续写 / 润色才需要 Key，
 * 状态矩阵、伏笔、时间线、连续性检查全部本地跑。
 *
 * 内容是一本能自检的小书：4 章带足量正文与摘要、3 个角色（其一已故）、
 * 世界条目、一条未收伏笔、时间线锚点、分章状态矩阵。
 * 它刻意保持「0 个 error」，但带一条未收伏笔与一个未建档人名（灰衣人），
 * 让连续性与未结线索面板有真实内容可看，又不显得这本示例是坏的。
 * 正文事实与角色卡 / 状态矩阵严格对齐 —— 这本身就是给用户看的示范：
 * 第 3、4 章里明长老只能被提及，不能行动，因为状态矩阵里他已死亡。
 *
 * 数据用固定 id 写进 IndexedDB（putRow 尊重给定主键），删了可再载入。
 * 注意：seed 只在库里没有示例书时执行；老用户删掉示例书重新载入即可拿到新版。
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
      '明长老把半枚铜印塞进林烟火手里的时候，山上的雾正从三千阶下漫上来。\n\n'
      + '「收好。」他说，「火漆对上的那一天，你再来问我。」\n\n'
      + '林烟火低头看那半枚铜印。断口参差，边缘被岁月磨得发乌，握在掌心却沉得出奇。他张了张嘴，想问是什么东西，明长老已经转身往山门里走，背影被雾一层层地吃掉。\n\n'
      + '「师父——」\n\n'
      + '「不可下山。」雾里传来最后一句，「记住，不可下山。」\n\n'
      + '林烟火在原地站到天黑。铜印贴着掌心，起初是凉的，不知什么时候开始，微微地烫了起来。他把铜印揣进怀里，那点烫意隔着衣衫，一下一下，像有什么东西在里面跳。\n\n'
      + '那一夜他没睡。他数着更声，数到三更，忽然想起一件事：师父只说不可下山，却没说，山上出了什么事。',

      '核心事件：明长老拒林烟火下山，塞下半枚铜印\n出场角色：明长老、林烟火\n状态变化：铜印入林烟火之手；铜印遇体温发烫\n新埋或回收的伏笔：埋下半枚铜印与"火漆对上"之约');

    await ch('ch-002', 2, '夜袭',
      '夜里火起。\n\n'
      + '林烟火是被烟呛醒的。推开门，半座山门已经陷在火里，火星子被山风卷着，噼啪砸在廊柱上。他逆着逃火的人流往里冲，吼师父的名字，声音很快被噼啪的火声吞掉。\n\n'
      + '他在三千阶前找到了明长老。\n\n'
      + '老人倒在阶前，胸口插着半截断刃，血在石阶上洇开，被雨水冲成一缕一缕的红。林烟火扑过去的时候，一只灰袖的手从火光里探出，快得根本看不清。\n\n'
      + '他抬起左臂挡下那一击，听见骨头裂开的声音。\n\n'
      + '疼是后来才到的。他跪在地上，抱着断了左臂，眼睁睁看着那个灰衣人从他身边掠过，脚步没有一点声音，也没有回头。火光落在那人的腰间——那里挂着一块火漆封着的旧物，封漆的纹样，和师父亲手压在经匣底层的那块一模一样。\n\n'
      + '「师父！」他嘶声喊。\n\n'
      + '明长老的手指动了动，指向山下，嘴唇翕动，却只吐出半个字。然后那只搭在林烟火手腕上的手，就凉了。\n\n'
      + '火一直到天亮才熄。林烟火拖着断臂跪在废墟里，把铜印攥得死紧。铜印烫得厉害，隔着血和灰，烫得像要烙进骨头里。火光尽头，那个灰衣人到底是谁？',

      '核心事件：夜袭，明长老战死，林烟火左臂断裂\n出场角色：林烟火、明长老、灰衣人\n状态变化：明长老死亡；林烟火左臂断裂；铜印遇血发烫加剧\n新埋或回收的伏笔：灰衣人现身，腰间火漆旧物与师门同源');

    await ch('ch-003', 3, '下山',
      '苏晚在山脚的雾里接住他。\n\n'
      + '「作死啊你，胳膊都断了。」她一边骂一边把药布缠上他的左臂，手法快得不像个开药铺的，倒像个打过仗的。三层药布缠完，血才算止住。\n\n'
      + '「师父不让你下山。」林烟火说。声音哑得不像自己的。\n\n'
      + '「师父？」苏晚的手顿了一下，「山下药铺二十年了，没见过你们山上的人下来。你师父叫什么？」\n\n'
      + '林烟火张了张嘴，发现自己竟答不上来。二十年，山门到山脚，不过三千阶，可山上的人从没下来过，山下的人也从没上去过。\n\n'
      + '「可你现在不下山，」苏晚把最后一圈药布收紧，扎了个结，「就没人查那把火了。」\n\n'
      + '林烟火用右手握紧怀里的铜印。它还在烫，一夜比一夜烫，像有另一颗心跳在里头，隔着十八年的铜锈，一下一下地撞他的掌心。\n\n'
      + '他回头望了一眼。青雾山在雾里只剩一个模糊的影子，三千阶隐没不见，像从没有人从那里走下来过。\n\n'
      + '他跟着苏晚往山下走。每走一步，怀里的烫意就重一分——仿佛这半枚铜印认得路，仿佛它等这一天下了很久。可它究竟在催他去哪里？',

      '核心事件：林烟火下山，苏晚接应\n出场角色：林烟火、苏晚\n状态变化：林烟火位置转至山下；得知山门二十年与外界隔绝\n新埋或回收的伏笔：无');

    await ch('ch-004', 4, '旧账',
      '客栈的油灯结了花。苏晚把一张旧账摊在桌上，纸都脆了。\n\n'
      + '「十八年前的流水账，」她说，「我爹的。他生前记的东西乱，唯独这一页用火漆封着，说等山上有人下来再拆。」\n\n'
      + '林烟火的目光落在火漆上，呼吸停了半拍。\n\n'
      + '封漆的纹样，和那夜灰衣人腰间的旧物一模一样。他把铜印从怀里取出来，凑到火漆的印痕边——断口对断口，严丝合缝。\n\n'
      + '半枚铜印，和十八年前一页封死的旧账，出自同一枚印。\n\n'
      + '「这不可能。」苏晚的声音也低了，「这印痕是我爹亲手封的，那年你还没出生。」\n\n'
      + '铜印在桌上越烫越厉害，烫得桌面腾起一层白汽。林烟火按住它，指节发白。十八年前，山上，山下，一场夜火，一个再没回来的人——所有的线头都攥在手里，却没有一个结打得开。\n\n'
      + '「灰衣人是谁？」他问。\n\n'
      + '没有人回答。窗外有影一闪而过。\n\n'
      + '林烟火猛地抬头推窗，长街空空，灯笼在风里晃。可桌面上的铜印烫得几乎拿不住了——它在朝着一个方向烫。他顺着那个方向望去，长街尽头，县衙的方向，黑得像一口井。',

      '核心事件：火漆印痕与铜印断口对上，旧账揭出十八年前旧事\n出场角色：林烟火、苏晚\n状态变化：铜印断口与旧账火漆同源确认；铜印指向县衙方向\n新埋或回收的伏笔：无');

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
      personality: '利落', appearance: '青衫，背药篓', background: '山下药铺，苏老板之女',
      notes: '', status: 'alive', 'died-in': null, first: 'ch-003',
      aliases: [], appearance_tokens: [], enabled: true, created_at: now,
    });

    await DB.putRow('worldbuilding', {
      id: 'wb-shan', novel_id: DEMO_ID, type: 'location', name: '青雾山',
      description: '终年大雾，山门三千阶。', details: {},
      keys: ['青雾山', '山门'], secondary_keys: [], constant: false, selective: false,
      content: '终年大雾，山门三千阶，雾散时可见旧石阶。山上的人二十年不曾下山，山下的人也从不上去。', created_at: now,
    });
    await DB.putRow('worldbuilding', {
      id: 'wb-yin', novel_id: DEMO_ID, type: 'custom', name: '半枚铜印',
      description: '断口参差，另半枚下落不明；遇火则烫。', details: {},
      keys: ['铜印'], secondary_keys: [], constant: false, selective: false,
      content: '半枚铜印，断口参差，另半枚下落不明；遇火则烫。断口与十八年前苏家旧账的火漆印痕同源。', created_at: now,
    });
    await DB.putRow('worldbuilding', {
      id: 'wb-zhang', novel_id: DEMO_ID, type: 'custom', name: '火漆旧账',
      description: '苏晚之父封存的十八年前流水账。', details: {},
      keys: ['旧账', '火漆'], secondary_keys: [], constant: false, selective: false,
      content: '苏晚父亲生前用火漆封死的一页流水账，封漆纹样与灰衣人腰间旧物、半枚铜印同源。封账那年在林烟火出生之前。', created_at: now,
    });

    await DB.putRow('promises', {
      id: 'p-yin', novel_id: DEMO_ID, type: 'promise', title: '半枚铜印',
      status: 'planted', weight: 'major',
      setup: { chapter: 'ch-001', evidence: '师父塞给我；火漆对上的那一天，你再来问我' },
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
    await st('ch-002', 'char-lin', '山门', 'alive', ['左臂断裂'], ['半枚铜印'], ['师父死于夜袭', '灰衣人腰间有火漆旧物'], '查夜火');
    await st('ch-003', 'char-lin', '山下', 'alive', ['左臂断裂'], ['半枚铜印'], ['苏晚愿同行', '山门二十年与外界隔绝'], '查夜火');
    await st('ch-003', 'char-su', '山下', 'alive', [], ['火漆旧账'], ['父亲封存旧账等山上人来'], '查父亲遗事');
    await st('ch-004', 'char-lin', '客栈', 'alive', ['左臂断裂'], ['半枚铜印'], ['火漆印痕对得上', '旧账封于十八年前'], '追灰衣人');
    await st('ch-004', 'char-su', '客栈', 'alive', [], ['火漆旧账'], ['铜印与火漆同源'], '查父亲遗事');

    await DB.recountNovelStats(DEMO_ID);
    return DEMO_ID;
  }

  root.NWDemo = { seed, isDemo, DEMO_ID };
  if (typeof module === 'object' && module.exports) module.exports = { seed, isDemo, DEMO_ID };
})(typeof globalThis !== 'undefined' ? globalThis : this);
