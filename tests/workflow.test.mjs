import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWWorkflow as W, NWStylePack as SP } from './_load.mjs';

// ═══════════════ 夹具 ═══════════════

/** 一本调顺了的短篇：8000 字目标、关掉段尾金句、自添两个禁词、勾了两章当文风基准 */
const shortBook = () => ({
  id: 'nov_1', title: '山河故人', genre: '短篇', format: 'short', target_words: 8000,
  styleAnchor: ['ch_7', 'ch_9'],
  stylePack: { enabled: true, disabled: ['aphorism'], extraBanned: ['属实', '有一说一'] },
});
const preset = (fields, extra = {}) => ({ kind: W.KIND, version: W.FILE_VERSION, name: '测试流', note: '', fields, ...extra });

// ═══════════════ 打包 ═══════════════

test('打包只带那三格，基准章一个字节都不许漏进预设', () => {
  const p = W.pack(shortBook(), { name: '我的短篇流程' });
  assert.deepEqual(Object.keys(p.fields).sort(), ['format', 'stylePack', 'target_words']);
  assert.equal(p.kind, W.KIND);
  assert.equal(p.name, '我的短篇流程');
  // 基准章记的是这一本书里那些章的身份证，抄到另一本上就是指向不存在的东西
  const json = JSON.stringify(p);
  assert.equal(json.includes('ch_7'), false, `预设里漏出了章身份：${json}`);
  assert.equal(json.includes('styleAnchor'), false, json);
  assert.equal(json.includes('山河故人'), false, '书名是「这一本是什么书」，不是工作方式');
});

test('打包出来的预设过自己的闸，且过完还是同一份（打包与校验必须同口径）', () => {
  const p = W.pack(shortBook(), { name: '往返' });
  const n = W.normalize(p);
  assert.equal(n.ok, true, JSON.stringify(n));
  assert.deepEqual(n.fields, p.fields);
  assert.deepEqual(n.unknown, []);
  assert.deepEqual(n.bad, []);
});

test('规则包那一格永远整理成完整三键，缺的那两样按默认补齐', () => {
  const p = W.pack({ id: 'n', format: 'long' });
  assert.deepEqual(p.fields.stylePack, { enabled: true, disabled: [], extraBanned: [] });
  const loose = W.normalize(preset({ format: 'short', stylePack: { disabled: ['psych'] } }));
  assert.equal(loose.ok, true, JSON.stringify(loose));
  assert.deepEqual(loose.fields.stylePack, { enabled: true, disabled: ['psych'], extraBanned: [] });
});

test('长篇打包不会把字数目标带出来（建档那一路本来就把它留空）', () => {
  const p = W.pack({ format: 'long', target_words: 8000 });
  assert.equal('target_words' in p.fields, false, JSON.stringify(p.fields));
});

test('短篇那一格也得是个像样的数：低于下限、小数、乱码都不进预设', () => {
  // 以前打包自己判「≥ 下限」，建档却按「非空就算」存 —— 于是库里可以躺着一个 500：
  // 进度条照它画、评分卡照它算分，而这份预设说这本书没设过目标。
  for (const bad of [500, 1500.5, '八千字', true, {}, null]) {
    const p = W.pack({ format: 'short', target_words: bad }, { name: '脏目标' });
    assert.equal('target_words' in p.fields, false, `${JSON.stringify(bad)} 被装进了预设：${JSON.stringify(p.fields)}`);
  }
  const p = W.pack({ format: 'short', target_words: '8000' }, { name: '字符串数' });
  assert.equal(p.fields.target_words, 8000, '字符串数字收回来 —— 过闸那一路也是同一句');
  // 不该清的也别顺手清：这一格在 core 这边根本没设过，预设就不该带一行「清掉它」
  const rows = W.diffFields({ format: 'short', target_words: 500 }, { format: 'short' });
  assert.deepEqual(rows.filter((r) => r.clears), [], JSON.stringify(rows));
});

test('库里那格写着认不出的档名：打包先归一成缺档，不把外人认不出的值装进预设', () => {
  // 库行是 updateNovel/putRow 直接写的，那道闸不在这条路上，'SHORT'、'zhong' 都可能躺在库里。
  // 不归一就打出一份 format:'SHORT' 的预设 —— 它过不了自己的闸，而它是从一本能打开的书里打出来的。
  const p = W.pack({ format: 'SHORT', target_words: 8000 }, { name: '脏档' });
  assert.equal(p.fields.format, 'long', JSON.stringify(p.fields));
  assert.equal('target_words' in p.fields, false, '认不出的档不算短篇，那个遗留的字数目标不该被当短篇的设置打包');
  const n = W.normalize(p);
  assert.equal(n.ok, true, JSON.stringify(n));
});

// ═══════════════ 过闸：三堆各有说法 ═══════════════

test('认不出的键：整份拒收，并把键名说出口', () => {
  const n = W.normalize(preset({ format: 'short', styleAnchor: ['ch_1'], tags: ['热血'] }));
  assert.deepEqual(n.unknown, ['styleAnchor', 'tags']);
  assert.equal(n.ok, false, '带着认不出的键还照用半份，就是把「没落地的那部分」藏起来');
  assert.ok(n.errors.some((e) => e.includes('styleAnchor') && e.includes('tags')), JSON.stringify(n.errors));
});

test('幽灵禁词组：点名那一个，别的一概不误伤', () => {
  const n = W.normalize(preset({ stylePack: { disabled: ['nope', 'psych'] } }));
  assert.equal(n.bad.length, 1, JSON.stringify(n));
  assert.equal(n.bad[0].key, 'stylePack');
  assert.ok(n.bad[0].reason.includes('nope'), n.bad[0].reason);
  assert.equal(n.bad[0].reason.includes('psych'), false, '认识的那组不该被牵连');
  assert.equal('stylePack' in n.fields, false);
});

test('规则包里的子键也认不得就直说，不静默忽略', () => {
  const n = W.normalize(preset({ stylePack: { disabled: [], tone: '冷' } }));
  assert.ok(n.bad.some((b) => b.reason.includes('tone')), JSON.stringify(n.bad));
});

test('规则包那两个开关只认自己那一种写法：类型不对各给一句，不靠「能转成布尔」混进来', () => {
  const notBool = W.normalize(preset({ stylePack: { enabled: 'no' } }));
  assert.equal(notBool.ok, false, JSON.stringify(notBool));
  assert.deepEqual(notBool.bad.map((b) => b.reason), ['整包开关只能是开或关'], JSON.stringify(notBool.bad));
  const notList = W.normalize(preset({ stylePack: { extraBanned: '属实' } }));
  assert.deepEqual(notList.bad.map((b) => b.reason), ['自添禁词得是一个列表'], JSON.stringify(notList.bad));
  // 不该判坏的别判坏：写了正确的类型就过，缺省也过
  assert.equal(W.normalize(preset({ stylePack: { enabled: false, extraBanned: [] } })).ok, true);
});

test('长篇配字数目标是坏搭配，而且与键序无关', () => {
  const a = W.normalize(preset({ format: 'long', target_words: 5000 }));
  const b = W.normalize(preset({ target_words: 5000, format: 'long' }));
  assert.equal(a.bad.length, 1, JSON.stringify(a));
  assert.equal(a.bad[0].key, 'target_words');
  assert.deepEqual(b.fields, a.fields, '同一份内容、两种键序，判决必须一样');
  assert.deepEqual(b.bad, a.bad);
  assert.equal('target_words' in a.fields, false);
  assert.equal(a.fields.format, 'long', '坏的那格不连累好的那格');
});

test('不该判坏的别判坏：短篇配目标、长篇单带、只关几组禁词', () => {
  for (const fields of [
    { format: 'short', target_words: 3000 },
    { format: 'long' },
    { stylePack: { enabled: false } },
    { stylePack: { disabled: [] } },
    { target_words: 8000 },
  ]) {
    const n = W.normalize(preset(fields));
    assert.equal(n.ok, true, JSON.stringify({ fields, ...n }));
  }
});

test('字数目标只认正整数：字符串数字收，小数、零、负数、乱码各给一句', () => {
  assert.equal(W.normalize(preset({ target_words: '8000' })).ok, true);
  for (const bad of [1500.5, 0, -8000, 'abc', null, true, []]) {
    const n = W.normalize(preset({ target_words: bad }));
    assert.equal(n.ok, false, `${String(bad)} 居然过了闸`);
    assert.ok(n.bad.some((b) => b.key === 'target_words'), JSON.stringify(n));
  }
});

test('字数目标出上限也判坏，且说清是哪一头；上限自己放行', () => {
  const over = W.normalize(preset({ format: 'short', target_words: W.TARGET_MAX * 10 }));
  assert.equal(over.ok, false, JSON.stringify(over));
  assert.match(over.bad[0].reason, /到 \d+ 之间的整数/, '理由要念出上下限这对数');
  assert.equal(W.normalize(preset({ format: 'short', target_words: W.TARGET_MAX })).ok, true,
    '上限含端点：schema 写的是 maximum，不是 exclusiveMaximum');
});

test('篇幅档只认那两个值，写了别的就照实说', () => {
  const n = W.normalize(preset({ format: 'medium' }));
  assert.equal(n.ok, false);
  assert.ok(n.bad[0].reason.includes('medium'), n.bad[0].reason);
});

test('不是这份格式的输入直接拒，且拒的原因是那一句', () => {
  assert.match(W.normalize(preset({ format: 'short' }, { kind: 'other.thing' })).errors[0], /不是织文的工作流预设/);
  assert.match(W.normalize(preset({ format: 'short' }, { version: 2 })).errors[0], /不猜/);
  assert.equal(W.normalize(preset({})).ok, false, '一格设置都没有的预设不该算能用');
});

// ═══════════════ 逐格 diff 与补丁 ═══════════════

test('diff 逐格说「现在 / 预设 / 会不会变」，只比预设真带的那几格', () => {
  const rows = W.diffFields(shortBook(), {
    format: 'short', target_words: 3000, stylePack: { enabled: true, disabled: [], extraBanned: [] },
  });
  assert.deepEqual(rows.map((r) => r.key), ['format', 'target_words', 'stylePack']);
  assert.deepEqual(rows.map((r) => r.changed), [false, true, true]);
  assert.equal(rows[0].current, '短篇', '档名那一行的值也走 core 那张表，不许界面自己拼');
  assert.equal(rows[0].incoming, '短篇');
  assert.equal(rows[1].current, '8000 字');
  assert.equal(rows[1].incoming, '3000 字');
  assert.match(rows[2].current, /关掉 1 组：段尾金句/);
  assert.match(rows[2].current, /自添 2 个禁词/);
  assert.equal(rows[2].incoming, `${SP.GROUPS.length} 组全开`);
});

test('format 那一行的值先过归一：脏档按长篇念，不许把原值原样抄进面板', () => {
  // 显示念归一后的档；补丁照常写回（归一写回本来就是库行该收的），changed 由原值比出来。
  const rows = W.diffFields({ id: 'n', format: 'zhong' }, { format: 'long' });
  assert.equal(rows[0].current, '长篇');
  assert.equal(rows[0].incoming, '长篇');
  assert.equal(rows[0].changed, false, '两边都先过归一：脏档与长篇本就是同一档，不白写一次库');
});

test('预设里少写一个 enabled 不算改动（两边都先过同一道整理）', () => {
  const rows = W.diffFields(shortBook(), { stylePack: { disabled: ['aphorism'], extraBanned: ['属实', '有一说一'] } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].changed, false, JSON.stringify(rows[0]));
});

test('补丁只含真变的那几格，一格没变就是空补丁', () => {
  const b = shortBook();
  assert.deepEqual(W.patchOf(b, { format: 'short', target_words: 3000 }), { target_words: 3000 });
  assert.deepEqual(W.patchOf(b, { format: 'short', target_words: 8000, stylePack: b.stylePack }), {});
});

test('长篇收到只带字数目标的预设：那一格落不下，一个字节都不许写进库', () => {
  // 这一格过得了闸（它自己没配长篇），可这本书是长篇：写进去进度条不显示、
  // 打包也带不出来，而评分卡还在按它算分 —— 「说改了其实看不见」就是这么来的。
  const rows = W.diffFields({ id: 'n', format: 'long' }, { target_words: 5000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blocked, W.LONG_NO_TARGET, JSON.stringify(rows[0]));
  assert.equal(rows[0].changed, false, '落不下的一格不许算成要改的');
  assert.deepEqual(W.patchOf({ id: 'n', format: 'long' }, { target_words: 5000 }), {});
});

test('不该拦的别拦：预设把长篇换成短篇时，它带来的目标就是有落点', () => {
  const toShort = W.diffFields({ id: 'n', format: 'long' }, { format: 'short', target_words: 5000 });
  assert.deepEqual(toShort.map((r) => r.blocked), [null, null], JSON.stringify(toShort));
  assert.deepEqual(toShort.map((r) => r.changed), [true, true], '按换过之后的篇幅档判，不是按换之前');
  const stillShort = W.diffFields(shortBook(), { target_words: 3000 });
  assert.equal(stillShort[0].blocked, null);
  assert.equal(stillShort[0].changed, true);
});

test('预设把短篇换成长篇时，库里那个字数目标要如实清掉', () => {
  // 不清的后果就是反向的那句假话：pack 替长篇把这一格藏起来，面板于是说「（这一格没设）」，
  // 可 8000 还躺在库行里，评分卡照样按它算分。
  const b = shortBook();
  const rows = W.diffFields(b, { format: 'long' });
  assert.deepEqual(rows.map((r) => r.key), ['format', 'target_words'], JSON.stringify(rows));
  const clear = rows[1];
  assert.equal(clear.clears, true, JSON.stringify(clear));
  assert.equal(clear.changed, true, '这一格确实会被写库，报「不变」就是假话');
  assert.equal(clear.blocked, null, '落不下与要清掉是两件事，别混成一格');
  assert.equal(clear.current, '8000 字');
  assert.equal(clear.incoming, W.CLEAR_NO_TARGET);
  assert.deepEqual(W.patchOf(b, { format: 'long' }), { format: 'long', target_words: null });
});

test('不该清的别清：预设没带篇幅档，或者那一格本来就没有数', () => {
  // 「应用只改它带来的格」——只动禁词组的预设顺手抹掉作者定的目标，那是越权
  const packOnly = W.diffFields(shortBook(), { stylePack: { enabled: true, disabled: ['aphorism'], extraBanned: ['属实', '有一说一'] } });
  assert.deepEqual(packOnly.map((r) => r.key), ['stylePack'], JSON.stringify(packOnly));
  // 换成短篇时那个数有落点，还在被用，一行都不许多
  const toShort = W.diffFields(shortBook(), { format: 'short' });
  assert.deepEqual(toShort.map((r) => r.key), ['format'], JSON.stringify(toShort));
  // 长篇且本来没设过目标：这一格没东西可清，别惊动作者
  const clean = W.diffFields({ id: 'n', format: 'long' }, { format: 'long' });
  assert.deepEqual(clean.map((r) => r.key), ['format'], JSON.stringify(clean));
  assert.deepEqual(W.patchOf({ id: 'n', format: 'long' }, { format: 'long' }), {});
  // 不成数的残留（低于下限）不算「有一个目标被留着」，别为它开一格
  const junk = W.diffFields({ id: 'n', format: 'long', target_words: 500 }, { format: 'long' });
  assert.deepEqual(junk.map((r) => r.key), ['format'], JSON.stringify(junk));
});

test('遗留的长篇库行：应用只带长篇的预设时，那一格一并清走', () => {
  const stale = { id: 'n', format: 'long', target_words: 8000 };
  const rows = W.diffFields(stale, { format: 'long' });
  assert.deepEqual(rows.map((r) => r.key), ['format', 'target_words'], JSON.stringify(rows));
  assert.deepEqual(rows.map((r) => r.changed), [false, true], '篇幅档没变，只有那一格要清');
  assert.deepEqual(W.patchOf(stale, { format: 'long' }), { target_words: null });
});

test('清掉那一行说的是同一句话，不是界面自己编的第二份理由', () => {
  const row = W.diffFields(shortBook(), { format: 'long' })[1];
  assert.equal(row.incoming.includes(W.LONG_NO_TARGET), true, row.incoming);
});

test('过闸那一处与 diff 那一处说的是同一句话（两处各写一遍就会一处拦一处放行）', () => {
  const n = W.normalize(preset({ format: 'long', target_words: 5000 }));
  assert.equal(n.bad[0].reason, W.LONG_NO_TARGET);
  assert.equal(W.diffFields({ id: 'n', format: 'long' }, { target_words: 5000 })[0].blocked, n.bad[0].reason);
});

// ═══════════════ 单一出处 ═══════════════

test('可分享清单里不许出现基准章，而「为什么不共享」那一句里点名它', () => {
  assert.deepEqual(W.FIELDS, ['format', 'target_words', 'stylePack']);
  assert.equal(W.FIELDS.includes('styleAnchor'), false);
  assert.ok(W.NOT_SHARED.some((n) => n.key === 'styleAnchor'), JSON.stringify(W.NOT_SHARED));
});

test('内置预设必须过自己那道闸，且只点真存在的禁词组', () => {
  const known = W.groupIds();
  assert.ok(known.length >= 8, `禁词组只剩 ${known.length} 个？内置预设要跟着改`);
  for (const b of W.BUILTINS) {
    const n = W.normalize(preset(b.fields, { name: b.name, note: b.note }));
    assert.equal(n.ok, true, `${b.name} 过不了自己的闸：${JSON.stringify(n)}`);
    for (const key of Object.keys(b.fields)) assert.ok(W.FIELDS.includes(key), `${b.name} 带了不在清单里的键 ${key}`);
    for (const id of (b.fields.stylePack?.disabled || [])) assert.ok(known.includes(id), `${b.name} 点了不存在的组 ${id}`);
  }
});

test('文件名走 slugify 那一个出处，不带空格与路径分隔符', () => {
  const f = W.fileName({ name: '网文日更 · 长篇/第二版' });
  assert.match(f, /^novelweave-workflow-.+\.json$/);
  assert.equal(/\s|\//.test(f), false, f);
  assert.equal(W.fileName({}), 'novelweave-workflow-workflow.json');
});

test('残缺输入一律不抛：null、数组、字段全缺', () => {
  assert.doesNotThrow(() => W.normalize(null));
  assert.doesNotThrow(() => W.normalize([]));
  assert.equal(W.normalize([]).ok, false);
  assert.doesNotThrow(() => W.pack(null));
  assert.doesNotThrow(() => W.diffFields(null, null));
  assert.doesNotThrow(() => W.patchOf(undefined, undefined));
  assert.doesNotThrow(() => W.valueText('stylePack', undefined));
  assert.doesNotThrow(() => W.fileName(null));
  for (const r of W.diffFields(null, null)) assert.fail('没有预设内容就不该出行');
});
