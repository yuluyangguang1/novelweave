/**
 * 选题评分卡（src/core/pitch.js）单元测试。
 *
 * 这张卡的每条判据都是拍脑袋的锚 —— 允许，但必须钉死：改一个阈值就要连测试一起改，
 * 否则过几个月没人记得「单章 4000 字」是从哪来的。
 * 所以每个维度都成对写夹具：得分那一支与扣分那一支各一条，
 * 删掉实现里任何一条分支，必须有一项测试变红（不是「覆盖到那行」，是「删了要红」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWPitch, NWTension, NWText } from './_load.mjs';

const P = NWPitch;

function dim(res, id) {
  const d = res.dims.find((x) => x.id === id);
  assert.ok(d, `结果里没有维度 ${id}`);
  return d;
}

/** 一个干净的悬疑短篇 concept：无套路词、有主角、两章都有拍点。 */
function cleanConcept(over = {}) {
  return {
    title: '最后一班地铁',
    logline: '末班车司机发现多出来的乘客三年前就死了，谁来把她送回去？',
    genre: '悬疑',
    characters: [
      { name: '陈默', role: '主角', personality: '沉默，认死理' },
      { name: '红衣女', role: '反派', personality: '一直在笑' },
    ],
    world: [{ name: '4号线', content: '每晚 23:47 发车，末班从不空返' }],
    chapters: [
      { title: '首班车', beat: '陈默数乘客，发现多了一个？' },
      { title: '末班车', beat: '突然，红衣女在终点站下车了' },
    ],
    ...over,
  };
}

/** 一本已写成书的 ctx（buildCtx 的形状），用来验「同一份判据吃到真书」。 */
function bookCtx(over = {}) {
  return {
    book: { id: 'n1', title: '归途', genre: '悬疑', description: '他必须赶在末班车前把信送到，可只剩一站了', format: 'long', target_words: 60000 },
    chapters: [
      { id: 'c1', number: 1, title: '第一章', body: '夜色漫过站台。'.repeat(20), summary: '陈默上夜班，发现多了一个乘客？' },
      { id: 'c2', number: 2, title: '第二章', body: '灯光忽明忽暗。'.repeat(20), summary: '话音未落，闸机自己动了' },
    ],
    characters: [
      { id: 'p1', name: '陈默', role: 'protagonist', role_zh: '主角', personality: '认死理' },
    ],
    promises: { items: [{ id: 'f1', type: 'promise', status: 'planted', setup: { chapter: 'c1' } }] },
    ...over,
  };
}

test('两种入参长成一个形状：向导 concept 与已写成书的 ctx', () => {
  assert.equal(P.viewOf(cleanConcept()).kind, 'concept');
  const v = P.viewOf(bookCtx());
  assert.equal(v.kind, 'ctx');
  assert.equal(v.logline, '他必须赶在末班车前把信送到，可只剩一站了');
  assert.equal(v.format, 'long');
  // 长篇没有「字数目标」那一格（建档留空、预设要设得连档一起换），库里躺着的那个遗留数不作数：
  // 以前这张卡按它给分，而同一本书的进度条不画、工作流面板说「这一格没设」。
  assert.equal(v.targetWords, null, '长篇的遗留目标被当成书定的目标用了');
  assert.equal(P.viewOf({ book: { title: '归途', format: 'short', target_words: 20000 }, chapters: [] }).targetWords,
    20000, '短篇那一格是真设过的，别把它一起判没');
  assert.equal(P.viewOf({ book: { title: '归途', format: 'short', target_words: 500 }, chapters: [] }).targetWords,
    null, '低于下限的数在 core 这边算没设，评分卡不该替它圆场');
  // 另一路问的不是库里那一格：concept 是「作者当场打算写多少」。长篇照样能有这个数
  //（向导的平台档、CLI 的 --words 都给得出），把它按「这一档没有那一格」判没就是白填。
  assert.equal(P.viewOf({ title: '长夜', format: 'long', targetWords: 200000, chapters: [] }).targetWords,
    200000, '长篇的规划数被当成库里那一格判没了');
  assert.equal(v.chapters[0].beat, '陈默上夜班，发现多了一个乘客？', 'ctx 的拍点要从 summary 取');
  assert.equal(v.characters[0].role, '主角', 'ctx 的中文定位要从 role_zh 还原');
});

test('开篇钩子：两处都有钩子才给满分，一处给 2，平铺给 1，没字给 0', () => {
  assert.equal(dim(P.scorePitch(cleanConcept()), 'hook').score, 3);
  const one = dim(P.scorePitch(cleanConcept({ chapters: [{ title: '首班车', beat: '陈默上夜班' }] })), 'hook');
  assert.equal(one.score, 2);
  assert.match(one.reason, /只有「.+」一处/, '该说清是哪一处漏了');
  const flat = dim(P.scorePitch(cleanConcept({ logline: '一个司机在末班车上遇到了旧相识', chapters: [{ title: '首班车', beat: '陈默上夜班' }] })), 'hook');
  assert.equal(flat.score, 1);
  assert.match(flat.reason, /没有一个钩子/);
  const none = dim(P.scorePitch({ title: '还没想好' }), 'hook');
  assert.equal(none.score, 0);
  assert.match(none.advice, /一句话梗概/);
});

test('开篇钩子认突转也认问句，与 R17 用的是同一批判据（本包不抄第二份词表）', () => {
  const question = P.scorePitch(cleanConcept({ logline: '她到底上了哪班车？' }));
  assert.match(dim(question, 'hook').reason, /问句收尾/);
  const twist = P.scorePitch(cleanConcept({ logline: '没想到那班车根本不停这一站' }));
  assert.match(dim(twist, 'hook').reason, /突转收尾/);
});

test('首章正文够长才算第三处钩子，没成形的章子不许拿大纲尾巴冒充', () => {
  const formed = P.scorePitch(bookCtx({
    chapters: [{ id: 'c1', number: 1, title: '第一章', summary: '', body: '夜色漫过站台'.repeat(40) + '可她到底是谁？' }],
    characters: [], promises: { items: [] },
  }));
  assert.match(dim(formed, 'hook').reason, /首章结尾/, '成稿的结尾要参与判分');
  assert.equal(dim(formed, 'hook').score, 2, '这一处之外都没钩子，就该只有一处');
  const mid = '夜色漫过空站台。'.repeat(3) + '可她到底是谁？';
  const n = NWText.countWords(mid);
  // 夹具必须落在「比 20 字长、比门槛短」这一带：太短的话门槛被改小也照样不数，红不起来
  assert.ok(n >= 20 && n < P.BODY_MIN_FOR_HOOK, `夹具要卡在门槛下面一点，当前 ${n} 字`);
  const raw = P.scorePitch(bookCtx({
    chapters: [{ id: 'c1', number: 1, title: '第一章', summary: '', body: mid }],
    characters: [], promises: { items: [] },
  }));
  assert.equal(dim(raw, 'hook').score, 1, '只算梗概那一处，它没有钩子');
  assert.ok(!/首章结尾/.test(dim(raw, 'hook').reason), '没成形的章子不该进判分来源');
});

test('题材差异：套路词命中数逐级扣分，一个都不命中给满分', () => {
  const cases = [
    [3, '最后一班地铁｜末班车司机发现乘客三年前就死了'],
    [2, '重生后的末日地铁｜末班车司机发现乘客三年前就死了'],
    [1, '重生后的末日地铁｜他开局签到一辆车'],
    [0, '重生后的赘婿龙王｜他开局签到一辆车'],
  ];
  for (const [want, logline] of cases) {
    const d = dim(P.scorePitch({ title: 'x', logline, chapters: [], characters: [] }), 'diff');
    assert.equal(d.score, want, `${logline} → 应得 ${want}，实际 ${d.score}（${d.reason}）`);
  }
});

test('题材差异只数标题与梗概里出现的套路词，类型词一个都不算', () => {
  // 词表一旦被塞进「修仙」「悬疑」这类类型词，每个该类型的选题都白掉一级，
  // 而作者的处置是把整张卡当噪音 —— 这条测试就是防那个的。
  for (const genre of ['修仙', '悬疑', '科幻', '都市', '历史', '玄幻']) {
    const r = P.scorePitch({ title: '归途', logline: '他要赶在末班车前把信送到', genre, chapters: [], characters: [] });
    assert.equal(dim(r, 'diff').score, 3, `类型词 ${genre} 被当成套路了：${dim(r, 'diff').reason}`);
  }
  assert.ok(!P.CLICHE_WORDS.some((w) => ['修仙', '悬疑', '系统'].includes(w)), '词表里混进了纯类型词');
});

test('撞车查重：给了对照书单才查，重合过半算一次命中', () => {
  const base = { title: '归途', logline: '末班车司机发现车上的乘客三年前就死了', chapters: [], characters: [] };
  const near = dim(P.scorePitch(base, { others: ['末班车司机发现车上的乘客三年前就死了啊'] }), 'diff');
  assert.equal(near.score, 2);
  assert.match(near.reason, /重合/);
  assert.match(near.advice, /换个切入角度/, '没命中套路词时改法要指向撞车，别答非所问');
  const far = dim(P.scorePitch(base, { others: ['一个厨子在江南开了一间小馆子，慢慢养大了女儿'] }), 'diff');
  assert.equal(far.score, 3, '不相干的对照书不该扣分');
  assert.equal(far.reason, '梗概里没有一个套路词，也没撞车');
});

test('结构完整：每章拍点／主角性格／张力来源，三项各值一分', () => {
  assert.equal(dim(P.scorePitch(cleanConcept()), 'structure').score, 3);
  const noTrait = dim(P.scorePitch(cleanConcept({ characters: [{ name: '陈默', role: '主角', personality: '' }, { name: '红衣女', role: '反派', personality: '一直在笑' }] })), 'structure');
  assert.equal(noTrait.score, 2);
  assert.match(noTrait.reason, /没写性格/);
  const noHero = dim(P.scorePitch(cleanConcept({ characters: [{ name: '路人', role: '配角', personality: '胆小' }], logline: '一个司机在末班车上遇到了旧相识' })), 'structure');
  assert.equal(noHero.score, 1);
  assert.match(noHero.reason, /没有标出主角/);
  const noBeat = dim(P.scorePitch(cleanConcept({ chapters: [{ title: '首班车', beat: '陈默数乘客，发现多了一个？' }, { title: '末班车', beat: '' }] })), 'structure');
  assert.match(noBeat.reason, /有章没写拍点/);
});

test('张力来源三种都认：反派、梗概里的冲突词、已写成书时的未收伏笔', () => {
  const byVillain = dim(P.scorePitch(cleanConcept({ logline: '一个司机在末班车上遇到了旧相识' })), 'structure');
  assert.equal(byVillain.score, 3, '有反派就算张力来源');
  const byConflict = dim(P.scorePitch({ title: '归途', logline: '他只剩一站路，却必须把信送到', characters: [], chapters: [] }), 'structure');
  assert.equal(byConflict.score, 1, '梗概里写着「只剩」「必须」就算一项张力来源');
  const noConflict = dim(P.scorePitch({ title: '归途', logline: '他在末班车上找到了三年前丢的手套', characters: [], chapters: [] }), 'structure');
  assert.equal(noConflict.score, 0, '换成一句不拧着的话，三项一项都不该成立');
  assert.match(noConflict.reason, /看不出谁跟谁拧着/);
  // 反派与冲突词都摘干净，只剩账本里的债 —— 数债那一行一改就要红
  const byPromise = P.scorePitch(bookCtx({
    book: { title: '归途', format: 'long', target_words: 60000, description: '他在末班车上把手套留在了座位上' },
  }));
  assert.equal(dim(byPromise, 'structure').score, 3, '债是这一本唯一的张力来源，三项才凑得齐');
  assert.match(dim(byPromise, 'structure').reason, /未收伏笔 1 条/, '书的债要当真数过来');
});

test('篇幅匹配：单章字数落在版式区间才算成立', () => {
  const ok = dim(P.scorePitch(cleanConcept(), { targetWords: 8000, format: 'short' }), 'length');
  assert.equal(ok.score, 3);
  assert.match(ok.reason, /落在 400 字以上/);
  const big = dim(P.scorePitch(cleanConcept({ chapters: [{ title: '第一章', beat: '陈默上夜班？' }] }), { targetWords: 8000, format: 'long' }), 'length');
  assert.equal(big.score, 2, '长篇超出一倍以内算「能调」');
  const huge = dim(P.scorePitch(cleanConcept(), { targetWords: 200000, format: 'long' }), 'length');
  assert.equal(huge.score, 1);
  assert.match(huge.advice, /拆细章纲/);
  const tiny = dim(P.scorePitch(cleanConcept({ chapters: [{ title: '一', beat: '甲？' }, { title: '二', beat: '乙？' }, { title: '三', beat: '丙？' }, { title: '四', beat: '丁？' }, { title: '五', beat: '戊？' }, { title: '六', beat: '己？' }, { title: '七', beat: '庚？' }] }), { targetWords: 700, format: 'long' }), 'length');
  assert.equal(tiny.score, 1);
  assert.match(tiny.advice, /合并章纲/);
});

test('没填目标字数按 0 分并让人去选平台，而不是假装满分', () => {
  const d = dim(P.scorePitch(cleanConcept()), 'length');
  assert.equal(d.score, 0);
  assert.match(d.advice, /平台/);
  const noChapters = dim(P.scorePitch({ title: 'x', logline: '甲？', characters: [] }, { targetWords: 8000, format: 'short' }), 'length');
  assert.equal(noChapters.score, 0);
  assert.match(noChapters.reason, /一章都没有/);
});

test('长篇与短篇各按自己的区间判分（改错一档就会红）', () => {
  const per = 500;
  const c = { title: 'x', logline: '甲？', characters: [], chapters: [{ title: '一', beat: '乙？' }] };
  assert.equal(dim(P.scorePitch(c, { targetWords: per, format: 'short' }), 'length').score, 3, '短篇单章 500 字该算成立');
  assert.ok(dim(P.scorePitch(c, { targetWords: per, format: 'long' }), 'length').score < 3, '长篇单章 500 字不该算成立');
});

test('梗概自己写着短篇就按短篇评：minFormat 那一句要真被用上', () => {
  // 评分卡的档不只从 opts 来：向导把 concept.format 一起交过来，而 CLI 那条路把
  // 本书与对照书一起算。写死 format:'long' 时上面那条测试照样绿 —— 因为它给的是 opts.format。
  const c = { title: 'x', logline: '甲？', characters: [], chapters: [{ title: '一', beat: '乙？' }], format: 'short' };
  const r = P.scorePitch(c, { targetWords: 500 });
  assert.equal(r.basis.format, 'short', '没给 opts.format 时这一格被丢了：短篇的梗概会按长篇那一档扣分');
  assert.equal(dim(r, 'length').score, 3);
  assert.match(dim(r, 'length').reason, /400 字以上/);

  const plain = P.scorePitch({ title: 'x', logline: '甲？', characters: [], chapters: [{ title: '一', beat: '乙？' }] }, { targetWords: 500 });
  assert.equal(plain.basis.format, 'long');
  assert.equal(dim(plain, 'length').score, 1);
  assert.match(dim(plain, 'length').reason, /下限 1200 字/);
});

test('opts.format 里写脏档名：按长篇评、不抛，也不把脏值原样带进 basis', () => {
  // CLI 那一路自己先拦过一道（认不出就说一句、不参与评分），但评分卡不只在 CLI 上被调用：
  // 界面、以后的别的入口都会直接把外来值送到这里。
  const c = { title: 'x', logline: '甲？', characters: [], chapters: [{ title: '一', beat: '乙？' }] };
  for (const dirty of ['zhong', 'SHORT', ' short', true, 7, ['short']]) {
    const r = P.scorePitch(c, { targetWords: 500, format: dirty });
    assert.equal(r.basis.format, 'long', `${String(dirty)} 被当成了一档：${JSON.stringify(r.basis)}`);
    assert.equal(dim(r, 'length').score, 1, JSON.stringify(dim(r, 'length')));
  }
});

test('短篇上不封顶：向导自己承诺的「微型 6k 字 1 章」不许被判成坏计划', () => {
  // 短篇的「章」是一节，长度由总字数与投放平台定。界面那三档写着 3k-6k/1-2 章、
  // 盐选 5 万字摊 6-10 章（单章可达 8300），给它安一个更小的上限就是机器天天报作者照着界面选的规划。
  const one = { title: 'x', logline: '甲？', characters: [], chapters: [{ title: '一', beat: '乙？' }] };
  assert.equal(dim(P.scorePitch(one, { targetWords: 6000, format: 'short' }), 'length').score, 3,
    '微型档一章写完 6000 字是本书自己承诺的形状');
  assert.equal(dim(P.scorePitch(one, { targetWords: 8300, format: 'short' }), 'length').score, 3, '盐选摊到单章 8300 也接受');
  // 反方向：同样这两个数在长篇档要照旧扣分，别把「不封顶」做成两边都不封顶
  assert.ok(dim(P.scorePitch(one, { targetWords: 6000, format: 'long' }), 'length').score < 3, '长篇 6000 字单章要扣分');
  assert.match(dim(P.scorePitch(one, { targetWords: 8300, format: 'long' }), 'length').reason, /超出合理区间上限 4000/);
  // 下限那一头对短篇仍然有效
  assert.match(dim(P.scorePitch(one, { targetWords: 200, format: 'short' }), 'length').reason, /低于合理区间下限 400 字/);
  assert.deepEqual(P.LENGTH_LABEL, { long: NWTension.rangeLabel('long'), short: NWTension.rangeLabel('short') },
    '话术不是从 CHAPTER_RANGE 算出来的，就是另抄了一份');
});

test('总分等于四维之和、满分恒 12，分档只换话术不换门禁', () => {
  const r = P.scorePitch(cleanConcept(), { targetWords: 8000, format: 'short' });
  assert.equal(r.max, 12);
  assert.equal(r.total, r.dims.reduce((s, d) => s + d.score, 0));
  assert.equal(r.dims.length, 4);
  assert.deepEqual(r.dims.map((d) => d.id), ['hook', 'diff', 'structure', 'length']);
  for (const d of r.dims) assert.ok(d.score >= 0 && d.score <= d.max, `${d.id} 越界`);
});

test('verdict 的四档边界说死：11/12、10/12、8/12、7/12', () => {
  assert.equal(P.verdictOf(12, 12), '可以动笔');
  assert.equal(P.verdictOf(11, 12), '可以动笔');
  assert.equal(P.verdictOf(10, 12), '先改弱项再动笔');
  assert.equal(P.verdictOf(8, 12), '先改弱项再动笔');
  assert.equal(P.verdictOf(7, 12), '这个选题还没立住，建议换角度');
  assert.equal(P.verdictOf(0, 12), '这个选题还没立住，建议换角度');
});

test('渲染只有一处：界面与 CLI 拿到的是同一份说法', () => {
  const lines = P.renderLines(P.scorePitch(cleanConcept(), { targetWords: 8000, format: 'short' })).split('\n');
  assert.equal(lines[0], '选题评分 12/12 —— 可以动笔');
  assert.equal(lines.length, 6, '总分一行 + 四维各一行 + 词表出处一行');
  for (const label of ['开篇钩子', '题材差异', '结构完整', '篇幅匹配']) {
    assert.ok(lines.some((l) => l.startsWith(`${label} 3/3`)), `${label} 没有单独成行`);
  }
  assert.match(lines[5], /不是平台榜单数据/, '词表是手写的一定要当场说清');
  assert.ok(lines[5].includes(String(P.CLICHE_WORDS.length)), '词表数量要说的是真数出来的那个数');
  const ctxLines = P.renderLines(P.scorePitch(bookCtx())).split('\n');
  assert.equal(ctxLines.length, 5, '判的是已写成书，不必再解释词表');
  assert.ok(!ctxLines.some((l) => l.includes('不是平台榜单数据')));
});

test('大字符相似度：同句为 1，不相干为 0，空串不炸', () => {
  assert.equal(P.similarity('末班车的乘客三年前就死了', '末班车的乘客三年前就死了'), 1);
  assert.equal(P.similarity('末班车的乘客三年前就死了', '厨子在江南开小馆子养女儿'), 0);
  assert.equal(P.similarity('', ''), 0);
  assert.equal(P.similarity(null, undefined), 0);
});

test('边界输入一律不许抛：喂什么形状都吐一张完整的卡', () => {
  const inputs = [null, undefined, {}, '一段字', 42, [], { chapters: null }, { chapters: [null, {}] },
    { characters: [null, { name: 12, role: 7, personality: 9 }], logline: 8 },
    { title: 'x', logline: '甲？', characters: [], chapters: [], targetWords: '八千字' },
    { title: 'x', logline: '甲？', characters: [], chapters: [], targetWords: '8000' },
    { book: null, chapters: [{ number: '三', body: null, summary: null }] },
    { book: { title: null, target_words: {} }, chapters: [], promises: { items: [null] } }];
  for (const input of inputs) {
    const r = P.scorePitch(input, { others: [null, 3, { title: '对照', logline: null }] });
    assert.ok(r && r.dims.length === 4 && r.total >= 0 && r.total <= r.max, `形状不对：${JSON.stringify(input)}`);
    for (const d of r.dims) assert.equal(typeof d.reason, 'string');
  }
});

test('评分不改动入参 —— 确认弹窗关掉后 concept 还要能拿去建档', () => {
  const concept = cleanConcept();
  const before = JSON.parse(JSON.stringify(concept));
  P.scorePitch(concept, { targetWords: 8000, format: 'short', others: ['另一本'] });
  assert.deepEqual(concept, before);
});

test('界面当场知道的 genre／targetWords 走 opts 传入，只有空着才填', () => {
  const r = P.scorePitch({ title: 'x', logline: '他必须把信送到，可只剩一站', characters: [], chapters: [{ title: '一', beat: '乙？' }] },
    { genre: '科幻', targetWords: 2000, format: 'short' });
  assert.equal(r.basis.format, 'short');
  assert.equal(dim(r, 'length').score, 3);
  const keep = P.scorePitch({ title: 'x', logline: '甲？', genre: '悬疑', characters: [], chapters: [] }, { genre: '科幻' });
  assert.equal(P.viewOf({ title: 'x', genre: '悬疑' }).genre, '悬疑', 'concept 自带的类型不许被 opts 覆盖');
  assert.ok(keep.total >= 0);
});

test('词表与阈值都导出且成对，改判据只改这一个文件', () => {
  assert.ok(Array.isArray(P.CLICHE_WORDS) && P.CLICHE_WORDS.length >= 20);
  assert.deepEqual(Object.keys(P.LENGTH_RANGE).sort(), ['long', 'short']);
  assert.ok(P.SIMILAR_CUT > 0 && P.SIMILAR_CUT < 1);
  assert.equal(P.MAX_PER_DIM, 3);
  assert.equal(P.PACK_VERSION, '1.0.0');
  assert.ok(NWText, '依赖 NWText 计字，加载表必须排对它');
});
