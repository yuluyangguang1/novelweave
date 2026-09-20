/**
 * NovelWeave · 织文 — 去 AI 味规则包（UMD：浏览器与 Node 共用）
 *
 * 定位：这是一份**内容资产 + 纯统计判据**，不是文笔裁判。它只回答两件事：
 * 这段文字里出现了多少 AI 惯用的词、踩了哪几条可数的句式套路。
 * 判断「这句写得好不好」仍然只有作者能做 —— 所以本包产出的都是密度与计数，
 * 不产出一票否决。
 *
 * 为什么放在 core 而不是 scripts：同一条清单要喂三个地方 ——
 * 写之前进 prompt（llm.js）、写之后进机检（rules.js R22）、命令行兜底（nw-prose lint）。
 * 分成三份必然出现「prompt 里禁的词，检查器不报」这种自相矛盾。
 *
 * 判据刻意带门槛：中文里「仿佛」「非常」本身不是错，成片出现才是 AI 味。
 * 每组词的门槛写在组上（见 minPerPara / paraEnd），不在调用方。
 */
(function (root, factory) {
  const mod = factory(root.NWText);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWStylePack = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T) {
  'use strict';

  const PACK_VERSION = '1.0.0';

  /**
   * 禁词八组。terms 按长度降序用（否则「此刻」会吃掉「这一刻」的命中位置）。
   * minPerPara：同一段里该组命中不到这个数就不算 —— 单个「非常」是正常中文。
   * paraEnd：只算段落收尾窗口内的命中 —— 金句的毛病就在于它总出现在段尾。
   */
  const GROUPS = [
    {
      id: 'psych', label: '心理直说',
      hint: '把情绪名词直接说出来，而不是让身体替角色说',
      terms: ['心里五味杂陈', '五味杂陈', '内心深处', '心中一动', '心中一凛', '暗暗想到', '暗暗想',
        '油然而生', '某种情绪', '莫名的', '不由得', '不禁', '忍不住', '心头一震', '心头一紧', '心中暗道'],
    },
    {
      id: 'simile', label: '比喻引导词',
      hint: '先亮出「像」再补一个可有可无的喻体',
      terms: ['仿佛', '犹如', '宛如', '恰似', '如同', '好像', '似乎'],
    },
    {
      id: 'eyes', label: '眼神套路',
      hint: '用眼神代替动作与台词',
      terms: ['眼中闪过', '眼底划过', '眸子里', '眸中', '目光如炬', '眼神复杂', '眼中满是', '深邃', '清澈'],
    },
    {
      id: 'abstract', label: '抽象概括',
      hint: '把镜头拉远代替具体场景',
      terms: ['这一切', '这一刻', '这种感觉', '那一瞬间', '在这一刻', '在这个时候', '此刻'],
    },
    {
      id: 'connective', label: '转折套话',
      hint: '书面连接词硬套进口语叙事',
      terms: ['尽管如此', '与此同时', '不仅如此', '除此之外', '话虽如此', '不过话说回来', '然而'],
    },
    {
      id: 'rhetorical', label: '反问铺垫',
      hint: '提前预告「接下来有意外」',
      terms: ['谁能想到', '哪知道', '何曾想过', '殊不知', '又怎么会', '谁能料到'],
    },
    {
      id: 'intensifier', label: '副词堆叠', minPerPara: 2,
      hint: '一个「非常」不够，连着叠上去',
      terms: ['极其', '无比', '格外', '异常', '十分', '非常', '分外'],
    },
    {
      id: 'aphorism', label: '段尾金句', paraEnd: 24,
      hint: '段末突然升华，替读者把感受总结一遍',
      terms: ['一切都值得', '这就是', '这便是', '或许这就是', '他终于明白', '她终于明白', '终于懂了',
        '最好的安排', '只是过客', '不会亏待', '给自己答案', '大梦一场', '所谓成长'],
    },
  ];

  /** 句式判据：只收录「纯统计就能数出来」的那几条，数不出来的（比如陈词滥调）宁可不写。 */
  const PATTERNS = [
    { id: 'same-subject', label: '连续多句同一开头', detail: '连续 3 句以上用同一个主语/起首词，节奏立刻变平' },
    { id: 'no-dialogue', label: '连续叙述无对话', detail: '连续 3 段纯叙述，一段里没有一个字是对话' },
    { id: 'binary-contrast', label: '二元对照句', detail: '「不是X，而是Y」这类句式，AI 收尾最爱用' },
    { id: 'short-triple', label: '三短句连击', detail: '连续三句都在 7 字以内，短句是节奏、连击是机械' },
    { id: 'dash-insert', label: '破折号插入语', detail: '「——」当插入语高频使用，是英文 em dash 腔的移植' },
  ];

  const DIALOGUE_RE = /[“「『]/;
  // 只认「不是A而是B」与「与其说A不如B」两种。曾想连「没有…只是」一起收，
  // 但那会误杀「他没有回头，只是加快了脚步」这种正常写法。
  const BINARY_RE = /(不是|并非)[^。；！？]{0,16}而是|与其说[^。；！？]{0,16}不如/g;
  const SENT_SPLIT = /[。！？…；]/;
  const SHORT_SENT_MAX = 7;
  /** 短于这个长度的叙述段是正常的快节奏，不算「整段没有声音」。 */
  const PLAIN_PARA_MIN = 40;
  const PRONOUN_RE = /^(他|她|它|我|你|您|二人|两人|众人|谁)/;

  function byLengthDesc(a, b) { return b.length - a.length || (a < b ? -1 : 1); }

  function allTerms(groups) {
    const set = new Set();
    for (const g of groups) for (const t of g.terms || []) if (t) set.add(t);
    return [...set].sort(byLengthDesc);
  }

  function quoteAt(text, start, len) {
    const from = Math.max(0, start - 20);
    const to = Math.min(text.length, start + len + 32);
    return text.slice(from, to).replace(/\s+/g, ' ');
  }

  /** 段落切分，带原文偏移 —— 证据要能定位回去，不然作者点不开。tension.js 共用这一份。 */
  function paragraphs(text) {
    const s = String(text || '');
    const out = [];
    const push = (from, to) => {
      const raw = s.slice(from, to);
      const t = raw.trim();
      if (!t) return;
      const start = from + raw.indexOf(t);
      out.push({ text: t, start, end: start + t.length });
    };
    const gap = /\n+/g;
    let m, last = 0;
    while ((m = gap.exec(s))) { push(last, m.index); last = m.index + m[0].length; }
    push(last, s.length);
    return out;
  }

  /** 句切分（偏移相对整篇正文，证据要能定位回去）。 */
  function sentences(para) {
    const out = [];
    let from = 0;
    const body = para.text;
    for (let i = 0; i <= body.length; i++) {
      if (i === body.length || SENT_SPLIT.test(body[i])) {
        const seg = body.slice(from, i).trim();
        if (seg) out.push({ text: seg, start: para.start + body.indexOf(seg, from) });
        from = i + 1;
      }
    }
    return out;
  }

  /**
   * 起首词指纹。代词只取代词本身（「他看」与「他说」该算同一开头的连击），
   * 其余取前两字 —— 中文名以两字为主，这样「张三」连击抓得到，代价是三字姓名会漏。
   */
  function opener(sent) {
    const p = PRONOUN_RE.exec(sent.text);
    if (p) return p[1];
    const m = /^[\u4e00-\u9fff]{2}/.exec(sent.text);
    return m ? m[0] : null;
  }

  /** 生效的组 = 内置组（去掉作者关掉的）+ 作者自己加的禁词（成一整组）。 */
  function activeGroups(opts) {
    const off = new Set((opts && opts.disabled) || []);
    const groups = GROUPS.filter((g) => !off.has(g.id));
    const extra = ((opts && opts.extraBanned) || []).filter((t) => t && String(t).trim());
    if (extra.length) groups.push({ id: 'custom', label: '本书自定义', terms: extra.map(String) });
    return groups;
  }

  /**
   * 扫一篇正文。纯函数，不读盘。
   * @returns { chars, words, per1000, banned:[{group,groupLabel,term,at,quote}], patterns:[{id,label,count,samples}] }
   */
  function lint(text, opts = {}) {
    const body = String(text || '');
    if (opts && opts.enabled === false) {
      // 作者把整包关了：返回「什么都没查到」的空结果，而不是让三个调用方各自记得判断开关
      const words = T ? T.countWords(body) : body.length;
      return { chars: body.length, words, per1000: 0, banned: [], patterns: [] };
    }
    const paras = paragraphs(body);
    const groups = activeGroups(opts);
    const terms = allTerms(groups);
    const groupOf = new Map();
    for (const g of groups) for (const t of g.terms) if (!groupOf.has(t)) groupOf.set(t, g);

    const banned = [];
    for (const p of paras) {
      // 每段单独扫一遍，才能把「同段 ≥2」和「只在段尾」两类门槛判对
      const found = [];
      for (const term of terms) {
        let i = 0;
        while ((i = p.text.indexOf(term, i)) >= 0) {
          found.push({ term, at: p.start + i });
          i += term.length;
        }
      }
      found.sort((a, b) => a.at - b.at || b.term.length - a.term.length);
      // 「心里五味杂陈」与「五味杂陈」会双双命中同一处：按起点排序后吃掉重叠区间，一条事实只算一次
      const kept = [];
      let consumed = -1;
      for (const f of found) {
        if (f.at < consumed) continue;
        kept.push(f);
        consumed = f.at + f.term.length;
      }
      const byGroup = new Map();
      for (const f of kept) {
        const g = groupOf.get(f.term);
        if (!byGroup.has(g.id)) byGroup.set(g.id, { g, list: [] });
        byGroup.get(g.id).list.push(f);
      }
      for (const { g, list } of byGroup.values()) {
        let keep = list;
        if (g.minPerPara && list.length < g.minPerPara) continue;
        if (g.paraEnd) {
          keep = list.filter((f) => f.at + f.term.length >= p.end - g.paraEnd);
          if (!keep.length) continue;
        }
        for (const f of keep) {
          banned.push({
            group: g.id, groupLabel: g.label, term: f.term, at: f.at,
            quote: quoteAt(body, f.at, f.term.length),
          });
        }
      }
    }

    const patterns = PATTERNS.map((p) => ({ ...p, count: 0, samples: [] }));
    const pat = new Map(patterns.map((p) => [p.id, p]));
    const addSample = (id, quote) => {
      const t = pat.get(id);
      t.count += 1;
      if (t.samples.length < 3) t.samples.push(quote);
    };

    // same-subject / short-triple：在「全篇拉平的句序列」上看连击，跨段也算
    const sents = [];
    for (const p of paras) sentences(p).forEach((s) => sents.push(s));
    let runKey = null, runLen = 0, runShort = 0;
    for (const s of sents) {
      const key = opener(s);
      if (key && key === runKey) runLen += 1; else { runKey = key; runLen = 1; }
      if (runLen === 3) addSample('same-subject', quoteAt(body, s.start, s.text.length));
      const short = s.text.replace(/[\s"""'']/g, '').length <= SHORT_SENT_MAX;
      runShort = short ? runShort + 1 : 0;
      if (runShort === 3) addSample('short-triple', quoteAt(body, s.start, s.text.length));
    }

    let plainRun = 0;
    for (const p of paras) {
      if (!DIALOGUE_RE.test(p.text) && p.text.length >= PLAIN_PARA_MIN) {
        plainRun += 1;
        if (plainRun === 3) addSample('no-dialogue', quoteAt(body, p.start, 24));
      } else plainRun = 0;
    }

    let m;
    BINARY_RE.lastIndex = 0;
    while ((m = BINARY_RE.exec(body))) {
      if (m[0].length <= 28) addSample('binary-contrast', m[0]);
    }

    const words = T ? T.countWords(body) : body.length;
    const dashAt = occurrences(body, '——');
    if (words > 0 && dashAt.length / (words / 1000) >= 3) {
      const t = pat.get('dash-insert');
      t.count = dashAt.length;
      for (const at of dashAt.slice(0, 3)) t.samples.push(quoteAt(body, at, 2));
    }

    return {
      chars: body.length, words,
      per1000: words > 0 ? +(banned.length / (words / 1000)).toFixed(2) : 0,
      banned,
      patterns: patterns.filter((p) => p.count > 0),
    };
  }

  function occurrences(hay, needle) {
    const out = [];
    if (!needle) return out;
    let i = 0;
    while ((i = hay.indexOf(needle, i)) >= 0) { out.push(i); i += needle.length; }
    return out;
  }

  /**
   * 结论档位。放在包里而不是规则里，是为了让 prompt、Web、CLI 三处说的是同一句话。
   * 门槛按「千字」算：一章 2000 字和一章 6000 字不该用同一个绝对数判。
   */
  function verdict(result, opts = {}) {
    const per1000 = opts.per1000 || { warn: 3, info: 1.5 };
    const minWords = opts.minWords || 500;
    const r = result || { banned: [], patterns: [], words: 0 };
    if (r.words < minWords) return { severity: null, reasons: [] };
    const kinds = r.patterns.length;
    const reasons = [];
    if (r.per1000 >= per1000.warn) reasons.push(`禁词密度 ${r.per1000}/千字（≥${per1000.warn}）`);
    else if (r.per1000 >= per1000.info) reasons.push(`禁词密度 ${r.per1000}/千字（≥${per1000.info}）`);
    if (kinds >= 2) reasons.push(`句式套路 ${kinds} 类：${r.patterns.map((p) => p.label).join('、')}`);
    else if (kinds === 1) reasons.push(`句式套路 1 类：${r.patterns[0].label}`);
    const severity = (r.per1000 >= per1000.warn || kinds >= 2) ? 'warn'
      : (r.per1000 >= per1000.info || kinds >= 1) ? 'info' : null;
    return { severity, reasons };
  }

  /** 写之前喂给模型的那段。控制在四百字内 —— 它是约束，不是资料，抢的是正文预算。 */
  function promptBlock(opts = {}) {
    if (opts.enabled === false) return '';
    const groups = activeGroups(opts);
    if (!groups.length) return '';   // 八组全关掉：别留一个只有句式行的空壳在 prompt 里占预算
    const lines = ['去 AI 味（以下几类词与句式不要出现在正文里）：'];
    for (const g of groups) {
      lines.push(`- ${g.label}：${(g.terms || []).slice(0, 6).join('、')}${(g.terms || []).length > 6 ? ' 等' : ''}`);
    }
    lines.push('- 句式：' + PATTERNS.map((p) => p.label).join('、') + '（每种都算数）');
    lines.push('- 改法：把「他心里五味杂陈」换成一个动作；把「仿佛……」删掉，直接写下一件事；段尾不写感悟，收在动作或一句台词上');
    return lines.join('\n');
  }

  /** 一本书的规则包开关：从 book 记录上的 stylePack 字段读，没有就用默认包。 */
  function optsFrom(book) {
    const sp = (book && book.stylePack) || {};
    return {
      enabled: sp.enabled !== false,
      disabled: Array.isArray(sp.disabled) ? sp.disabled : [],
      extraBanned: Array.isArray(sp.extraBanned) ? sp.extraBanned : [],
    };
  }

  function groupMeta(id) {
    return GROUPS.find((g) => g.id === id) || null;
  }

  return {
    PACK_VERSION, GROUPS, PATTERNS,
    lint, verdict, promptBlock, optsFrom, activeGroups, groupMeta, paragraphs,
  };
});
