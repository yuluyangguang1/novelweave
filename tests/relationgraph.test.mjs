/**
 * 关系图的判据。这个文件要钉住的是四句话：
 * 端点认谁、区间到第几章算活着、网分成几块、画出来的那张图长什么样。
 * 每条判据都配一正一反 —— 「不该报」那一半是本文件的主要价值：
 * 一张会把好数据也报成缺口的图，作者点两次就不点了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NWRelationGraph as G } from './_load.mjs';

const chars = (...ns) => ns.map((n, i) => (typeof n === 'string' ? { id: `c${i + 1}`, name: n } : { id: `c${i + 1}`, ...n }));
const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `ch-${i + 1}`, number: i + 1, order: i + 1 }));
const edge = (id, from, to, kind = '同门', extra = {}) => ({ id, from, to, kind, ...extra });

const build = (characters, edges, chapters = many(6), cut = null) =>
  G.build({ characters, edges, chapters, cut });

// ═══════════════ 端点：这条边连着谁 ═══════════════

test('端点解析：id 命中最好，名字命中算接上但标出来，认不出与撞同名都不猜', () => {
  const idx = G.charIndex([{ id: 'a', name: '林烟火' }, { id: 'b', name: '明长老' }, { id: 'c', name: '林烟火' }]);
  assert.deepEqual(G.endpointOf('a', idx), { ok: true, id: 'a', via: 'id', name: '林烟火' });
  assert.deepEqual(G.endpointOf('明长老', idx), { ok: true, id: 'b', via: 'name', name: '明长老' });
  // 同名两个人：挑一个画，那条线连到谁作者就会当成账本里说的那个人
  assert.equal(G.endpointOf('林烟火', idx).ok, false);
  assert.equal(G.endpointOf('林烟火', idx).reason, 'ambiguous');
  assert.equal(G.endpointOf('没这个人', idx).reason, 'unknown');
  assert.equal(G.endpointOf('', idx).reason, 'empty');
  assert.equal(G.endpointOf(null, idx).reason, 'empty');
  assert.equal(G.endpointOf('  ', idx).reason, 'empty', '只有空格也算没填，不许当成一个名字');
});

test('charIndex 只认本书角色卡，重复行与没 id 的行不进表', () => {
  const idx = G.charIndex([{ id: 'a', name: '甲' }, { id: 'a', name: '甲' }, { name: '没 id' }, null, undefined]);
  assert.equal(idx.byId.size, 1);
  assert.equal(idx.byName.has('没 id'), false);
});

test('某一头连不到角色的边进 dangling，说清是哪一头、为什么；自环单独一桶', () => {
  const cs = chars('林烟火', '明长老');
  const g = build(cs, [edge('e1', 'c1', 'ghost'), edge('e2', 'nope', 'c2'), edge('e3', 'c1', 'c1')]);
  assert.equal(g.counts.dangling, 2);
  assert.deepEqual(g.dangling[0].missing, [{ side: 'to', ref: 'ghost', reason: 'unknown' }]);
  assert.deepEqual(g.dangling[1].missing, [{ side: 'from', ref: 'nope', reason: 'unknown' }]);
  // 自环两头都解析得到，是同一个人 —— 那句「连不到任何角色」用在它身上就是错的
  assert.equal(g.counts.selfLoops, 1);
  assert.deepEqual(g.selfLoops.map((s) => s.at), ['c1']);
  assert.equal(g.counts.links, 0, '画不出来的边不许进 links，否则图上会有一条通往不存在角色的线');
});

test('靠名字连着的边算接上，但要数得出来（改名即断）', () => {
  const g = build(chars('林烟火', '明长老'), [edge('e1', '林烟火', '明长老'), edge('e2', 'c1', 'c2')]);
  assert.equal(g.counts.byName, 1);
  assert.equal(g.counts.links, 2);
  assert.deepEqual([g.links[0].via, g.links[1].via], [{ from: 'name', to: 'name' }, { from: 'id', to: 'id' }]);
});

// ═══════════════ 区间：到第几章还算活着 ═══════════════

test('rangeOf：两头都没填 = 一直如此；只填一头补到书边，但补出来的那一边不算作者填的', () => {
  const ch = many(6);
  assert.deepEqual(G.rangeOf({}, ch), { ok: true, open: true, sinceSet: false, untilSet: false, from: 0, to: 5 });
  assert.equal(G.rangeOf({ since: 'ch-3' }, ch).to, 5);
  assert.equal(G.rangeOf({ since: 'ch-3' }, ch).open, false);
  assert.deepEqual([G.rangeOf({ since: 'ch-3' }, ch).sinceSet, G.rangeOf({ since: 'ch-3' }, ch).untilSet],
    [true, false], '只填起点：起点是作者说的，书边那一端是补的');
  assert.deepEqual([G.rangeOf({ until: 'ch-2' }, ch).sinceSet, G.rangeOf({ until: 'ch-2' }, ch).untilSet],
    [false, true]);
  assert.equal(G.rangeOf({ until: 'ch-2' }, ch).from, 0);
});

test('rangeOf 判坏的两种成因分开：missing 是章被删了，reversed 是填反了', () => {
  const ch = many(6);
  assert.deepEqual(G.rangeOf({ since: 'ch-99', until: 'ch-2' }, ch),
    { ok: false, reason: 'missing', sinceSet: true, untilSet: true, from: -1, to: -1, open: false });
  assert.equal(G.rangeOf({ since: 'ch-2', until: 'ch-99' }, ch).reason, 'missing', '只有 until 认不出也是 missing');
  assert.deepEqual(G.rangeOf({ since: 'ch-5', until: 'ch-2' }, ch),
    { ok: false, reason: 'reversed', sinceSet: true, untilSet: true, from: 4, to: 1, open: false });
});

test('没有章目录时空区间仍算 open，填了一头的判坏而不是从 0 到 -1', () => {
  assert.equal(G.rangeOf({}, []).open, true);
  assert.equal(G.rangeOf({}, []).to, 0, '空书里 to 夹到 0，不出现负下标');
  assert.equal(G.rangeOf({ since: 'ch-1' }, []).reason, 'missing');
});

test('stateOf 看的是目标章：决裂那一章仍活着，之后才结束，之前还没开始', () => {
  const ch = many(6);
  const r = G.rangeOf({ since: 'ch-2', until: 'ch-4' }, ch);
  assert.equal(G.stateOf(r, 0), 'future', '第 1 章里这段关系还没开始，写进去就是剧透');
  assert.equal(G.stateOf(r, 1), 'active');
  assert.equal(G.stateOf(r, 3), 'active', 'until 那一章本身仍在区间内');
  assert.equal(G.stateOf(r, 4), 'ended');
  assert.equal(G.stateOf(r, null), 'ended', '没给 cut 就按全书末尾看（面板要的是这个）');
  assert.equal(G.stateOf(G.rangeOf({}, ch), 4), 'open');
  assert.equal(G.stateOf({ ok: false, reason: 'missing' }, 4), 'bad', '判坏的区间不裁也不列，交给那句缺口');
});

test('只填了起点的边永远没结束：续写下一章、甚至不看 cut 时都不算「已结束」', () => {
  const ch = many(6);
  const r = G.rangeOf({ since: 'ch-2' }, ch);
  assert.equal(G.stateOf(r, 3), 'active');
  assert.equal(G.stateOf(r, 5), 'active', '切到补出来的那一端（第 6 章）仍活着');
  assert.equal(G.stateOf(r, 6), 'active', '写第 7 章（cut=书长）时它还在约束 —— 作者没说要结束');
  assert.equal(G.stateOf(r, null), 'active', '面板那一头同理：「没填」不等于「结束了」');
  assert.equal(G.stateOf(r, 0), 'future', '起点之前还是还没开始，这一条不受影响');
  assert.equal(G.stateOf(G.rangeOf({ until: 'ch-2' }, ch), 5), 'ended', '填了终点的才真的会结束');
});

test('rangeText 说作者说过的那一头：补出来的书边不冒充登记过的终点', () => {
  const ch = many(6);
  const line = (over) => G.rangeText({ range: G.rangeOf(over, ch) }, ch);
  assert.equal(line({}), '一直如此');
  assert.equal(line({ since: 'ch-2' }), '自第 2 章起', '写成「第 2–6 章」等于替账本多说了一句「第 6 章结束了」');
  assert.equal(line({ until: 'ch-4' }), '至第 4 章');
  assert.equal(line({ since: 'ch-2', until: 'ch-4' }), '第 2–4 章');
  assert.equal(line({ since: 'ch-4', until: 'ch-4' }), '第 4 章');
  assert.equal(line({ since: 'ch-99' }), '起止章不在书里');
  assert.equal(line({ since: 'ch-5', until: 'ch-2' }), '起止章填反了');
});

// ═══════════════ 网：几块、谁在网外 ═══════════════

test('连通分量按无向算，方向相反也算一块；孤立角色单独一桶', () => {
  const cs = chars('甲', '乙', '丙', '丁', '戊');
  const g = build(cs, [edge('e1', 'c1', 'c2'), edge('e2', 'c3', 'c1'), edge('e3', 'c5', 'c4')]);
  assert.deepEqual(g.components.map((c) => c.nodes), [['c1', 'c2', 'c3'], ['c4', 'c5']]);
  assert.equal(g.counts.components, 2);
  assert.deepEqual(g.unlinked, [], '五个角色都在网里');
  const g2 = build([{ id: 'c1', name: '甲' }, { id: 'c2', name: '乙' }, { id: 'z', name: '路人' }],
    [edge('e1', 'c1', 'c2')]);
  assert.deepEqual(g2.unlinked, ['z']);
  assert.equal(g2.counts.unlinked, 1);
});

test('坏区间与靠名字的边照样连：区间坏了不等于这条关系不存在', () => {
  const g = build(chars('甲', '乙'), [edge('e1', 'c1', 'c2', '师徒', { since: 'ch-9' })]);
  assert.equal(g.links[0].state, 'bad');
  assert.deepEqual(g.components[0].nodes, ['c1', 'c2']);
  assert.equal(g.counts.bad, 1);
  assert.equal(g.counts.missing + g.counts.reversed, g.counts.bad, '判坏的边只可能有那两种成因');
});

test('同 id 两条边不会互相覆盖着数漏：第二条进 skipped，缺口那句话要说', () => {
  const es = [edge('e1', 'c1', 'c2'), edge('e1', 'c2', 'c1', '敌对')];
  const g = build(chars('甲', '乙'), es);
  assert.equal(g.counts.edges, 2);
  assert.equal(g.counts.skipped, 1);
  assert.equal(g.links.length, 1);
  assert.equal(g.links[0].kind, '同门');
  assert.match(G.notice(g), /1 条边没有 id 或与别的边同 id/);
  // 面板要顶标签的是**那一条**卡片，不是随便一张：skippedEdges 存的是原样记录（同一个对象），
  // 只给个数的话，两张卡片会长得一模一样，而其中一张是改不动的。
  assert.deepEqual(g.skippedEdges, [es[1]]);
  assert.equal(g.skippedEdges[0].kind, '敌对');
});

test('残缺输入一律不抛：没角色、没边、没章、参数整个不给', () => {
  assert.equal(G.build({}).counts.characters, 0);
  assert.equal(build([], []).counts.edges, 0);
  const g = build(chars('甲'), [null, undefined, {}, edge('e', 'c1', '')]);
  assert.deepEqual([g.counts.dangling, g.counts.skipped, g.counts.edges], [1, 1, 2],
    '数组里的空洞不算一条边，没 id 的那条要数进 skipped 而不是消失');
  assert.deepEqual(g.skippedEdges.map((x) => x.id), [undefined], '空洞不进 skippedEdges：它连一条记录都不是');
  const lay = G.layout(G.build({}));
  assert.deepEqual(lay.nodes, []);
  assert.equal(lay.radius, 0);
});

// ═══════════════ 布局：确定性 + 不相撞 ═══════════════

test('同一份输入两次布局出同一张图（没有力导向，也就没有每帧一抖）', () => {
  const cs = chars('甲', '乙', '丙', '丁');
  const es = [edge('e1', 'c1', 'c2'), edge('e2', 'c3', 'c4')];
  const a = G.layout(build(cs, es));
  const b = G.layout(build(cs, es.slice().reverse()));
  assert.deepEqual(a.nodes, b.nodes, '边在数组里的顺序不该改变谁站在圆上哪一处');
});

test('任意两节点的弦长不低于 NODE_SPACING，分量在圆上各占连续一段', () => {
  for (let n = 2; n <= G.MAX_NODES; n++) {
    const cs = Array.from({ length: n }, (_, i) => ({ id: `k${i}`, name: `角${i}` }));
    const es = Array.from({ length: n - 1 }, (_, i) => edge(`e${i}`, `k${i}`, `k${i + 1}`));
    const g = build(cs, es, many(6));
    const lay = G.layout(g);
    let min = Infinity;
    for (let i = 0; i < lay.nodes.length; i++) {
      for (let j = i + 1; j < lay.nodes.length; j++) {
        min = Math.min(min, Math.hypot(lay.nodes[i].x - lay.nodes[j].x, lay.nodes[i].y - lay.nodes[j].y));
      }
    }
    assert.ok(min >= G.NODE_SPACING - 0.2, `n=${n} 时最小间距 ${min}`);
    assert.ok(G.isContiguous(lay, g), `n=${n} 时分量被拆散成几段，图上会交错穿插`);
    assert.ok(lay.radius <= G.RADIUS_MAX, `n=${n} 时半径溢出画布`);
  }
});

test('超过 MAX_NODES 的角色不画，但 hidden 要数得出来 —— 悄悄少画比没图更坏', () => {
  const cs = Array.from({ length: G.MAX_NODES + 5 }, (_, i) => ({ id: `k${i}`, name: `角${i}` }));
  const g = build(cs, [edge('e1', 'k0', 'k1')], many(6));
  const lay = G.layout(g);
  assert.equal(lay.nodes.length, G.MAX_NODES);
  assert.equal(lay.hidden.length, 5);
  assert.match(G.notice(g, lay), /5 个角色没画进来/);
  assert.equal(G.layout(g, { limit: 3 }).nodes.length, 3, 'limit 只能往小调，调不过 MAX_NODES 就没有间距保证了');
});

test('一个节点站在圆心，两个节点分列两侧', () => {
  const one = G.layout(build(chars('甲'), [], many(6)));
  assert.deepEqual([one.nodes[0].x, one.nodes[0].y], [one.cx, one.cy]);
  assert.equal(one.radius, 0);
  const two = G.layout(build(chars('甲', '乙'), [edge('e1', 'c1', 'c2')], many(6)));
  assert.equal(two.nodes.length, 2);
  assert.ok(Math.hypot(two.nodes[0].x - two.nodes[1].x, two.nodes[0].y - two.nodes[1].y) >= G.NODE_SPACING);
  // 半径取的是 max(RADIUS_MIN, need)，两头都得有人钉：
  // 只钉 need 的话，把夹取下界写坏（永远给 RADIUS_MAX）没人报 —— 两个人的书会摊满整张画布，
  // 一条边拉成一寸长；只钉下限的话，need 算错也没人报 —— 角色一多就撞在一起。
  assert.equal(two.radius, G.RADIUS_MIN, '两个角色就撑到最大半径，画布上下方各一个点');
  assert.ok(G.layout(build(chars('甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬'),
    [edge('e1', 'c1', 'c2')], many(6))).radius === G.RADIUS_MIN, '9 个以内都还该待在下限上');
  const ten = G.layout(build(Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, name: `角${i}` })),
    [edge('e1', 'k0', 'k1')], many(6)));
  assert.ok(ten.radius > G.RADIUS_MIN, `10 个角色时半径该由 need 决定，不该还钉在下限上（实际 ${ten.radius}）`);
});

test('画布尺寸与间距是钉死的数：改了它们要一并改上面那段理由', () => {
  assert.equal(G.MAX_NODES, 22);
  assert.equal(G.NODE_SPACING, 56);
  assert.equal(G.RADIUS_MAX, 210);
  assert.equal(G.RELATION_LINES, 10);
});

// ═══════════════ SVG：画出来的到底是什么 ═══════════════

test('toSvg：节点数与被画出来的边数对得上，藏起来的角色不带边', () => {
  const cs = chars('甲', '乙', '丙');
  const g = build(cs, [edge('e1', 'c1', 'c2'), edge('e2', 'c2', 'c3')], many(6));
  const svg = G.toSvg(g);
  assert.equal((svg.match(/class="rg-node[ "]/g) || []).length, 3);
  assert.equal((svg.match(/<line /g) || []).length, 2);
  assert.match(svg, /data-edge="e1"/);
  assert.match(svg, /aria-label="关系图：3 个角色、2 条边"/);
  const chain = Array.from({ length: G.MAX_NODES + 3 }, (_, i) => ({ id: `k${i}`, name: `角${i}` }));
  const big = build(chain, chain.slice(1).map((_, i) => edge(`e${i}`, `k${i}`, `k${i + 1}`)), many(6));
  const svg2 = G.toSvg(big);
  assert.equal((svg2.match(/<line /g) || []).length, G.MAX_NODES - 1,
    '一条链上被藏起 3 个人，最后那两条边就不该在图上');
  assert.equal((svg2.match(/class="rg-node[ "]/g) || []).length, G.MAX_NODES);
  assert.match(svg2, /aria-label="[^"]*3 个角色没画进来/, '没画进来的人得在图的自述里');
});

test('边的 class 跟着区间状态走，坏边画成坏边而不是悄悄消失', () => {
  const g = build(chars('甲', '乙', '丙', '丁'), [
    edge('e1', 'c1', 'c2'), edge('e2', 'c2', 'c3', '师徒', { since: 'ch-9' }),
    edge('e3', 'c3', 'c4', '同门', { since: 'ch-1', until: 'ch-2' }),
  ], many(6), 5);
  const svg = G.toSvg(g);
  assert.match(svg, /class="rg-link rg-open" data-edge="e1"/);
  assert.match(svg, /class="rg-link rg-bad" data-edge="e2"/);
  assert.match(svg, /class="rg-link rg-ended" data-edge="e3"/);
});

test('角色名与称谓一律转义：账本里写个 <img> 不该变成一次执行', () => {
  const g = build([{ id: 'a', name: '<img src=x onerror=alert(1)>' }, { id: 'b', name: '乙"&onmouseover=1' }],
    [edge('e1', 'a', 'b', '甲', { address: '"><script>' })], many(6));
  const svg = G.toSvg(g);
  assert.ok(!svg.includes('<img'), svg.slice(0, 200));
  assert.ok(!svg.includes('<script'), svg.slice(0, 200));
  assert.match(svg, /&lt;img/);
  assert.match(svg, /aria-label="[^"]*"/);
});

test('孤立角色顶一颗 rg-unlinked，鼠标停上去说清他零条关系', () => {
  const g = build(chars('甲', '乙'), [edge('e1', 'c1', 'c2'), edge('e2', 'c2', 'c2')], many(6));
  const g2 = build([...chars('甲', '乙'), { id: 'z', name: '路人' }], [edge('e1', 'c1', 'c2')], many(6));
  assert.match(G.toSvg(g), /class="rg-node" data-id="c1" data-degree="1"/);
  assert.match(G.toSvg(g2), /class="rg-node rg-unlinked" data-id="z" data-degree="0"/);
  assert.match(G.toSvg(g2), /路人 · 0 条关系/);
});

// ═══════════════ 那句缺口 ═══════════════

test('notice 五种成因按固定顺序说，一种都不混', () => {
  const cs = [...chars('甲', '乙', '丙', '丁'), { id: 'z', name: '路人' }];
  const g = build(cs, [
    edge('e1', 'c1', 'c2'),
    edge('e2', '丙', 'c4'),
    edge('e3', 'c1', 'ghost'),
    edge('e4', 'c1', 'c2', '师徒', { since: 'ch-5', until: 'ch-2' }),
    edge('e5', 'c1', 'c4', '同门', { since: 'ch-9' }),
    edge('e6', 'c2', 'c2', '自言自语'),
  ], many(6));
  assert.deepEqual(G.notice(g).split(' · '), [
    '1 条边的某一头连不到任何角色，画不出来',
    '1 条边的两头是同一个角色',
    '1 条边靠名字连着，改个名字就断',
    '2 条边的生效区间是坏的（1 条的起止章在书里读不出来、1 条填反了）',
    '1 个角色一条关系都没登记',
  ], G.notice(g));
  assert.doesNotMatch(G.notice(build(chars('甲', '乙', '丙'), [edge('e1', 'c1', 'c2')], many(6))), /互不相连/,
    '只有一块时「几块互不相连」是句自问自答');
  const two = build(chars('甲', '乙', '丙', '丁'), [edge('e1', 'c1', 'c2'), edge('e2', 'c3', 'c4')], many(6));
  assert.match(G.notice(two), /图上有 2 块互不相连/);
});

test('一条边都没登记的书不开口：那是还没用这套东西，不是有缺口', () => {
  assert.equal(G.notice(build(chars('甲', '乙', '丙'), [], many(6))), '');
  assert.equal(G.notice(null), '');
  assert.equal(G.notice({ counts: { edges: 0 } }), '');
});

// ═══════════════ prompt 那一层 ═══════════════

test('activeLines：没开始的与已经结束的都不列，本章无关的角色也不列', () => {
  const cs = chars('甲', '乙', '丙', '丁');
  const g = build(cs, [
    edge('e1', 'c1', 'c2', '师徒', { address: '师父' }),
    edge('e2', 'c3', 'c4', '敌对', { since: 'ch-5', until: 'ch-6' }),
    edge('e3', 'c1', 'c4', '同门', { since: 'ch-1', until: 'ch-2' }),
  ], many(6), 2);
  assert.deepEqual(G.activeLines(g, new Set(['c1']), many(6)), [
    '- 甲 → 乙：师徒（称谓「师父」）（一直如此）',
  ], JSON.stringify(G.activeLines(g, new Set(['c1']), many(6))));
  assert.equal(G.activeLines(g, null, many(6)).length, 1,
    '整张网里只剩这一条还活着：future 与 ended 都不该进 prompt');
  const open = build(cs, [edge('e1', 'c1', 'c2'), edge('e2', 'c3', 'c4')], many(6), 2);
  assert.equal(G.activeLines(open, new Set(), many(6)).length, 2, '没给在场角色就不过滤');
});

test('activeLines 到 RELATION_LINES 就截，且截的是行不是半句话', () => {
  const cs = Array.from({ length: G.RELATION_LINES + 6 }, (_, i) => ({ id: `k${i}`, name: `角${i}` }));
  const es = cs.map((_, i) => edge(`e${i}`, `k${i}`, `k${(i + 1) % cs.length}`));
  const lines = G.activeLines(build(cs, es, many(6)), null, many(6));
  assert.equal(lines.length, G.RELATION_LINES);
  assert.ok(lines.every((l) => l.startsWith('- ') && l.endsWith('）')), lines.join('\n'));
});
