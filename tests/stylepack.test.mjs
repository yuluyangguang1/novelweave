/**
 * 去 AI 味规则包（src/core/stylepack.js）单元测试。
 *
 * 这个包的全部价值在于「不误伤」：中文里单个「仿佛」不是错。
 * 所以每组门槛都单独钉一条，改门槛的人必须连测试一起改。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWStylePack } from './_load.mjs';

const P = NWStylePack;

test('八组禁词各组都能命中，且报出组 id', () => {
  const cases = [
    ['psych', '他心里五味杂陈，说不出是什么滋味。'],
    ['simile', '山门在雾里，仿佛一座悬在半空的桥。'],
    ['eyes', '她眼中闪过一丝迟疑，随即按住了刀。'],
    ['abstract', '这一刻，这一切都有了别的分量。'],
    ['connective', '然而事情并不是这样。与此同时，山下起了风。'],
    ['rhetorical', '谁能想到那匣子里装的是半枚铜印。'],
    ['intensifier', '他非常疲惫，神色却格外清醒。'],
    ['aphorism', '刀归鞘，灯吹灭。这便是所谓成长。'],
  ];
  for (const [group, text] of cases) {
    const hit = P.lint(text).banned.find((b) => b.group === group);
    assert.ok(hit, `组 ${group} 没命中：${text}`);
  }
});

test('副词堆叠同段只出现一次不算，两次才算（单个「非常」是正常中文）', () => {
  assert.equal(P.lint('他非常疲惫，站在阶前没有动。').banned.filter((b) => b.group === 'intensifier').length, 0);
  assert.equal(P.lint('他非常疲惫，神色却格外清醒。').banned.filter((b) => b.group === 'intensifier').length, 2);
});

test('段尾金句只在收尾窗口内算，写在段中不当金句', () => {
  const mid = '这便是他唯一剩下的东西，一只磨得发亮的木匣，跟了他二十年，从不离身。';
  const tail = '一只磨得发亮的木匣，跟了他二十年，从不离身。这便是他唯一剩下的东西。';
  assert.equal(P.lint(mid).banned.filter((b) => b.group === 'aphorism').length, 0);
  assert.ok(P.lint(tail).banned.some((b) => b.group === 'aphorism'));
});

test('重叠命中只算一条：「心里五味杂陈」不再重复报「五味杂陈」', () => {
  const terms = P.lint('他愣在原地，心里五味杂陈，久久没有说话。').banned.map((b) => b.term);
  assert.deepEqual(terms, ['心里五味杂陈']);
});

test('长词优先：「这一刻」命中时不会再嵌套报出「此刻」', () => {
  const terms = P.lint('这一刻，他忽然想通了那件事的来龙去脉。').banned.map((b) => b.term);
  assert.deepEqual(terms, ['这一刻']);
});

test('每条命中带原文偏移，证据必须能 slice 回原词', () => {
  const text = '夜色压下来。\n\n她仿佛听见有人在唤她的名字，声音很远，隔着半座山。';
  for (const b of P.lint(text).banned) {
    assert.equal(text.slice(b.at, b.at + b.term.length), b.term, `偏移对不上：${b.term}@${b.at}`);
    assert.ok(b.quote.includes(b.term), '引证里没有那个词');
  }
});

test('作者关掉某组就不再命中；自定义禁词以「custom」组命中', () => {
  const text = '他眼中闪过一丝迟疑。紫气东来，山门洞开。';
  const opts = { disabled: ['eyes'], extraBanned: ['紫气东来'] };
  const hits = P.lint(text, opts).banned;
  assert.equal(hits.find((h) => h.group === 'eyes'), undefined);
  assert.equal(hits.find((h) => h.group === 'custom').term, '紫气东来');
  // 不关时就该报出来
  assert.ok(P.lint(text).banned.some((h) => h.group === 'eyes'));
});

test('句式：连续三句同一开头才算，两句不算', () => {
  const two = P.lint('他站起来。他走到阶前，夜风把衣角吹得贴在腿上。');
  const three = P.lint('他站起来。他走到阶前。他推开那扇门，门后的黑暗里什么声音都没有。');
  assert.equal(two.patterns.some((p) => p.id === 'same-subject'), false);
  assert.ok(three.patterns.some((p) => p.id === 'same-subject'));
});

test('句式：三短句连击与二元对照句（后者要放过「没有…只是」那种正常写法）', () => {
  assert.ok(P.lint('他停下。刀出鞘。风也止。山门前的石阶上一滴血慢慢渗开，渗进砖缝里。')
    .patterns.some((p) => p.id === 'short-triple'));
  assert.ok(P.lint('他要的不是宽恕，而是把账算清楚。').patterns.some((p) => p.id === 'binary-contrast'));
  assert.equal(P.lint('他没有回头，只是加快了脚步，走进雨里。').patterns.some((p) => p.id === 'binary-contrast'), false);
});

test('句式：连续三段无对话才报，中间有一句台词就不算', () => {
  const para = '夜色从山脊上漫下来，把整座道观压成一团模糊的轮廓，檐角的铜铃在风里轻轻撞了一下。';
  assert.equal(para.length >= 40, true, '这条测试的段落得够长，否则测的是门槛而不是连击');
  assert.ok(P.lint([para, para, para].join('\n\n')).patterns.some((p) => p.id === 'no-dialogue'));
  assert.equal(P.lint([para, '「谁？」', para, para].join('\n\n'))
    .patterns.some((p) => p.id === 'no-dialogue'), false);
});

test('句式：破折号按千字密度算，长文里偶尔一处不算', () => {
  const filler = '夜色压下来，山门的灯一盏一盏灭在半山腰，只剩廊下那一盏还亮着。'.repeat(20);
  assert.equal(P.lint(filler + '他抬手——停在半空。').patterns.some((p) => p.id === 'dash-insert'), false);
  const many = Array.from({ length: 8 }, () => '他抬手——很轻——又落下——停在半空——').join('');
  assert.ok(P.lint(many).patterns.some((p) => p.id === 'dash-insert'));
});

test('verdict：干净文本不给结论', () => {
  const clean = '师父把匣子推过来，压在桌心。\n「拿着。」\n林烟火没接。她盯着那道火漆，看了一会儿，才伸手。\n'
    + '匣底垫着半枚铜印，边缘还带着热气。\n「这是你爹留下的。」师父说，「只剩半枚了。」\n'
    + '她把铜印捏起来，指腹擦过断口。断口很新，是这几日才崩开的。\n窗外有人踩碎了枯枝，声音止在阶前。';
  const r = P.lint(clean);
  assert.deepEqual(P.verdict(r), { severity: null, reasons: [] });
});

test('verdict：太短的段落不评（一段闲笔不该被当成文风问题）', () => {
  const r = P.lint('他仿佛非常疲惫，仿佛累了，又仿佛根本没有。');
  assert.ok(r.banned.length >= 3, '这条样本得先真的踩到禁词');
  assert.equal(r.words < 500, true);
  assert.equal(P.verdict(r).severity, null);
});

test('verdict：只踩密度是 info，密度高或两类句式升 warn', () => {
  const lines = [
    '他仿佛望出去，那一刻只觉得非常疲惫，又格外冷清。',
    '夜色漫过石阶，她似乎听见远处有人在唤名，心里五味杂陈。',
    '山门前的风停了，这一刻恍若隔世，他忍不住攥紧了袖中的刀。',
  ].join('');
  const densityOnly = P.lint(lines.repeat(8));
  assert.equal(densityOnly.words >= 500, true, '样本要长过不评线，否则测的是门槛而不是密度');
  assert.equal(densityOnly.patterns.length, 0, `这条样本不该踩到句式判据：${densityOnly.patterns.map((p) => p.id)}`);
  assert.equal(P.verdict(densityOnly).severity, 'warn', `密度 ${densityOnly.per1000}/千字 应到 warn`);
  const infoOnly = { words: 3000, per1000: 2, patterns: [] };
  assert.equal(P.verdict(infoOnly).severity, 'info');
  const twoPatterns = { words: 3000, per1000: 0, patterns: [{ label: 'A' }, { label: 'B' }] };
  assert.equal(P.verdict(twoPatterns).severity, 'warn');
});

test('promptBlock 列出启用组、不列被关掉的组，且长度受预算约束', () => {
  const all = P.promptBlock();
  for (const g of P.GROUPS) assert.ok(all.includes(g.label), `清单里没有组 ${g.label}`);
  assert.ok(all.length <= 600, `注入段 ${all.length} 字，抢的是正文预算`);
  const off = P.promptBlock({ disabled: ['eyes'], extraBanned: ['紫气东来'] });
  assert.equal(off.includes('眼神套路'), false);
  assert.ok(off.includes('紫气东来'));
});

test('optsFrom 只认 book.stylePack，没有就用默认包', () => {
  assert.deepEqual(P.optsFrom({}), { enabled: true, disabled: [], extraBanned: [] });
  assert.deepEqual(P.optsFrom(null), { enabled: true, disabled: [], extraBanned: [] });
  assert.deepEqual(P.optsFrom({ stylePack: { disabled: ['simile'], extraBanned: ['系统提示'] } }),
    { enabled: true, disabled: ['simile'], extraBanned: ['系统提示'] });
  assert.equal(P.optsFrom({ stylePack: { enabled: false } }).enabled, false);
});

test('enabled:false 是整包停用，三处出口一起哑掉', () => {
  // 开关写在包里而不是调用方，是因为有三个消费者（prompt / R22 / CLI lint）——
  // 任何一处自己判断，另外两处就会继续拿默认值跑，作者按了关却没关。
  const text = '他心里五味杂陈，仿佛夜色压下来，非常疲惫，神色又格外冷清，这一刻什么都静了。'.repeat(18);
  const on = P.lint(text);
  assert.ok(on.words >= 500, `夹具本身要够长，否则下面的 null 是蒙对的：${on.words} 字`);
  assert.ok(on.banned.length > 0 && on.patterns.length > 0, '夹具没电：开着都查不出东西');
  const r = P.lint(text, { enabled: false });
  assert.deepEqual(r.banned, []);
  assert.deepEqual(r.patterns, []);
  assert.equal(r.per1000, 0);
  assert.equal(r.words > 0, true, '字数还是要算，调用方拿它做展示');
  assert.equal(P.verdict(r).severity, null);
  assert.equal(P.promptBlock({ enabled: false }), '');
});

test('八组全关掉时 promptBlock 不给空壳，关掉一组只少那一组', () => {
  assert.equal(P.promptBlock({ disabled: P.GROUPS.map((g) => g.id) }), '',
    '只剩句式行的空壳照样占预算，等于没关');
  const one = P.promptBlock({ disabled: ['simile'] });
  assert.ok(!one.includes('比喻引导词'), '关掉的组不该还在 prompt 里');
  assert.ok(one.includes('心理直说'), '没关的组必须还在');
});

test('包里的词不重复、组 id 唯一，且都是能在正文里字面找到的短词', () => {
  const ids = P.GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  const seen = new Set();
  for (const g of P.GROUPS) {
    for (const t of g.terms) {
      assert.ok(!seen.has(t), `同一个词登记在两组：${t}`);
      seen.add(t);
      assert.ok(t.length >= 2 && t.length <= 8, `词长不合适：${t}`);
    }
  }
  assert.ok(P.GROUPS.length >= 8);
  assert.equal(P.PATTERNS.length, 5);
});

test('paragraphs 与 sentences 是导出的：R23/R26 复用同一把刀，不再造第二个切分器', () => {
  assert.equal(typeof P.paragraphs, 'function');
  assert.equal(typeof P.sentences, 'function');
  const body = '他来了。\n\n她转身往外走，雾还没有散。\n\n山门很远。';
  const paras = P.paragraphs(body);
  assert.equal(paras.length, 3);
  const sents = paras.flatMap((p) => P.sentences(p));
  assert.deepEqual(sents.map((s) => s.text), ['他来了', '她转身往外走，雾还没有散', '山门很远']);
  for (const s of sents) assert.equal(body.slice(s.start, s.start + s.text.length), s.text, '偏移必须能回查原文');
});
