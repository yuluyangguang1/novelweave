/**
 * NovelWeave · 织文 — 状态矩阵的显示范围（UMD：浏览器与 Node 共用）
 *
 * 这里只管一件事：**这一页画哪几章**。矩阵是 角色 × 章 的二维表，
 * 章数是唯一会自己长起来的轴 —— 书写到 180 章，一张表就是 180 列，
 * 而它住在侧栏那块 300px（`--sidebar-width`，实测可视 291px）的面板里。
 *
 * 判据只写在这一份文件里：窗口大小、边界、话术。界面不许再自己 `slice(-40)`
 * 抄第二份数字 —— 这个项目反复犯过的病就是「阈值在第二处出现，两处从此再也没对上过」。
 *
 * 刻意不做的事：**不裁数据，只裁视图**。库里那一格还在、点得到、规则（R1/R2）照查，
 * 关掉窗口不等于状态丢了；也不做任何「旧格子折叠成摘要」的压缩，
 * 摘要要模型来写，那是另一件事，别在这里假装它做了。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWStateScope = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCOPE_VERSION = '1.0.0';

  /**
   * 一页最多画几章。取 40 的来由是格子数，不是「一眼看得完」。
   * 浏览器实测（180 章 / 3 角色的书）：名字列 55px、章列 38px，而侧栏只有 300px
   * （`--sidebar-width`），装得下的是 6 列 —— 40 列把 table 撑到 2279px，
   * 横向仍要滚近 8 个身位。所以这一页画不完就是画不完，窗口收的是两样别的东西：
   * DOM 规模（20 个角色 × 40 章 = 800 个 td，×180 章是 3600 个 td 外加 3600 次 byKey 查询），
   * 以及「更早的章根本不在眼前」这件事必须由图例说出来，而不是靠一张拉不到头的长表暗示。
   * 想让 40 列不滚得先加宽面板，那是另一件事，不在这儿假装做了。
   */
  const WINDOW_SIZE = 40;

  /** 列序 = 阅读序。库里回什么顺序都不算，这里按 order 排一次，只此一处。 */
  function ordered(chapters) {
    return (chapters || []).slice().sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));
  }

  /** 窗口大小只能用正整数：0、负数、NaN 一律退回默认那一页，而不是画出一列或空表。 */
  function normSize(size) {
    const n = Math.floor(Number(size));
    return Number.isFinite(n) && n > 0 ? n : WINDOW_SIZE;
  }

  /** 一共几页。total 0 也算一页，否则翻页条上会出现「第 0/0 页」。 */
  function pageCount(total, size) {
    return Math.max(1, Math.ceil((total || 0) / normSize(size)));
  }

  /**
   * 取第 back 页（back=0 是最近那一页，往前翻就 +1）。
   * 越界一律夹到最后一页而不是给一个空窗口 —— 「翻过头了所以整张表空着」
   * 是让用户以为数据没了，比多画两列糟。
   */
  function windowOf(chapters, size = WINDOW_SIZE, back = 0) {
    const all = ordered(chapters);
    const n = normSize(size);
    const total = all.length;
    const pages = pageCount(total, n);
    const page = Math.min(Math.max(0, Math.floor(back) || 0), pages - 1);
    const end = total - page * n;
    const start = Math.max(0, end - n);
    const visible = all.slice(start, end);
    return {
      version: SCOPE_VERSION,
      total,
      size: n,
      page,
      pages,
      visible,
      first: visible[0] || null,
      last: visible[visible.length - 1] || null,
      hidden: total - visible.length,
      truncated: total - visible.length > 0,
      // 往前翻还有页吗、往后翻（回最近）还有页吗
      canBack: page < pages - 1,
      canForward: page > 0,
    };
  }

  /** 窗口内的章 id 集合。界面拿它数「这一页里记了多少格」，别在界面里重写一遍 filter。 */
  function idSet(win) {
    return new Set((win?.visible || []).map((c) => c.id));
  }

  /**
   * 这本书要不要给一条范围条 —— 判的是「比默认窗口长」，不是「当前画完了没」。
   * 只看当前窗口会漏掉全书模式本身：那一状态下 truncated 是 false、pages 是 1，
   * 于是整条消失，「收成一片」那颗按钮跟着没了，作者从全书回不到分页 —— 浏览器真点才撞得出来。
   */
  function needsScopeBar(win) {
    return !!win && win.total > WINDOW_SIZE;
  }

  /** 「第 3 章到第 40 章」——用章的 order 实际值说话，章号断过（删过章）也不谎报列数。 */
  function spanText(win) {
    if (!win || !win.visible.length) return '没有章节';
    const a = win.first.order, b = win.last.order;
    return a === b ? `第 ${a} 章` : `第 ${a}–${b} 章`;
  }

  /**
   * 图例那一句。三件事必须齐：画的是哪几章、这一页之外还剩几章、
   * 「已记录 N 格」是全库的还是这一页的 —— 少了最后一句，
   * 作者会以为没画出来的那些章没记状态。
   */
  function lines(win, counts = {}) {
    if (!win || !win.visible.length) return '这本书还没有章节。';
    const parts = [`画的是${spanText(win)}（共 ${win.total} 章里的 ${win.visible.length} 章）`];
    if (win.truncated) parts.push(`还有 ${win.hidden} 章更早的没画出来（按「再往前一页」或「全书」）`);
    if (counts.inWindow !== undefined && counts.total !== undefined) {
      parts.push(counts.inWindow === counts.total
        ? `已记录 ${counts.total} 格`
        : `这一页 ${counts.inWindow} 格 · 全书 ${counts.total} 格`);
    }
    return parts.join(' · ');
  }

  return { SCOPE_VERSION, WINDOW_SIZE, ordered, pageCount, windowOf, idSet, needsScopeBar, spanText, lines };
});
