import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWStyleFit, NWRules, NWText } from './_load.mjs';

// ═══════════════ 夹具：每个夹具只动一格，删掉对应判据必须红 ═══════════════

const L = '他沿着石阶往上走，雾贴着脚背流动，山门还在很远的地方。';   // 27 个字符、1 句、24 字（标点不计字）
const S = '他停下脚步。';                                              // 6 字 1 句，5 字正文
const D = '“你到底来不来。”他站在原地，过了很久才又问了一遍。';        // 成对引号 1 句 + 叙述 1 句
const CLICHE = L + '这一刻，他心中五味杂陈，仿佛整个世界都安静了。';

const rep = (n, u) => Array.from({ length: n }, () => u).join('\n\n');
const fp = (b, opts) => NWStyleFit.fingerprint([{ body: b }], opts);
/** 手搭的指纹：门槛测试要的是「差一点点」，靠正文长度凑不出那种精度。 */
const fit = (over) => ({
  version: NWStyleFit.FIT_VERSION, chapters: 2, words: 4000,
  sentAvg: 20, dialogue: 0.3, paraSent: 1.5, cliche: 1, ...over,
});
const ids = (list) => list.map((d) => d.id);

// ═══════════════ 四个数各算各的 ═══════════════

test('指纹四项：一句一段的长句正文，句均/对话/段均/禁词各归各的值', () => {
  const f = fp(rep(26, L));
  assert.equal(f.chapters, 1);
  assert.equal(f.words, 624, '26 句 × 每句 24 字（标点不计入字数）—— 门槛按字数算，夹具本身要过得去');
  assert.equal(f.sentAvg, 24, '每句都是同一句，句均就是它自己的字数');
  assert.equal(f.dialogue, 0, '没有成对引号就不许算出对话');
  assert.equal(f.paraSent, 1, '一段一句');
  assert.equal(f.cliche, 0, '这段正文里一个禁词都没有，密度必须报 0');
});

test('段均句数：把两句并进同一段，只有这一格动', () => {
  const f = fp(rep(22, L + S));
  assert.equal(f.paraSent, 2);
  assert.equal(f.sentAvg, 14.5, '(24+5)/2 —— 句均跟着动是因为句子换了，不是段数错');
  assert.equal(f.chapters, 1);
});

test('对话占比只认成对引号里的那一句：整段引号内外各一句时是 0.286', () => {
  const f = fp(rep(30, D));
  assert.equal(f.dialogue, 0.286, `实测 ${f.dialogue}`);
  assert.ok(f.dialogue > 0 && f.dialogue < 1, '占比必须落在 0..1，越界说明分子分母写反了');
});

test('禁词密度按本书的包算：作者整包关掉时这一格必须是 0，不是留着默认值', () => {
  const on = fp(rep(24, CLICHE));
  assert.ok(on.cliche > 1, `带着禁词夹具却算出 ${on.cliche}，说明没接到 NWStylePack.lint`);
  const off = fp(rep(24, CLICHE), { enabled: false });
  assert.equal(off.cliche, 0, 'enabled=false 时算出禁词密度，就是替作者判了他明确放过的词');
  assert.equal(off.sentAvg, on.sentAvg, '关禁词包不许连句长一起改掉');
});

// ═══════════════ 口径：相加再相除 ═══════════════

test('多章合成按计数相加再相除，不是各章比值取平均（短句章字数少，不该同权）', () => {
  const long = fp(rep(26, L));      // 624 字，句均 24
  const short = fp(rep(130, S));    // 650 字，句均 5
  assert.equal(short.chapters, 1, '夹具本身要够 MIN_BODY，否则这题什么都没验');
  const both = NWStyleFit.fingerprint([{ body: rep(26, L) }, { body: rep(130, S) }]);
  assert.equal(both.chapters, 2);
  assert.equal(both.sentAvg, 8.2, '(624+650)/(26+130) 加权');
  assert.notEqual(both.sentAvg, (long.sentAvg + short.sentAvg) / 2, '按章取平均就是把 624 字与 650 字同权');
  assert.equal(both.words, long.words + short.words);
});

test('正文不足 MIN_BODY 的章不进指纹，也不许留一份空基准给模型当承诺', () => {
  const f = fp(rep(6, L));
  assert.ok(f.chapters === 0 && f.words === 0, '短章应当整章被跳过');
  assert.equal(NWStyleFit.lines(f), '', '没有实测值就一个字都不写，编一句「句均 0 字」比不写更糟');
});

test('MIN_BODY 是字数门槛（与界面那个「N 字」同一个数法），两侧各有夹具钉着', () => {
  // 上面那些夹具全都用 `NWStyleFit.MIN_BODY` 表达，所以把数值改成 601 它们照样绿 ——
  // 可这个数还被话术当字面量写着（R32 的 detail、CLI 的「正文不足 600 字」），一改就分家。
  assert.equal(NWStyleFit.MIN_BODY, 600, '门槛数值一改，规则话术与 CLI/文档里那句「600 字」都跟着过期');
  assert.ok(NWRules.RULES['style-drift'].detail.includes(`正文不足 ${NWStyleFit.MIN_BODY} 字`),
    'R32 说给作者的字数必须跟引擎同一个数：这里分家就是拿一句话骗人');

  // 夹选用不带标点的重复体：字数与字符数同值，切片切到哪一个数就是哪一个数，两侧才真的只差一个字
  const P = '山风一路跟着他走上了石阶又穿过松林';
  assert.equal(NWText.countWords(P), P.length, '夹具要「字数=字符数」，否则这道边界测不出用的是哪个口径');
  const cut = (n) => P.repeat(60).slice(0, n);
  const justUnder = cut(NWStyleFit.MIN_BODY - 1);
  const justIn = cut(NWStyleFit.MIN_BODY);
  assert.equal(NWText.countWords(justUnder), NWStyleFit.MIN_BODY - 1);
  assert.equal(NWText.countWords(justIn), NWStyleFit.MIN_BODY);
  assert.equal(NWStyleFit.qualifies(justUnder), false, '差一个字也不该进');
  assert.equal(NWStyleFit.qualifies(justIn), true, '够格的一章不许被门槛挡在门外');
  assert.equal(fp(justUnder).chapters, 0, '指纹入口与 qualifies 判的不是同一条线');
  assert.equal(fp(justIn).chapters, 1, '指纹入口与 qualifies 判的不是同一条线');

  // 口径本身：字符够 600 而字不够 600 的一章不许进。曾经它就是按 body.length 判的，
  // 于是界面上画出「480 字」却允许勾、规则话术写着「正文不足 600 字」，作者看见的两个数对不上。
  const puncty = L.repeat(23);                       // 621 个字符、552 字
  assert.ok(puncty.length >= NWStyleFit.MIN_BODY && NWText.countWords(puncty) < NWStyleFit.MIN_BODY,
    '夹具要正好落在「字符够、字不够」那一格，不然这条口径测试什么也没验');
  assert.equal(fp(puncty).chapters, 0, '按字符数放行 = 把一章只有 552 字的正文当成基准，而那 552 字就写在作者眼前');
});

// ═══════════════ 门槛：每格各有一条「差一点不算漂移」与「越界」 ═══════════════

test('句均字数按相对偏离 30%：29.5% 不报，30.5% 报', () => {
  assert.deepEqual(ids(NWStyleFit.compare(fit({}), fit({ sentAvg: 25.9 }))), []);
  const over = NWStyleFit.compare(fit({}), fit({ sentAvg: 26.1 }));
  assert.deepEqual(ids(over), ['sentAvg']);
  assert.equal(over[0].deltaText, '31%', `相对偏离要说成百分比，实测 ${over[0].deltaText}`);
  // 20→26 的差是 6，6/20 落回字面量 0.3 那个 double：这一对才真的坐在门槛上，
  // 「大于」与「大于等于」在这里必须给出不同答案
  assert.deepEqual(ids(NWStyleFit.compare(fit({}), fit({ sentAvg: 26 }))), [], '正好 30% 不许算越界');
});

test('段均句数按相对偏离 40%：正好 40% 不报（门槛是「大于」），44% 报', () => {
  // 2.5→3.5 的差是 1.0，1.0/2.5 就是字面量 0.4 那个 double。
  // 原先用的 2→2.8 算出 0.3999999999999999：够不到门槛但也不等于门槛，
  // 拿它当「正好 40%」是把浮点噪声当成了判据 —— 把 `>` 改成 `>=` 它照样绿。
  assert.deepEqual(ids(NWStyleFit.compare(fit({ paraSent: 2.5 }), fit({ paraSent: 3.5 }))), [], '正好 40% 不许算越界');
  assert.deepEqual(ids(NWStyleFit.compare(fit({ paraSent: 2.5 }), fit({ paraSent: 3.6 }))), ['paraSent']);
});

test('对话占比按百分点算，不按相对倍数：1%→4% 那种爆炸式相对差不是漂移', () => {
  assert.deepEqual(ids(NWStyleFit.compare(fit({ dialogue: 0.01 }), fit({ dialogue: 0.04 }))), [],
    '本底 1% 涨到 4%（相对 +300%）不该叫风格漂移');
  const big = NWStyleFit.compare(fit({}), fit({ dialogue: 0.421 }));
  assert.deepEqual(ids(big), ['dialogue']);
  assert.equal(big[0].deltaText, '12 个百分点', `实测 ${big[0].deltaText}`);
  assert.deepEqual(ids(NWStyleFit.compare(fit({}), fit({ dialogue: 0.419 }))), [], '11.9 个百分点不越界');
});

test('禁词密度按绝对差 1.5 处/千字（与去 AI 味包 info 档同值）', () => {
  assert.equal(NWStyleFit.keyOf('cliche').dev, 1.5, '门槛要能在包里对上号，别两处各写一个数');
  assert.deepEqual(ids(NWStyleFit.compare(fit({}), fit({ cliche: 2.49 }))), []);
  assert.deepEqual(ids(NWStyleFit.compare(fit({}), fit({ cliche: 2.5 }))), [], '正好 1.5 不许算越界（1 与 2.5 都是二进制精确值，这一对真坐在门槛上）');
  const over = NWStyleFit.compare(fit({}), fit({ cliche: 2.51 }));
  assert.deepEqual(ids(over), ['cliche']);
  assert.equal(over[0].deltaText, '1.51 处/千字', `实测 ${over[0].deltaText}`);
});

test('相对型键在本底为 0 时不许炸出 Infinity，也不许报成「升无穷倍」', () => {
  const zero = fit({ sentAvg: 0 });
  const d = NWStyleFit.compare(zero, fit({ sentAvg: 24 }));
  assert.deepEqual(ids(d), ['sentAvg'], '本底 0 现在 24，这当然算变化');
  assert.equal(d[0].deltaText, '本底为 0', '这句要能读，不能是 NaN% 或 Infinity%');
  assert.deepEqual(ids(NWStyleFit.compare(zero, fit({ sentAvg: 0 }))), [], '两边都是 0 不算偏离');
});

test('同一份指纹比自己不越界；任一边是空指纹时整条闭嘴', () => {
  const f = fp(rep(24, L));
  assert.deepEqual(NWStyleFit.compare(f, f), [], '跟自己比必须一条不报');
  assert.deepEqual(NWStyleFit.compare(f, fit({ words: 0 })), [], '没有字数就没有基准可比，别说「都是 0 所以一致」');
  assert.deepEqual(NWStyleFit.compare(null, f), []);
});

// ═══════════════ 出话 ═══════════════

test('进 prompt 那一行：四个数与 KEYS 的 fmt 同源，还带章数与字数', () => {
  const f = fp(rep(26, L));
  const line = NWStyleFit.lines(f);
  for (const k of NWStyleFit.KEYS) assert.ok(line.includes(k.fmt(f[k.id])), `${k.label} 的数字没进那一行`);
  assert.match(line, /1 章 \/ 624 字/, '要说清这份指纹是从多少字算出来的');
  assert.equal(NWStyleFit.KEYS.length, 4, '这一族只回答这四格；加第五格要连门槛夹具一起加');
});

test('漂移那句人话：多键越界用「、」并列，方向说得出升降', () => {
  const text = NWStyleFit.driftText(fit({}), fit({ sentAvg: 30, dialogue: 0.1 }));
  assert.match(text, /句均字数 20\.0 字→30\.0 字（升 50%）/);
  assert.match(text, /对话占比 30%→10%（降 20 个百分点）/);
  assert.equal(text.split('、').length, 2, '两个键都越界就要并列两条，别只报第一个');
  assert.equal(NWStyleFit.driftText(fit({}), fit({})), '');
});

test('边界输入不许崩：null / 空数组 / body 缺失 / 字符串数组一律给空指纹', () => {
  for (const bad of [null, undefined, [], [{}], [{ body: null }], ['整段正文'], [{ body: 42 }]]) {
    const f = NWStyleFit.fingerprint(bad);
    assert.ok(f && typeof f.words === 'number', `${JSON.stringify(bad)} 不该抛，也不该返回 undefined`);
    assert.equal(f.chapters, 0, `${JSON.stringify(bad)} 不算一章`);
    assert.equal(f.words, 0);
  }
  assert.deepEqual(NWStyleFit.compare(fp(rep(24, L)), undefined), []);
});
