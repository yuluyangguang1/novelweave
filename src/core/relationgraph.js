/**
 * NovelWeave · 织文 — 关系图（UMD：浏览器与 Node 共用）
 *
 * README 与 roadmap 从 P0-2 起就叫「关系图谱」，可盘上从来没有图：侧栏把那几条边
 * 摊成一列卡片，谁连着谁、哪几块互不相连、哪个角色在网外，全靠作者自己在脑子里连。
 * 这一份补的是那张图，顺带补上更要紧的一件事 —— **这条边的两头到底存不存在**。
 *
 * 现状是四句话各说各的：R31 的规格写着「角色 id 解析不到的归 dangling-reference」，
 * 而 R15 根本不扫 relations；AI 抽关系入库时把模型给的**名字**原样存进 from/to
 * （查了 id 却没用），于是那条边在 R31 里被 continue 掉、在 R15 里没人管、在面板上
 * 显示成一个看起来挺正常的名字；context.js 为了让它进 prompt 又写了一份
 * 「名字也算命中」的兜底。三份口径互不知情 —— 这个项目反复犯的病。
 *
 * 所以这份文件只回答四件事，别处一律改问它：
 * 1. **端点是谁**：只认本书的角色卡。id 命中最好；只有名字能命中时算接上，
 *    但要报出来（改名即断）；同名两个角色时不猜，按解析不到处理。
 * 2. **区间到第几章算活着**：since/until 指不到本书的章就判坏，不按下标猜 ——
 *    跟卷的起止同一套纪律（missing 与 reversed 分开说，因为修法不同）。
 * 3. **网长什么样**：连通分量、谁在网外、画不出来的那几条各归各的桶。
 * 4. **画出来是什么**：确定性布局 + 一段 SVG 字符串。坐标在这里算，
 *    测试不用 DOM 就能钉住「任意两个节点不相撞」「同一份输入出同一张图」。
 *
 * 刻意不做的事：不做力导向（每帧抖一遍的图没法测，也没法在两次打开之间长得一样）、
 * 不做拖拽与缩放（那是视图的事）、不自动补边（谁和谁有关系是作者的判断，
 * 猜出来的边画进图里就会被当成账本读）。
 */
(function (root, factory) {
  const mod = factory(root.NWText);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWRelationGraph = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T) {
  'use strict';

  const GRAPH_VERSION = '1.0.0';

  /** 画布是 viewBox，实际大小交给 CSS；半径与间距是死数，理由在下面那条保证上。 */
  const CANVAS_W = 480;
  const CANVAS_H = 480;
  const RADIUS_MAX = 210;
  const RADIUS_MIN = 90;
  /** 相邻节点的弦长下限：名字四到五个字加一点余量。节点数不超过 MAX_NODES 时才可能满足。 */
  const NODE_SPACING = 56;
  /** 圆上最多画几个角色。22 个时所需半径 196.8 < RADIUS_MAX，再就要么撞要么把画布撑破，
   *  所以超出的角色不画，但要在缺口那句话里报数 —— 一张悄悄少画了六十个节点的图比没图更坏。 */
  const MAX_NODES = 22;
  /** prompt 里「活跃关系」最多列几条。裸 10 原来写在 context.js。 */
  const RELATION_LINES = 10;

  const esc = (s) => (T && T.esc ? T.esc(s) : String(s == null ? '' : s));
  const attr = (s) => (T && T.attr ? T.attr(s) : String(s == null ? '' : s).replace(/"/g, '&quot;'));

  /** id → 角色，name → 角色（同名记成冲突，之后不猜哪一个是他）。 */
  function charIndex(characters) {
    const byId = new Map();
    const byName = new Map();
    for (const c of characters || []) {
      if (!c || !c.id) continue;
      byId.set(c.id, c);
      const n = String(c.name || '').trim();
      if (!n) continue;
      const had = byName.get(n);
      byName.set(n, had && had !== c ? null : c);   // null = 同名多人
    }
    return { byId, byName };
  }

  /**
   * 一个引用（from 或 to）落到哪个角色。四种结果里只有前两种算接上：
   * via='id' 是正常路径，via='name' 能用但脆弱（改个名字就断，得有名字才修得了）；
   * unknown 与 ambiguous 一律画不出来 —— 后者尤其不能挑一个画，
   * 图上那条线连到谁，作者就会当成账本里说的那个人。
   */
  function endpointOf(ref, index) {
    const r = String(ref == null ? '' : ref).trim();
    if (!r) return { ok: false, ref: '', reason: 'empty' };
    if (index.byId.has(r)) return { ok: true, id: r, via: 'id', name: index.byId.get(r).name || r };
    const named = index.byName.get(r);
    if (named === null) return { ok: false, ref: r, reason: 'ambiguous' };
    if (named) return { ok: true, id: named.id, via: 'name', name: named.name || r };
    return { ok: false, ref: r, reason: 'unknown' };
  }

  const indexOf = (chapters, id) => (chapters || []).findIndex((c) => c.id === id);

  /**
   * 边的生效区间落成章下标。四种形状：
   * 两头都没填 = 全书有效（open）；填了但指不到本书的章 = missing；
   * 起止反了 = reversed；其余 ok。判坏的两条与 volumes.js 同一个理由 ——
   * 按下标猜出来的区间可能盖住完全不同的一段剧情，而作者看不出来。
   *
   * sinceSet / untilSet 记的是**作者到底填没填**，不是补出来的端点。
   * 只填了起点时 to 补到书边只是为了画图，绝不能当成「到那一章为止」——
   * 没登记结束和登记了结束是两件事，混起来最坏的结果在下一节。
   */
  function rangeOf(edge, chapters) {
    const n = (chapters || []).length;
    const since = String(edge?.since == null ? '' : edge.since).trim();
    const until = String(edge?.until == null ? '' : edge.until).trim();
    const fill = { sinceSet: !!since, untilSet: !!until };
    if (!since && !until) return { ok: true, open: true, ...fill, from: 0, to: Math.max(0, n - 1) };
    const from = since ? indexOf(chapters, since) : 0;
    const to = until ? indexOf(chapters, until) : Math.max(0, n - 1);
    if (from === -1 || to === -1) return { ok: false, reason: 'missing', ...fill, from: -1, to: -1, open: false };
    if (to < from) return { ok: false, reason: 'reversed', ...fill, from, to, open: false };
    return { ok: true, open: false, ...fill, from, to };
  }

  /**
   * 这一条边在 cut 那一章活着吗。cut 是**目标章的下标**（写下一章时取 chapters.length，
   * 于是第 3 章决裂的关系在第 2 章仍算活着 —— 原来 context.js 写成「填了 until 就永远不算」，
   * 把「已经结束了」用成了「一律不列」，正好处说反了）。
   */
  function stateOf(range, cut) {
    if (!range.ok) return 'bad';
    if (range.open) return 'open';
    const at = cut == null ? Number.MAX_SAFE_INTEGER : cut;
    if (range.from > at) return 'future';
    // 没填 until = 作者还没登记这段关系结束。把它读成「到上一章为止」，最常见的那种边
    // （只填了起点）就正好在续写下一章时从 prompt 里消失 —— 那一章最需要它。
    if (!range.untilSet) return 'active';
    if (range.to < at) return 'ended';
    return 'active';
  }

  const LINK_STATES = ['open', 'active', 'future', 'ended', 'bad'];

  /** 区间的人话说法。「第 3 章起」与「至第 3 章」不是一回事，别合成一句。 */
  function rangeText(link, chapters) {
    const r = link.range;
    if (!r.ok) return r.reason === 'reversed' ? '起止章填反了' : '起止章不在书里';
    if (r.open) return '一直如此';
    const at = (i) => chapters?.[i]?.number ?? chapters?.[i]?.order;
    const na = at(r.from), nb = at(r.to);
    if (na == null || nb == null) return '起止章不在书里';
    // 只填了一头就说那一头：补出来的书边不是作者登记的终点，
    // 写成「第 1–4 章」等于替账本多出一条谁都没说过的「师徒在第 4 章结束了」。
    if (r.sinceSet && !r.untilSet) return `自第 ${na} 章起`;
    if (!r.sinceSet && r.untilSet) return `至第 ${nb} 章`;
    return na === nb ? `第 ${na} 章` : `第 ${na}–${nb} 章`;
  }

  /**
   * 整张图。edges 里解析不到端点的那几条不丢：它们进了 dangling，
   * 那句缺口要报数，卡片也要能顶一颗「画不出来」的标签。
   * unlinked 是「一条边都没登记」的角色 —— 不等于写坏了，但作者画完图看见
   * 主角在网外，那一眼比任何规则都管用。
   */
  function build({ characters = [], edges = [], chapters = [], cut = null } = {}) {
    const index = charIndex(characters);
    const nodes = [];
    for (const c of characters || []) {
      if (!c || !c.id || nodes.some((n) => n.id === c.id)) continue;
      nodes.push({ id: c.id, name: String(c.name || c.id), role: c.role || '' });
    }
    const links = [];
    const dangling = [];
    const selfLoops = [];
    const skippedEdges = [];
    const seenEdge = new Set();
    let skipped = 0;
    for (const edge of edges || []) {
      if (!edge || typeof edge !== 'object') continue;   // 数组里的空洞不是记录，不算一条边
      // 没有 id、或 id 与前面那条撞了：这条边在账本里无处落笔，画不出来。
      // 悄悄丢掉就是「账本里有七条、图上说六条」，所以它单独进 skipped 并被那句缺口报出来。
      // skippedEdges 另存一份原样记录：面板逐张卡片要顶那句标签，光有数说不清是哪一条。
      if (!edge.id || seenEdge.has(edge.id)) { skipped++; skippedEdges.push(edge); continue; }
      seenEdge.add(edge.id);
      const a = endpointOf(edge.from, index);
      const b = endpointOf(edge.to, index);
      const range = rangeOf(edge, chapters);
      const state = stateOf(range, cut);
      if (!a.ok || !b.ok) {
        dangling.push({
          id: edge.id, edge, missing: [
            !a.ok ? { side: 'from', ref: a.ref, reason: a.reason } : null,
            !b.ok ? { side: 'to', ref: b.ref, reason: b.reason } : null,
          ].filter(Boolean),
        });
        continue;
      }
      if (a.id === b.id) {
        // 两头都解析得到、但是同一个人：这不是「找不到角色」，别混进 dangling 那句里去
        selfLoops.push({ id: edge.id, edge, at: a.id });
        continue;
      }
      links.push({
        id: edge.id, edge, from: a.id, to: b.id, kind: String(edge.kind || ''),
        address: String(edge.address || ''), via: { from: a.via, to: b.via }, range, state,
      });
    }
    const linked = new Set();
    for (const l of links) { linked.add(l.from); linked.add(l.to); }
    const byNode = new Map();
    for (const l of links) {
      if (!byNode.has(l.from)) byNode.set(l.from, []);
      if (!byNode.has(l.to)) byNode.set(l.to, []);
      byNode.get(l.from).push(l);
      byNode.get(l.to).push(l);
    }
    // 无向连通分量：分量之间不可能还有边（否则本就是一块）
    const components = [];
    const done = new Set();
    for (const n of nodes) {
      if (done.has(n.id) || !linked.has(n.id)) continue;
      const group = [];
      const queue = [n.id];
      done.add(n.id);
      while (queue.length) {
        const id = queue.shift();
        group.push(id);
        for (const l of byNode.get(id) || []) {
          const next = l.from === id ? l.to : l.from;
          if (done.has(next)) continue;
          done.add(next);
          queue.push(next);
        }
      }
      group.sort();
      components.push({ id: `c${components.length + 1}`, nodes: group, size: group.length });
    }
    const unlinked = nodes.filter((n) => !linked.has(n.id)).map((n) => n.id);
    const stateCount = {};
    for (const s of LINK_STATES) stateCount[s] = links.filter((l) => l.state === s).length;
    // 判坏的两种成因分开数：missing 是边界章被删了（要重挑），reversed 是填反了（要对调）。
    // 混成一句「读不出来」，作者就去挪本该是起点的另一端，改完还是坏的。
    const missing = links.filter((l) => l.range.reason === 'missing').length;
    const reversed = links.filter((l) => l.range.reason === 'reversed').length;
    const counts = {
      characters: nodes.length,
      edges: seenEdge.size + skipped,
      skipped,
      links: links.length,
      dangling: dangling.length,
      selfLoops: selfLoops.length,
      byName: links.filter((l) => l.via.from === 'name' || l.via.to === 'name').length,
      missing, reversed,
      unlinked: unlinked.length,
      components: components.length,
      ...stateCount,
    };
    return {
      version: GRAPH_VERSION, cut, chapters: chapters || [], nodes, links, dangling, selfLoops,
      skippedEdges, components, unlinked, byNode, counts,
    };
  }

  /**
   * 圆上顺序：先按分量（分量内 BFS，让连着的角色挨着排），再排网外角色。
   * 这样「几块互不相连」在图上是几段弧，不用连线自己找。
   */
  function ringOrder(graph) {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const ordered = [];
    const comps = graph.components.slice().sort((a, b) =>
      b.size - a.size || (a.nodes[0] < b.nodes[0] ? -1 : 1));
    for (const comp of comps) {
      const start = comp.nodes.slice().sort()[0];
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const id = queue.shift();
        ordered.push(nodeById.get(id));
        for (const l of graph.byNode.get(id) || []) {
          const next = l.from === id ? l.to : l.from;
          if (seen.has(next) || !nodeById.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const id of graph.unlinked.slice().sort()) if (nodeById.has(id)) ordered.push(nodeById.get(id));
    // 账本外还有端点时节点表已过滤掉了，这里只可能出现 graph.nodes 里的角色
    return ordered.filter(Boolean);
  }

  /**
   * 确定性布局。半径取 max(RADIUS_MIN, 所需半径)，所需半径由「相邻弦长 ≥ NODE_SPACING」
   * 反解出来，所以任意两点距离 ≥ NODE_SPACING 是可证的：圆上非相邻点只会更远。
   * 超过 MAX_NODES 的角色不画，藏了几个进 hidden —— 那句话由 notice 说出口。
   */
  function layout(graph, opts = {}) {
    const limit = Math.max(0, Math.min(opts.limit == null ? MAX_NODES : opts.limit, MAX_NODES));
    const all = ringOrder(graph);
    const placed = all.slice(0, limit);
    const hidden = all.slice(limit).map((n) => n.id);
    const n = placed.length;
    const cx = (opts.width || CANVAS_W) / 2;
    const cy = (opts.height || CANVAS_H) / 2;
    const need = n > 1 ? NODE_SPACING / (2 * Math.sin(Math.PI / n)) : 0;
    const r = n === 0 ? 0 : n === 1 ? 0 : Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, need));
    const round = (v) => Math.round(v * 10) / 10;
    const nodes = placed.map((node, i) => {
      const a = -Math.PI / 2 + (n ? (2 * Math.PI * i) / n : 0);
      return { ...node, x: round(cx + r * Math.cos(a)), y: round(cy + r * Math.sin(a)) };
    });
    return {
      version: GRAPH_VERSION, width: opts.width || CANVAS_W, height: opts.height || CANVAS_H,
      cx: round(cx), cy: round(cy), radius: round(r), nodes, hidden,
      byId: new Map(nodes.map((p) => [p.id, p])),
    };
  }

  /** 分量在圆上是不是连续一段 —— 不连续就说明排序走偏了，那几块会交错穿插。 */
  function isContiguous(lay, graph) {
    const pos = new Map(lay.nodes.map((nd, i) => [nd.id, i]));
    for (const comp of graph.components) {
      const idx = comp.nodes.filter((id) => pos.has(id)).map((id) => pos.get(id)).sort((a, b) => a - b);
      if (!idx.length) continue;
      if (idx[idx.length - 1] - idx[0] !== idx.length - 1) return false;
    }
    return true;
  }

  const STATE_CLASS = { open: 'rg-open', active: 'rg-active', future: 'rg-future', ended: 'rg-ended', bad: 'rg-bad' };

  /**
   * 一段 SVG 字符串。渲染住在 core 里是有原因的：这样「画了什么」能被测试钉住
   * （节点数、边数、坏边的 class、角色名里的尖括号），而 app.js 只做一件事 ——
   * 把这个字符串塞进容器。界面里再算一遍坐标，就会有两张互不相认的图。
   */
  function toSvg(graph, lay) {
    const l = lay || layout(graph);
    const parts = [];
    const label = `关系图：${l.nodes.length} 个角色、${graph.counts.links} 条边`
      + (graph.counts.dangling ? `、${graph.counts.dangling} 条画不出来` : '')
      + (l.hidden.length ? `、${l.hidden.length} 个角色没画进来` : '');
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" class="nw-relation-graph" viewBox="0 0 ${l.width} ${l.height}" role="img" aria-label="${attr(label)}">`);
    parts.push(`<g class="rg-layer-links">`);
    for (const link of graph.links) {
      const a = l.byId.get(link.from);
      const b = l.byId.get(link.to);
      if (!a || !b) continue;   // 被藏起来的那几个角色，它们的边不画 —— hidden 的计数在 label 里
      parts.push(`<line class="rg-link ${STATE_CLASS[link.state] || 'rg-active'}" data-edge="${attr(link.id)}" `
        + `x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"><title>${esc(linkTitle(link, graph))}</title></line>`);
    }
    parts.push(`</g><g class="rg-layer-nodes">`);
    for (const nd of l.nodes) {
      const deg = (graph.byNode.get(nd.id) || []).length;
      const cls = graph.unlinked.includes(nd.id) ? 'rg-node rg-unlinked' : 'rg-node';
      parts.push(`<g class="${cls}" data-id="${attr(nd.id)}" data-degree="${deg}">`
        + `<circle cx="${nd.x}" cy="${nd.y}" r="10"></circle>`
        + `<text class="rg-name" x="${nd.x}" y="${nd.y - 16}">${esc(nd.name)}</text>`
        + `<title>${esc(nd.name)}${nd.role ? '（' + esc(nd.role) + '）' : ''} · ${deg} 条关系</title></g>`);
    }
    parts.push('</g></svg>');
    return parts.join('');
  }

  function linkTitle(link, graph) {
    const name = (id) => (graph.nodes.find((n) => n.id === id) || {}).name || id;
    const t = `${name(link.from)} → ${name(link.to)}：${link.kind || '未写关系类型'}`;
    const r = rangeText(link, graph.chapters);
    return link.address ? `${t}（称谓「${link.address}」）· ${r}` : `${t} · ${r}`;
  }

  /**
   * 缺口那一句。面板顶上、图上方、prompt 尾部用的是同一句 —— 说三遍不同的话，
   * 作者就会挑最顺耳的那条信。
   * 一条边都没登记时不开口：那是「还没用这套东西」，不是「有缺口」（与卷同一口径）。
   */
  function notice(graph, lay) {
    if (!graph || !graph.counts || graph.counts.edges === 0) return '';
    const c = graph.counts;
    const parts = [];
    if (c.skipped) parts.push(`${c.skipped} 条边没有 id 或与别的边同 id，画不出来`);
    if (c.dangling) parts.push(`${c.dangling} 条边的某一头连不到任何角色，画不出来`);
    if (c.selfLoops) parts.push(`${c.selfLoops} 条边的两头是同一个角色`);
    if (c.byName) parts.push(`${c.byName} 条边靠名字连着，改个名字就断`);
    if (c.bad) {
      const why = [];
      if (c.missing) why.push(`${c.missing} 条的起止章在书里读不出来`);
      if (c.reversed) why.push(`${c.reversed} 条填反了`);
      parts.push(`${c.bad} 条边的生效区间是坏的（${why.join('、')}）`);
    }
    if (c.unlinked) parts.push(`${c.unlinked} 个角色一条关系都没登记`);
    if (c.components > 1) parts.push(`图上有 ${c.components} 块互不相连`);
    const hidden = lay && lay.hidden ? lay.hidden.length : 0;
    if (hidden) parts.push(`${hidden} 个角色没画进来（圆上只放 ${MAX_NODES} 个）`);
    return parts.join(' · ');
  }

  /** prompt 用：本章该受哪几条关系约束。坏区间与靠名字的边照样进（那是事实），
   *  已经结束了的与还没开始的进不去 —— 后者是剧透，前者是废话。 */
  function activeLines(graph, presentIds, chapters) {
    const lines = [];
    const name = (id) => (graph.nodes.find((n) => n.id === id) || {}).name || id;
    for (const link of graph.links) {
      if (link.state === 'ended' || link.state === 'future') continue;
      if (presentIds && presentIds.size && !presentIds.has(link.from) && !presentIds.has(link.to)) continue;
      const addr = link.address ? `（称谓「${link.address}」）` : '';
      const r = rangeText(link, chapters || graph.chapters);
      lines.push(`- ${name(link.from)} → ${name(link.to)}：${link.kind || '未写关系类型'}${addr}（${r}）`);
      if (lines.length >= RELATION_LINES) break;
    }
    return lines;
  }

  return {
    GRAPH_VERSION, CANVAS_W, CANVAS_H, NODE_SPACING, MAX_NODES, RADIUS_MIN, RADIUS_MAX,
    RELATION_LINES, LINK_STATES, STATE_CLASS,
    charIndex, endpointOf, rangeOf, stateOf, rangeText, build, ringOrder, layout,
    isContiguous, toSvg, linkTitle, notice, activeLines,
  };
});
