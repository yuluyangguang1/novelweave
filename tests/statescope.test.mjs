import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWStateScope as S } from './_load.mjs';

// ═══════════════ 夹具 ═══════════════

/** 180 章、order 连号 —— 一本写到第三卷的书 */
const mk = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ id: `c${from + i}`, order: from + i, title: `第${from + i}章` }));
const orders = (win) => win.visible.map((c) => c.order);

// ═══════════════ 默认窗口 ═══════════════

test('默认窗口画的是最近那一页，且一页就是 WINDOW_SIZE 那一章数', () => {
  const win = S.windowOf(mk(180));
  assert.equal(win.visible.length, S.WINDOW_SIZE);
  assert.equal(win.last.order, 180, '最近那一章永远要在第一页里');
  assert.equal(win.first.order, 180 - S.WINDOW_SIZE + 1);
  assert.equal(win.hidden, 180 - S.WINDOW_SIZE);
  assert.equal(win.truncated, true);
  assert.equal(win.pages, Math.ceil(180 / S.WINDOW_SIZE));
  assert.equal(win.page, 0);
});

/**
 * 这个数写死是故意的：窗口大小改任何一个数都会改变「一次画多少个 td」，
 * 而那是这一批唯一的动机。测试里若只引用常量本身，改常量就改不出红 —— 见 roadmap 反验记录。
 * 来由（一页 ≈ 800 个 td 的 DOM 规模，以及实测「40 列把 table 撑到 2279px，而侧栏只有 300px」）
 * 写在 statescope.js 的注释里。
 */
test('WINDOW_SIZE 是 40：改了它就得同时改这里的出处说明', () => {
  assert.equal(S.WINDOW_SIZE, 40);
  assert.equal(S.SCOPE_VERSION, '1.0.0');
});

test('不足一页的书一章都不许被裁掉，话术也不许说「还有几章没画」', () => {
  const win = S.windowOf(mk(S.WINDOW_SIZE - 1));
  assert.equal(win.visible.length, S.WINDOW_SIZE - 1);
  assert.equal(win.truncated, false);
  assert.equal(win.hidden, 0);
  assert.ok(!S.lines(win).includes('没画出来'), S.lines(win));
});

test('恰好等于一页：不裁、不翻页、也不给翻页条', () => {
  const win = S.windowOf(mk(S.WINDOW_SIZE));
  assert.equal(win.visible.length, S.WINDOW_SIZE);
  assert.equal(win.pages, 1);
  assert.equal(win.canBack, false);
  assert.equal(win.canForward, false);
});

// ═══════════════ 翻页与边界 ═══════════════

test('往前翻是整页平移，不留半页重叠也不跳章', () => {
  const a = S.windowOf(mk(100), 40, 0);
  const b = S.windowOf(mk(100), 40, 1);
  assert.deepEqual(orders(a), Array.from({ length: 40 }, (_, i) => 61 + i));
  assert.deepEqual(orders(b), Array.from({ length: 40 }, (_, i) => 21 + i));
  assert.equal(b.visible.length, a.visible.length, '两页一样宽，翻页不会忽多忽少');
  assert.equal(b.last.order + 1, a.first.order, '两页正好相接：既不重叠也不漏一章');
});

test('最后一页只剩零头，就画零头而不是补空列', () => {
  const win = S.windowOf(mk(180), 40, 4);
  assert.equal(win.visible.length, 20);
  assert.deepEqual([win.first.order, win.last.order], [1, 20]);
  assert.equal(win.canBack, false, '已经是最早一页');
});

test('页码越界夹到最后一页，绝不给一张空表', () => {
  const win = S.windowOf(mk(180), 40, 99);
  assert.equal(win.page, win.pages - 1);
  assert.equal(win.visible.length, 20);
  assert.equal(win.first.order, 1);
});

test('负页码与非法窗口大小一律收回来，不许画 0 列', () => {
  assert.equal(S.windowOf(mk(50), 40, -3).page, 0);
  for (const bad of [0, -1, NaN, undefined, null]) {
    const win = S.windowOf(mk(100), bad);
    assert.equal(win.size, S.WINDOW_SIZE, `size=${String(bad)} 时应退回默认窗口`);
    assert.equal(win.visible.length, S.WINDOW_SIZE);
  }
  // 全书模式：size 就是章数，一页画完
  const all = S.windowOf(mk(180), 180);
  assert.equal(all.pages, 1);
  assert.equal(all.truncated, false);
});

// ═══════════════ 列序 ═══════════════

test('列序按 order 排，与库里回进来的顺序无关', () => {
  const shuffled = [{ id: 'b', order: 5 }, { id: 'a', order: 2 }, { id: 'c', order: 9 }];
  const win = S.windowOf(shuffled, 2);
  assert.deepEqual(orders(win), [5, 9]);
  assert.equal(S.spanText(win), '第 5–9 章');
});

test('删过章导致 order 断号时，跨度说真话、列数也说真话', () => {
  // 第 3 章被删了：列上只有 4 章，但跨度写「第 1–5 章」，两者都如实
  const win = S.windowOf([{ order: 1, id: 'a' }, { order: 2, id: 'b' }, { order: 4, id: 'd' }, { order: 5, id: 'e' }], 4);
  assert.equal(win.visible.length, 4);
  assert.equal(win.total, 4);
  assert.equal(S.spanText(win), '第 1–5 章');
  assert.ok(S.lines(win).includes('共 4 章里的 4 章'), S.lines(win));
});

test('单章跨度不说成「第 7–7 章」', () => {
  assert.equal(S.spanText(S.windowOf(mk(9), 1, 2)), '第 7 章');
});

// ═══════════════ 空与边界输入 ═══════════════

test('空书、null、缺 order 一律不崩，也不说「画的是第 undefined 章」', () => {
  for (const input of [[], null, undefined]) {
    const win = S.windowOf(input);
    assert.equal(win.total, 0);
    assert.equal(win.visible.length, 0);
    assert.equal(S.spanText(win), '没有章节');
    assert.equal(S.lines(win), '这本书还没有章节。');
  }
  const noOrder = S.windowOf([{ id: 'a' }, { id: 'b', order: 4 }], 1);
  assert.deepEqual(orders(noOrder), [4], '缺 order 的排在前面，窗口取的是最后那一列');
});

test('idSet 就是窗口内那几章，数格子靠它，不许界面自己 filter 一遍窗口', () => {
  const win = S.windowOf(mk(10), 4);
  const set = S.idSet(win);
  assert.deepEqual([...set].sort(), ['c10', 'c7', 'c8', 'c9'].sort());
  assert.deepEqual([...S.idSet(null)], []);
});

// ═══════════════ 图例那一句 ═══════════════

test('图例三件事齐全：画哪几章、还剩几章、这一页的格数与全书的格数', () => {
  const win = S.windowOf(mk(180), 40, 1);
  const line = S.lines(win, { inWindow: 37, total: 412 });
  assert.ok(line.includes('第 101–140 章'), line);
  assert.ok(line.includes('共 180 章里的 40 章'), line);
  assert.ok(line.includes('还有 140 章更早的没画出来'), line);
  assert.ok(line.includes('这一页 37 格 · 全书 412 格'), line);
});

test('两数相等时只说一个数：没有「这一页 40 格 · 全书 40 格」这种自问自答', () => {
  const line = S.lines(S.windowOf(mk(180)), { inWindow: 40, total: 40 });
  assert.equal(line.includes('这一页'), false, line);
  assert.ok(line.includes('已记录 40 格'), line);
});

test('没数格子时图例不编一个数出来', () => {
  assert.equal(S.lines(S.windowOf(mk(5))).includes('格'), false);
});

test('pageCount：空书也算一页，否则选择器上会写「第 0/0 页」', () => {
  assert.equal(S.pageCount(0, 40), 1);
  assert.equal(S.pageCount(40, 40), 1);
  assert.equal(S.pageCount(41, 40), 2);
  assert.equal(S.pageCount(10, 0), 1);
});

// ═══════════════ 范围条该不该出现 ═══════════════

/**
 * 这一组是浏览器真点撞出来的：旧写法拿「当前窗口画完了没」当判据，
 * 于是全书模式下整条消失，「收成一片」那颗按钮跟着没了 —— 进得去回不来。
 */
test('needsScopeBar 判的是这本书比默认窗口长，不是当前这一窗画完了没', () => {
  assert.equal(S.needsScopeBar(S.windowOf(mk(S.WINDOW_SIZE))), false, '刚好一窗：没什么可翻的');
  assert.equal(S.needsScopeBar(S.windowOf(mk(S.WINDOW_SIZE + 1))), true, '多一章就得给条，不然那一章永远看不见');
  assert.equal(S.needsScopeBar(S.windowOf(mk(180), 40, 3)), true);
  // 全书模式：truncated 是 false、pages 是 1，按旧判据这里会给出「不用给条」
  assert.equal(S.needsScopeBar(S.windowOf(mk(180), 180, 0)), true, '全书模式也得留着退回分页的那颗按钮');
});

test('needsScopeBar 对残缺输入不抛：没窗口、空书都算不给条', () => {
  assert.equal(S.needsScopeBar(null), false);
  assert.equal(S.needsScopeBar(undefined), false);
  assert.equal(S.needsScopeBar(S.windowOf([])), false);
});
