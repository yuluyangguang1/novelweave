/**
 * NovelWeave · 织文 — 正向张力统计（UMD：浏览器与 Node 共用）
 *
 * R1–R22 查的都是「不能错 / 别这么写」。这个包管另一半：一章读下来该有而没有的
 * 东西到位了没有 —— 有没有人开口、有没有连续一大段纯叙述、结尾是不是每章同一种钩子。
 *
 * 只数数，不裁判。「冲突强度」「爽点」「这章精不精彩」数不出来，就不写进规则 ——
 * 一条会误报的节奏规则，作者的处置是把它连带整包关掉，等于没有。
 *
 * 和 stylepack.js 同构：同一份数字要喂三处 —— 写之前的 prompt（llm.js）、
 * 写之后的机检（rules.js R23/R25）、命令行兜底（nw-prose）。分成三份必然自相矛盾。
 *
 * 另外这里还是**篇幅档那一格的家**：FORMATS / formatKey / fmtOf / isShort 四句是「这本书算哪一档」
 * 的唯一出处（库行、导出、预设、CLI、界面都问它们）。这一格以前在八个地方各归一遍。
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWStylePack);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWTension = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, StylePack) {
  'use strict';

  const PACK_VERSION = '1.0.0';

  /**
   * 每书配额。按版式分两档：一章 3000 字和一章 800 字不能用同一个绝对数。
   * minWords —— 对话占比的评审门槛：占比要整章体量撑得起来，几百字的片段不评。
   * minBody —— 变化点的评审门槛：章子基本成形就可以问「这章改变了什么」。
   * ratioLow —— 对话字数占比低于此值算「整章没人开口」；plainInfo —— 连续多少字纯叙述要提示。
   * hookRun —— 连续几章同一种结尾钩子算偷懒。
   * 这里没有 warn 门槛：本包三条规则恒为 info，理由写在 rules.js 的 detail 里。
   */
  const QUOTAS = {
    long: { minWords: 1500, minBody: 800, ratioLow: 0.08, plainInfo: 800, hookRun: 3 },
    short: { minWords: 400, minBody: 300, ratioLow: 0.10, plainInfo: 600, hookRun: 3 },
  };

  /**
   * 单章正文字数的合理区间（含端点），按版式两档。**这是这一个数的唯一出处**：
   * 评分卡的规划区间（pitch.js）、动笔前 prompt 那句「字数要求」（llm.js）、
   * 写完后的机检 R35（rules.js）三处都从这里念 —— 此前它写了三遍（3000–5000 / 1200–4000 /
   * 界面另一档），于是模型照着 prompt 的承诺写 5000 字，回头机检报它「超上限」，
   * 而作者看到的是「我自己写的要求惩罚了我」。
   * 下限不是「必须写满」，是「这一章起码做成了一件事」；上限是网文读者的单次耐心，
   * 再长就该拆章。区间外不等于写坏了，所以 R35 恒为 info、永不进退出码。
   *
   * 短篇那一档**上不封顶**（`null`）：短篇的「章」是一节，长度由总字数与投放平台定，
   * 而本书的短篇向导自己就承诺「微型 3k-6k 字，1-2 章」与「盐选 5 万字 / 6-10 章」——
   * 摊到单章最坏 8300 字。给短篇安一个比这小的上限，等于机器天天报一个作者照着界面
   * 选出来的计划，那是凭空造出来的档位。长篇有上限，是因为长篇的章数由作者拆。
   */
  const CHAPTER_RANGE = { long: [1200, 4000], short: [400, null] };

  /**
   * 一档区间对人怎么说：「1200-4000 字」或「400 字起，上不封顶」。
   * 文档、CLI 的 rubric 文案、R35 的 evidence 都念它 —— 话术抄三遍就会有三遍的旧。
   */
  function rangeLabel(key) {
    const [lo, hi] = CHAPTER_RANGE[key];
    return hi == null ? `${lo} 字起，上不封顶` : `${lo}-${hi} 字`;
  }

  /** 成对引号。只认前引号会把「他说：“……」之后的整段都算成台词，占比虚高。 */
  const QUOTE_PAIRS = [['“', '”'], ['「', '」'], ['『', '』']];
  /** 超过这个长度还没等到后引号，按漏写引号处理，不算对话 —— 否则一处漏引号能吃掉一整章。 */
  const MAX_SPAN = 600;

  const TAIL_WINDOW = 120;

  function words(s) {
    return T ? T.countWords(s) : String(s || '').length;
  }

  /**
   * 对话区间：成对引号包住的原文段，返回 [{start, end, text}]（end 含后引号）。
   * 同一处多个前引号取最先配对的；不嵌套（中文小说里引号套引号通常换字形）。
   */
  function dialogueSpans(text) {
    const body = String(text || '');
    const opens = [];
    for (const [o] of QUOTE_PAIRS) for (let i = body.indexOf(o); i >= 0; i = body.indexOf(o, i + 1)) opens.push({ at: i, o });
    opens.sort((a, b) => a.at - b.at);
    const out = [];
    let consumed = -1;
    for (const { at, o } of opens) {
      if (at < consumed) continue;
      const close = QUOTE_PAIRS.find((p) => p[0] === o)[1];
      let end = -1;
      for (let i = at + 1; i < body.length && i - at <= MAX_SPAN; i++) {
        const ch = body[i];
        // 遇到另一种前引号说明上一处忘了收尾，这段不算对话
        if (QUOTE_PAIRS.some((p) => p[0] === ch && p[0] !== o)) break;
        if (ch === close) { end = i; break; }
      }
      if (end < 0) continue;
      out.push({ start: at, end: end + 1, text: body.slice(at + 1, end) });
      consumed = end + 1;
    }
    return out;
  }

  function overlaps(a, b) {
    return a.start < b.end && b.start < a.end;
  }

  /**
   * 一篇正文的张力统计。纯函数，不读盘。
   * @returns { words, dialogueWords, ratio, plainRuns:{words,from,to}, sample }
   */
  function stats(text) {
    const body = String(text || '');
    const total = words(body);
    const spans = dialogueSpans(body);
    const dialogueWords = spans.reduce((s, sp) => s + words(sp.text), 0);

    const paras = StylePack ? StylePack.paragraphs(body) : [];
    let run = 0, runFrom = null;
    const best = { words: 0, from: 0, to: 0 };
    for (const p of paras) {
      const spoken = spans.some((sp) => overlaps({ start: p.start, end: p.end }, sp));
      if (spoken) { run = 0; runFrom = null; continue; }
      if (run === 0) runFrom = p.start;
      run += words(p.text);
      if (run > best.words) { best.words = run; best.from = runFrom; best.to = p.end; }
    }
    const mid = body.slice(best.from, best.from + 30).replace(/\s+/g, ' ');
    return {
      words: total,
      dialogueWords,
      ratio: total > 0 ? +(dialogueWords / total).toFixed(3) : 0,
      plainRuns: best,
      sample: mid,
    };
  }

  /**
   * 结尾钩子的类型。刻意只做两类判据确凿的：问句收尾、突转词收尾。
   * 其余一律 null —— 「留白」「悬念感」是修辞判断，机器认不出来就别装作认得。
   * 判据与 R17 用同一批词，两条规则不会一个说有钩子一个说没类型。
   */
  function hookKind(tail) {
    const s = String(tail || '');
    if (!s.trim()) return null;
    if (/[？?]/.test(s)) return 'question';
    if (TWIST_RE.test(s)) return 'twist';
    return null;
  }
  const TWIST_RE = /突然|没想到|只见|下一瞬|下一刻|话音未落|猛地|凭空|异变|还没等|未完待续|欲知后事/;

  const HOOK_LABEL = { question: '问句收尾', twist: '突转收尾' };

  function tailOf(text) {
    const s = String(text || '').trim();
    return s.length <= TAIL_WINDOW ? s : s.slice(-TAIL_WINDOW);
  }

  /**
   * 篇幅档的清单与缺档。**「一本书算哪一档」的全部答案就在这一节**：
   * 归一（库行、导出、预设、CLI 拿到的外来值认不出算长篇）与换挡（短篇走另一套
   * 配额、窗口、界面）都从这里念。X 之前这一格在 19 处各归一遍，其中九处就是这一句三元表达式。
   * 桥两头各写一遍的意思是：谁改一处而漏了另一处，导出去再导回来，短篇就变长篇，没人报错。
   * 顺序照 UI 的下拉与预设的话术（短篇在前）；schema 那两份 enum 是字母序，守卫比对时各自排序。
   */
  const FORMATS = ['short', 'long'];
  const DEFAULT_FORMAT = 'long';

  /** 把任何来路（界面、库行、外来文件、命令行）的篇幅档归一成两值之一。认不出按长篇。 */
  function formatKey(value) { return value === 'short' ? 'short' : DEFAULT_FORMAT; }

  /** 一本书算哪一档。库行、ctx.book、预设的 fields 三种形状都有 format 这一格，都问这句。 */
  function fmtOf(book) { return formatKey(book && book.format); }

  /** 「这本书算不算短篇」只写在这一行。 */
  function isShort(book) { return fmtOf(book) === 'short'; }

  /**
   * 几本书放一起算一档：只要有一本算短篇就按短篇。
   * 目前只有评分卡拿对照书算「这个体量按短篇够不够」用它。放在这里是为了让
   * `'short' : 'long'` 这一对字面量在全仓只出现在 tension.js —— 别处再写一遍，
   * 就分不清它是在归一还是在换挡，而那正是这次要拆开的两种判据。
   */
  function minFormat(books) { return (books || []).some(isShort) ? 'short' : DEFAULT_FORMAT; }

  /**
   * 每一档对人说什么。X 收掉了「算哪一档」，Y 收掉了「有没有目标」，这里收的是「那一档叫什么」——
   * 以前长篇这一档在逐格 diff、机检、schema 三处各有各的叫法，同一本书三个名字，读起来像三档。
   * 归一走 formatKey：认不出的值按长篇念，与库里投影同一条判据，
   * 所以界面与 CLI 永远不会把 'SHORT'、'zhong' 这样的脏值原样念给作者听。
   * 预设字段那一格的名字「篇幅档」（FIELD_LABEL）与建档弹窗的「织物规格」说的是 format 这一个概念，
   * 那是两个语域不是两份判据，不归这张表管 —— 见 rules.md 的 Z 族。
   */
  const FORMAT_LABEL = { short: '短篇', long: '长篇' };

  /** 这一档对人说什么。对象（库行/ctx.book）先问档再查表，其余来路把值本身过归一。 */
  function formatLabel(value) {
    return FORMAT_LABEL[typeof value === 'object' && value !== null ? fmtOf(value) : formatKey(value)];
  }

  /**
   * 字数目标的下限。**这个数不是这儿首创**：它写在 schemas/story-bible.v1.json 与
   * schemas/workflow.v1.json 的 `target_words.minimum` 里，也就是「这一格什么算合法」那份声明；
   * 守卫拿那两份 schema 对着它核。低于下限的数（和不是整数的数）等于没设 ——
   * 存进去会导出一份过不了自己 schema 的书，读出来会画出一条谁都算不出的进度条。
   */
  const TARGET_MIN = 1000;

  /**
   * 「这一格里躺着一个像样的字数目标吗」—— 只问这个数本身，**不问哪一档**。
   * 问它的两处都知道档是另一回事：预设过闸要按这份文件写的数判它合不合法，
   * 逐格 diff 要问库行里那个数还躺着没有（长篇的库里也可能躺着遗留的一个，那正是清走它的依据）。
   * 布尔与对象不许靠「能转成数」混进来：Number(true) 是 1，那就成了「目标 1 字」。
   */
  function targetValue(raw) {
    const n = (typeof raw === 'string' || typeof raw === 'number') ? Number(raw) : NaN;
    return Number.isInteger(n) && n >= TARGET_MIN ? n : null;
  }

  /**
   * 「这一档有没有字数目标那一格，那个数是多少」—— 一句答完两问。
   * 长篇没有这一格（建档留空、预设要设得连档一起换），所以库里那个数哪怕躺着也不作数：
   * 以前建档用「非空就算」、打包用「≥ 下限才算」、评分卡拿原始值就算，一宽一严，
   * 于是同一个数在界面是「没设」、在评分卡是「目标 8000 字」。
   * 库行写 `target_words`，ctx.book 写 `targetWords`，两种形状都问这一句。
   */
  function targetOf(book) {
    if (!isShort(book)) return null;
    return targetValue(book && (book.target_words ?? book.targetWords));
  }

  /** 一本书该用哪档张力配额。 */
  function quotaFor(book) {
    return QUOTAS[fmtOf(book)];
  }

  /** 一本书的单章字数区间。换挡与 quotaFor 用的是同一个判据，不许有第二套「算不算短篇」。 */
  function chapterRange(book) {
    return CHAPTER_RANGE[fmtOf(book)];
  }

  /**
   * 未收伏笔的三个数字，喂给写之前的那段。
   * 「最久的一条已经多少章」是这句里唯一能让模型真停下来看一眼的东西 ——
   * 光说「你有伏笔没回收」等于没说。只算已登记的 promise，candidate（自动登记、作者未确认）不算债。
   */
  function tally(ctx) {
    const items = (ctx && ctx.promises && Array.isArray(ctx.promises.items)) ? ctx.promises.items : [];
    const chapters = Array.isArray(ctx && ctx.chapters) ? ctx.chapters.filter((c) => c && typeof c === 'object') : [];
    const num = new Map(chapters.map((c) => [c.id, c.number]));
    const last = chapters.reduce((m, c) => Math.max(m, c.number || 0), 0);
    let open = 0, overdue = 0, oldest = 0;
    for (const it of items) {
      // 账本里混进空条目（导入的半坏文件、界面异步留下的洞）不许把数债这件事整批打崩：
      // tally 一抛，吃它的 prompt 注入与评分卡会一起静默失效。
      if (!it || typeof it !== 'object') continue;
      if (it.type !== 'promise' || it.weight === 'candidate') continue;
      if (it.status === 'paid-off' || it.status === 'dropped' || it.status === 'cancelled') continue;
      open += 1;
      const setupN = it.setup && it.setup.chapter != null ? num.get(it.setup.chapter) : null;
      if (setupN != null && last > setupN) oldest = Math.max(oldest, last - setupN);
      const dueN = it.payoff && it.payoff.due ? num.get(it.payoff.due) : null;
      if (dueN != null && last > dueN) overdue += 1;
    }
    return { open, overdue, oldest: oldest || 0 };
  }

  /**
   * 写之前那段「该有而没有」的清单。传 tally 是为了把未收伏笔的真实数字写进去 ——
   * 静态口号模型不会当回事，「你有 7 条伏笔没收，最久的已经 23 章」才会。
   */
  function promptBlock(book, tally_ = {}) {
    const q = quotaFor(book);
    const lines = ['节奏配额（这几样是本章该有而没有的，不是文笔要求）：'];
    lines.push(`- 让人开口：对话占到 ${Math.round(q.ratioLow * 100)}% 以上，连续 ${q.plainInfo} 字没有一句台词就得起新张力`);
    lines.push('- 造成一个可登记的变化：埋一条新伏笔、收一条旧的，或让某个角色的位置／伤势／持有／所知道的事真的变了');
    lines.push(`- 结尾别重复上一章那种钩子（问句、突转连续 ${q.hookRun} 章同一型就算偷懒）`);
    if (tally_ && tally_.open) {
      const over = tally_.overdue ? `，其中 ${tally_.overdue} 条已过你自设的回收期限` : '';
      const oldest = tally_.oldest ? `，最久的一条已经 ${tally_.oldest} 章` : '';
      lines.push(`- 当前未收伏笔 ${tally_.open} 条${over}${oldest}：本章先偿旧，再提新`);
    }
    return lines.join('\n');
  }

  return {
    PACK_VERSION, QUOTAS, CHAPTER_RANGE, HOOK_LABEL, rangeLabel,
    FORMATS, DEFAULT_FORMAT, formatKey, fmtOf, minFormat, FORMAT_LABEL, formatLabel,
    TARGET_MIN, targetValue, targetOf,
    dialogueSpans, stats, hookKind, tailOf, isShort, quotaFor, chapterRange, tally, promptBlock,
  };
});
