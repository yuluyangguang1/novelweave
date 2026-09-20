/**
 * NovelWeave · 织文 — 连续性引擎（UMD：浏览器与 Node 共用）
 *
 * 纯函数：输入一个装配好的 ctx，输出 diagnostics。不读盘、不 await、不碰 DOM。
 * 浏览器里的「一致性检查」面板和 agent 跑的 nw-continuity.mjs 走同一条路径，
 * 因此同一条矛盾在两边的 rule id 与 fingerprint 必然相同。
 *
 * 每条规则都必须自带误报控制。误报的检查器会被作者关掉，等于没有。
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWBible, root.NWStylePack, root.NWTension);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWRules = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, Bible, StylePack, Tension) {
  'use strict';

  const ENGINE_VERSION = '1.0.0';
  const FLAGS = new Set(Bible ? Bible.CHAPTER_FLAGS : ['flashback', 'dream', 'quoted', 'offscreen', 'montage']);
  const EXEMPT_FLAGS = new Set(['flashback', 'dream', 'quoted', 'offscreen']);

  /** 回忆语境标记：命中则把「死人出场」从 error 降到 info，而不是直接闭嘴。 */
  const RECALL_RE = /当年|那时|生前|记忆里|记忆中|恍惚|幻影|识海|梦中|梦里|回忆|依稀|仿佛又|像从前|脑海里/;

  // R17 章末钩子：结尾窗口内的悬念标记（问号 / 突转 / 留白）。刻意保守——
  // 查不到信号只说明"机器看不出钩子"，不是"没有钩子"，所以本规则恒为 info。
  const HOOK_RE = /[？?]|突然|没想到|只见|下一瞬|下一刻|话音未落|猛地|凭空|异变|还没等|未完待续|欲知后事/;
  const SOFTEN_RE = /想起|仿佛|好像|像从前|似乎|宛如/;

  /** 动作邻近式：名字出现在这里还不够，得确实在「做事」才算出场。 */
  const ACTION_RE = new RegExp(
    [
      '说道|问道|答道|喝道|笑道|冷笑道|怒道|叹道|应道|喊道|说|开口|低语|喃喃|回答|喝问',
      '走|站|坐|躺|跪|趴|扑|冲|跃|闪|躲|退|跑|奔|爬|踏|落|飞',
      '伸手|抬|举|握|抓|掐|摸|拿|持|执|拎|拽|甩|推|拉|按|拍|敲|戳|抱|揽|抚|摸',
      '点头|摇头|皱眉|眯眼|瞪|盯|望|看|瞥|扫|环顾|抬头|低头|回头|转身|侧头',
      '拔|挥|斩|劈|刺|轰|挡|格|施|催动|运转|催|掐诀|结印|祭出|召出',
      '吃|喝|吐|咳|喘|睡|醒|睁眼|闭眼|咽|咬|叹|哼|骂|吼|哭|泣|颤|抖',
    ].join('|'),
  );

  /** 常见姓，用于「未登记实体」的候选抽取。可通过 ctx.lexicon.surnames 覆盖。 */
  const DEFAULT_SURNAMES =
    '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵季贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢';
  /**
   * 日内时段次序。时辰必须参与比较，否则「第 1 章夜里发生、
   * 第 2 章写当天清晨」这种真回退会被漏掉。
   */
  const CLOCK_ORDER = ['黎明', '晨', '午', '暮', '夜', '三更'];
  const CLOCK_FRACTION = { 黎明: 0.05, 晨: 0.15, 午: 0.45, 暮: 0.7, 夜: 0.85, 三更: 0.95 };

  /** day + 时辰 → 可比较的连续时间戳；day 非数字则不可比较。 */
  function stamp(at) {
    const day = Number(at?.day);
    if (!Number.isFinite(day)) return null;
    return { ts: day + (CLOCK_FRACTION[at.clock] ?? 0) };
  }

  function describe(at) {
    return `第${at?.day}天${at?.clock ? '·' + at.clock : ''}`;
  }

  // ═══════════════════ 工具 ═══════════════════

  function occurrences(hay, needle) {
    const out = [];
    if (!needle) return out;
    let i = 0;
    while ((i = hay.indexOf(needle, i)) >= 0) {
      out.push(i);
      i += needle.length;
    }
    return out;
  }

  function quoteAt(body, start, len) {
    const from = Math.max(0, start - 24);
    const to = Math.min(body.length, start + len + 40);
    return { quote: body.slice(from, to).replace(/\s+/g, ' '), offset: [start, start + len] };
  }

  /** 角色的可检索称呼：本名 + 别名。单字词噪声太大，一律要求两字以上。 */
  function nameForms(c) {
    const forms = [c.name, ...((c.aliases || []).map((a) => (typeof a === 'string' ? a : a.text)))];
    return T.uniq(forms.filter((s) => typeof s === 'string' && s.trim().length >= 2));
  }

  /**
   * 人名候选抽取：只出候选，不断定谁是角色。
   * R9（未登记实体）与 `nw-io adopt`（散稿建档）共用这一套识别器 ——
   * 分成两份迟早会出现「建档时看得见、检查时看不见」的自相矛盾。
   * @param opts { minCount, minChapters, limit, exclude }
   *   exclude=false 给新书用：那时本来什么都没登记，排除集是空的。
   */
  function entityCandidates(ctx, opts = {}) {
    const { minCount = 2, minChapters = 2, limit = 15, exclude = true } = opts;
    const known = new Set();
    if (exclude) {
      Object.keys(ctx.lexicon?.names || {}).forEach((n) => known.add(n));
      (ctx.lexicon?.allowlist || []).forEach((n) => known.add(n));
      for (const c of ctx.characters || []) nameForms(c).forEach((f) => known.add(f));
      for (const w of ctx.world || []) { known.add(w.name); (w.keys || []).forEach((k) => known.add(k)); }
    }

    const surnames = Array.isArray(ctx.lexicon?.surnames)
      ? ctx.lexicon.surnames.join('') : String(ctx.lexicon?.surnames || DEFAULT_SURNAMES);
    const surnameClass = surnames.replace(/[\\\]^-]/g, '\\$&');
    const surnameRe = new RegExp(`[${surnameClass}][\\u4e00-\\u9fff]{1,2}`, 'g');
    const suffixRe = /[\u4e00-\u9fff]{2,4}(?:长老|宗主|掌门|仙子|公子|大人|前辈|师兄|师姐|宗师|真人|夫人|少爷|小姐|郡主|国师|阁主|门主|家主|城主|老祖|老怪|道人|散人)/g;

    // 「路他已」「经看了」这类是误报：姓字后面接的其实是普通词。
    // 只过滤姓氏式匹配；称谓式本身就带信息（林夫人 / 张道人 都含「人」，不能被虚词规则误杀）。
    const STOP = /[的他她它这那了的是有在不和事与或和被给很都也就要能会对将从但如若因所之其者更最太什么怎谁吗呢啊吧]/;

    const counts = new Map();
    for (const ch of ctx.chapters || []) {
      const body = ch.body || '';
      const seen = new Set();
      let m;
      surnameRe.lastIndex = 0;
      while ((m = surnameRe.exec(body))) if (!STOP.test(m[0])) seen.add(m[0]);
      suffixRe.lastIndex = 0;
      while ((m = suffixRe.exec(body))) seen.add(m[0]);
      for (const cand of seen) {
        const cur = counts.get(cand) || { name: cand, n: 0, chapters: [] };
        cur.n += occurrences(body, cand).length;
        cur.chapters.push(ch.id);
        counts.set(cand, cur);
      }
    }
    return [...counts.values()]
      .filter((s) => s.n >= minCount && s.chapters.length >= minChapters && !known.has(s.name))
      // 平次时按码位排，别依赖 Map 插入顺序或 ICU locale —— 指纹要稳定
      .sort((a, b) => (b.n - a.n) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, limit);
  }

  function chapterNumberMap(ctx) {
    const m = new Map();
    for (const ch of ctx.chapters) m.set(ch.id, ch.number);
    return m;
  }

  function isExempt(chapter) {
    return (chapter.flags || []).some((f) => EXEMPT_FLAGS.has(f));
  }

  /**
   * term 在正文里最早出现的位置（只认字面命中，跳过回忆类标记章）。
   * @param fromN 只看第 fromN 章及之后；默认全书
   * @returns null 表示从未出现
   */
  function firstAppearance(ctx, term, fromN = 0) {
    if (!term) return null;
    let best = null;
    for (const ch of ctx.chapters) {
      if (isExempt(ch)) continue;
      if (!Number.isFinite(ch.number) || ch.number < fromN) continue;
      const body = ch.body || '';
      const at = occurrences(body, term)[0];
      if (at == null) continue;
      if (best == null || ch.number < best.n) best = { chapter: ch.id, n: ch.number, quote: quoteAt(body, at, term.length).quote };
    }
    return best;
  }

  /**
   * 状态维度比较：列表维度（伤势/持有/所知）去空去重后按行比，标量按字符串比。
   * 只在 R24 里用来回答「这一章有没有真的改变谁的处境」。
   */
  function dimValue(dims, name) {
    const v = dims?.[name];
    if (Array.isArray(v)) return T.uniq(v.map(String).map((s) => s.trim()).filter(Boolean)).join('\n');
    return v == null ? '' : String(v).trim();
  }

  function dimsChanged(before, after) {
    const dims = Bible ? Bible.STATE_DIMS : ['loc', 'alive', 'injury', 'items', 'knows', 'goal'];
    return dims.some((d) => dimValue(before, d) !== dimValue(after, d));
  }

  /**
   * 文本归一化：只留汉字、字母与数字。标点、空白、引号全去掉，
   * 所以「改了标点没改字」和「登记依据时顺手省了逗号」都不算对不上。
   * R26 的整句比对与 R27 的依据回查共用这一份。
   */
  function normText(s) {
    return String(s || '').replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '');
  }

  function diag(rule, hit) {
    const chapter = hit.chapter || null;
    const entity = hit.entity || null;
    return {
      rule,
      source: hit.source || 'machine',
      severity: hit.severity || 'error',
      chapter,
      entity,
      evidence: hit.evidence || {},
      message: hit.message,
      suggestion: hit.suggestion || '',
      confidence: hit.confidence ?? 1,
      needsReview: false,
      fingerprint: hit.fingerprint || `${rule}:${chapter || '-'}:${entity || '-'}`,
      suppressedBy: null,
    };
  }

  // ═══════════════════ 规则 ═══════════════════

  const RULES = {
    'dead-character-on-stage': {
      code: 'R1',
      defaultSeverity: 'error',
      scope: 'chapter',
      summary: '已死亡角色在后面章节里被写成正在行动。',
      detail:
        '先看章级声明（author 把该角色列进 frontmatter.characters 即视为出场，直接 error）；' +
        '再看正文中名字/别名出现点后 30 字内是否命中动作词表。命中回忆标记词或该章带 ' +
        'flashback/dream/quoted/offscreen 标记时降级或跳过。',
      run(ctx) {
        const out = [];
        const num = ctx.chapterNumbers;
        for (const c of ctx.characters) {
          if (c.status !== 'deceased' || c.enabled === false) continue;
          const diedAt = c['died-in'] ? num.get(c['died-in']) : undefined;
          if (diedAt == null) continue; // 缺 died-in 由 status-declared-contradiction 负责报
          for (const ch of ctx.chapters) {
            if (ch.number <= diedAt) continue;
            if (isExempt(ch)) continue;
            const declared = (ch.characters || []).includes(c.id);
            if (declared) {
              out.push(diag('dead-character-on-stage', {
                chapter: ch.id,
                entity: c.id,
                severity: 'error',
                evidence: { basis: [`character.status=deceased`, `died-in=${c['died-in']}`, `chapter.characters 包含 ${c.id}`] },
                message: `${c.name} 于 ${c['died-in']} 死亡，但 ${ch.id} 把它列为出场角色。`,
                suggestion: `若只是被提及，请把 ${c.id} 从 characters 移到 mentions；若是闪回，给本章加 flags:[flashback]。`,
              }));
              continue;
            }
            const body = ch.body || '';
            let hitOne = null;
            for (const form of nameForms(c)) {
              for (const at of occurrences(body, form)) {
                const tail = body.slice(at + form.length);
                const lead = tail.match(/^[\s，、。「」“”：；！?？]*/)[0];
                if (tail.slice(lead.length).startsWith('的')) continue; // 领属提及，不是本人在行动
                const after = tail.slice(0, 30);
                if (!ACTION_RE.test(after)) continue;
                const recalled = RECALL_RE.test(body.slice(Math.max(0, at - 60), at));
                hitOne = diag('dead-character-on-stage', {
                  chapter: ch.id,
                  entity: c.id,
                  severity: recalled ? 'info' : 'error',
                  confidence: recalled ? 0.6 : 1,
                  evidence: {
                    ...quoteAt(body, at, form.length),
                    basis: [`character.status=deceased`, `died-in=${c['died-in']}`, `动作邻近命中「${form}」`, recalled ? '命中回忆标记词' : '无回忆标记'],
                  },
                  message: `${c.name} 于 ${c['died-in']} 死亡，但在 ${ch.id} 被写成正在行动。`,
                  suggestion: recalled
                    ? '看起来是回忆段落。若确为回忆，建议给本章加 flags:[flashback] 以免反复告警。'
                    : `确认是否为闪回；若是给 ${ch.id} 加 flags:[flashback]，否则改写该段。`,
                });
                if (!recalled) break;
              }
              if (hitOne && hitOne.severity === 'error') break;
            }
            if (hitOne) out.push(hitOne);
          }
        }
        return out;
      },
    },

    'status-declared-contradiction': {
      code: 'R2',
      defaultSeverity: 'error',
      scope: 'book',
      summary: '角色状态、死亡章节、分章状态快照三者互斥。',
      detail:
        'status=deceased 但 died-in 为空；或某章 states.json 里该实体的 alive 维度与角色卡的 status 相反。' +
        'missing 状态只报 warn，因为「下落不明」本身就允许信息不全。',
      run(ctx) {
        const out = [];
        for (const c of ctx.characters) {
          if (c.enabled === false) continue;
          if (c.status === 'deceased' && !c['died-in']) {
            out.push(diag('status-declared-contradiction', {
              entity: c.id,
              evidence: { basis: ['status=deceased', 'died-in 为空'] },
              message: `${c.name} 标记为已死亡，但没有写明死于哪一章。`,
              suggestion: `给角色卡补 died-in（章节 id），否则死亡之后的所有出场检查都无法进行。`,
            }));
          }
          for (const ch of ctx.chapters) {
            const st = ctx.states?.byChapter?.[ch.id]?.[c.id];
            if (!st || !st.alive) continue;
            const want = c.status === 'deceased' ? 'deceased' : c.status;
            if (st.alive !== want && st.alive !== 'unknown') {
              out.push(diag('status-declared-contradiction', {
                chapter: ch.id,
                entity: c.id,
                severity: c.status === 'missing' || st.alive === 'missing' ? 'warn' : 'error',
                evidence: { basis: [`character.status=${c.status}`, `states[${ch.id}].${c.id}.alive=${st.alive}`] },
                message: `${c.name} 的角色卡状态是 ${c.status}，但 ${ch.id} 的状态快照写成 ${st.alive}。`,
                suggestion: '两处必有一处过时。以正文实际发生的情节为准，改正另一处。',
              }));
            }
          }
        }
        return out;
      },
    },

    'promise-unpaid': {
      code: 'R3',
      defaultSeverity: 'warn',
      scope: 'book',
      summary: '伏笔埋下后长期未回收。',
      detail:
        'weight=major 超过 10 章未收报 warn，超过 20 章升 error；weight=minor 阈值为 25/50。' +
        'candidate（脚本自动登记、作者未确认）一律不报；设了 payoff.due 的交给 promise-overdue，避免重复。' +
        '每本书最多输出 8 条，按紧迫度截断。',
      run(ctx) {
        const out = [];
        const last = ctx.chapters.reduce((m, c) => Math.max(m, c.number || 0), 0);
        for (const it of ctx.promises?.items || []) {
          if (it.type !== 'promise') continue;
          if (!['planned', 'planted'].includes(it.status)) continue;
          if (it.weight === 'candidate') continue;
          if (it.payoff?.due) continue;
          const setupN = it.setup?.chapter ? ctx.chapterNumbers.get(it.setup.chapter) : null;
          if (setupN == null) continue;
          const gap = last - setupN;
          const base = it.weight === 'minor' ? 25 : 10;
          if (gap < base) continue;
          out.push({ gap, d: diag('promise-unpaid', {
            chapter: it.setup.chapter,
            entity: it.id,
            severity: gap >= base * 2 ? 'error' : 'warn',
            evidence: { quote: it.setup.evidence || '', basis: [`status=${it.status}`, `weight=${it.weight || 'major'}`, `埋于第 ${setupN} 章，已 ${gap} 章未回收`] },
            message: `伏笔「${it.title}」埋于 ${it.setup.chapter}，到最新章已跨 ${gap} 章仍未回收。`,
            suggestion: `回收它，或把 status 改为 dropped 并在 notes 说明弃用原因；也可用 payoff.due 设一个期限。`,
          }) });
        }
        out.sort((a, b) => b.gap - a.gap);
        return out.slice(0, 8).map((x) => x.d);
      },
    },

    'promise-overdue': {
      code: 'R3b',
      defaultSeverity: 'error',
      scope: 'book',
      summary: '伏笔超过作者自设的回收期限仍未回收。',
      detail: 'payoff.due 指向的章号已经过去，但 status 仍不是 paid-off/dropped。due 解析不到存在的章则由 dangling-reference 负责。',
      run(ctx) {
        const out = [];
        const last = ctx.chapters.reduce((m, c) => Math.max(m, c.number || 0), 0);
        for (const it of ctx.promises?.items || []) {
          if (it.type !== 'promise' || !it.payoff?.due) continue;
          if (['paid-off', 'dropped'].includes(it.status)) continue;
          const dueN = ctx.chapterNumbers.get(it.payoff.due);
          if (dueN == null || last <= dueN) continue;
          out.push(diag('promise-overdue', {
            chapter: it.payoff.due,
            entity: it.id,
            message: `伏笔「${it.title}」约定在 ${it.payoff.due} 回收，但已到第 ${last} 章仍未回收。`,
            evidence: { basis: [`payoff.due=${it.payoff.due}`, `status=${it.status}`] },
            suggestion: '补写回收，或改掉期限。',
          }));
        }
        return out;
      },
    },

    'payoff-before-setup': {
      code: 'R4',
      defaultSeverity: 'error',
      scope: 'book',
      summary: '回收发生在埋设之前，或声明回收却没登记埋设。',
      detail: 'payoff.chapter 的章号不大于 setup.chapter 即判错；status 已是 planted/paid-off 但 setup 缺失同样判错。',
      run(ctx) {
        const out = [];
        for (const it of ctx.promises?.items || []) {
          if (it.type !== 'promise') continue;
          const pN = it.payoff?.chapter ? ctx.chapterNumbers.get(it.payoff.chapter) : null;
          const sN = it.setup?.chapter ? ctx.chapterNumbers.get(it.setup.chapter) : null;
          if (pN != null && sN != null && pN <= sN) {
            out.push(diag('payoff-before-setup', {
              chapter: it.payoff.chapter,
              entity: it.id,
              message: `伏笔「${it.title}」的回收（${it.payoff.chapter}）不晚于埋设（${it.setup.chapter}）。`,
              evidence: { basis: [`setup=${it.setup.chapter}(#${sN})`, `payoff=${it.payoff.chapter}(#${pN})`] },
              suggestion: '核对两个章节号；同一章内既埋又收是合法的，但需要写明。',
            }));
          }
          if (['planted', 'paid-off'].includes(it.status) && !it.setup?.chapter) {
            out.push(diag('payoff-before-setup', {
              entity: it.id,
              severity: 'error',
              message: `伏笔「${it.title}」状态是 ${it.status}，但没有登记埋设章节。`,
              evidence: { basis: [`status=${it.status}`, 'setup.chapter 缺失'] },
              suggestion: '补 setup.chapter，否则连续性检查无法追踪它。',
            }));
          }
        }
        return out;
      },
    },

    'timeline-regression': {
      code: 'R6',
      defaultSeverity: 'error',
      scope: 'chapter',
      summary: '同一叙事线上，故事时间倒着走。',
      detail:
        '按章序遍历带 `day` 的锚点，维护每条 thread 至今的最大时间戳（day + 时辰折算），' +
        '后来的锚点时间戳更小即判回退。**不同 thread 永不互比** —— 多线并行是合法叙事。' +
        '锚点所在章带 flashback/dream/quoted/offscreen 标记时跳过该锚点。' +
        '只有 confidence 为 explicit/author 才出 error，`implied`（从"三天后"这类叙述推出来的）' +
        '一律降为 info：推断出的时间本来就不可靠，让它报错只会逼作者关掉检查器。' +
        '判出回退后不回写最大值，避免一个坏锚点引发连锁误报。',
      run(ctx) {
        const anchors = (ctx.timeline?.anchors || []).filter((a) => a.chapter && stamp(a.at));
        if (anchors.length < 2) return [];
        const rows = anchors
          .map((a) => ({ a, n: ctx.chapterNumbers.get(a.chapter), s: stamp(a.at) }))
          .filter((x) => x.n != null)
          .sort((x, y) => x.n - y.n || CLOCK_ORDER.indexOf(x.a.at.clock) - CLOCK_ORDER.indexOf(y.a.at.clock));

        const flagsOf = new Map(ctx.chapters.map((c) => [c.id, c.flags || []]));
        const maxByThread = new Map();
        const out = [];
        for (const { a, n, s } of rows) {
          if ((flagsOf.get(a.chapter) || []).some((f) => EXEMPT_FLAGS.has(f))) continue;
          const thread = a.thread || '_';
          const prev = maxByThread.get(thread);
          if (prev && s.ts < prev.s.ts) {
            const implied = a.confidence === 'implied';
            out.push(diag('timeline-regression', {
              chapter: a.chapter,
              entity: a.id,
              severity: implied ? 'info' : 'error',
              confidence: implied ? 0.5 : 1,
              evidence: {
                basis: [
                  `${a.id} @第${n}章 ${describe(a.at)}`,
                  `其后的 ${prev.a.id} @第${prev.n}章 ${describe(prev.a.at)}`,
                  `thread=${thread}`,
                  `confidence=${a.confidence || '未设'}`,
                ],
              },
              message: `「${a.label || a.id}」标为 ${describe(a.at)}，却排在「${prev.a.label || prev.a.id}」（${describe(prev.a.at)}）之后。`,
              suggestion: '核对 day 与时辰；若这两条本属并行展开的不同线，请给锚点填 thread；若该章是闪回，加 flags:[flashback]。',
            }));
            continue;
          }
          if (!prev || s.ts > prev.s.ts) maxByThread.set(thread, { a, n, s });
        }
        return out;
      },
    },

    'appearance-token-violation': {
      code: 'R7',
      defaultSeverity: 'warn',
      scope: 'chapter',
      summary: '外貌特征出现在它的生效区间之外。',
      detail:
        'token.since 之前的章里出现该特征 = 提前出现（warn）；token.until 之后仍出现 = 特征消失了却没交代（error）。' +
        '命中「想起/仿佛/好像」等 Soften 词降到 info；allowIn 白名单章跳过；每 token 最多报 3 条。',
      run(ctx) {
        const out = [];
        for (const c of ctx.characters) {
          if (c.enabled === false) continue;
          for (const tok of c.appearance?.tokens || []) {
            const key = tok.key;
            if (!key || key.trim().length < 2) continue;
            const sinceN = tok.since ? ctx.chapterNumbers.get(tok.since) : null;
            const untilN = tok.until ? ctx.chapterNumbers.get(tok.until) : null;
            let n = 0;
            for (const ch of ctx.chapters) {
              if (n >= 3) break;
              if ((tok.allowIn || []).includes(ch.id)) continue;
              const found = (ch.body || '').indexOf(key);
              if (found < 0) continue;
              const premature = sinceN != null && ch.number < sinceN;
              const stale = untilN != null && ch.number > untilN;
              if (!premature && !stale) continue;
              const softened = SOFTEN_RE.test((ch.body || '').slice(Math.max(0, found - 80), found));
              out.push(diag('appearance-token-violation', {
                chapter: ch.id,
                entity: c.id,
                severity: stale ? (softened ? 'info' : 'error') : (softened ? 'info' : 'warn'),
                confidence: softened ? 0.6 : 1,
                evidence: {
                  ...quoteAt(ch.body || '', found, key.length),
                  basis: [`token=${key}`, premature ? `since=${tok.since}(#${sinceN})` : '', stale ? `until=${tok.until}(#${untilN})` : ''].filter(Boolean),
                },
                message: stale
                  ? `「${c.name}」的「${key}」在 ${tok.until} 之后已不适用，但 ${ch.id} 仍在描述它。`
                  : `「${c.name}」的「${key}」要到 ${tok.since} 才获得，却在更早的 ${ch.id} 出现了。`,
                suggestion: stale
                  ? '交代特征消失的原因（伤愈/易容/失去肢体），或删掉这处描写，或清掉 token.until。'
                  : '核对 since 章节号，或把该处描写改掉。',
              }));
              n++;
            }
          }
        }
        return out;
      },
    },

    'unregistered-entity': {
      code: 'R9',
      defaultSeverity: 'info',
      scope: 'book',
      summary: '反复出现却没建档的人名。',
      detail:
        '候选抽取用「常见姓 + 1~2 字」与「2~4 字 + 称谓后缀」两式；要求出现 ≥2 次且跨 ≥2 章，' +
        '再排除 lexicon.names、角色本名与别名、世界条目名与关键词、allowlist。' +
        '聚合成一条诊断列出 top 15，不刷屏。自动登记的伏笔类条目 weight 记 candidate。',
      run(ctx) {
        const suspects = entityCandidates(ctx);
        if (!suspects.length) return [];
        return [diag('unregistered-entity', {
          severity: 'info',
          confidence: 0.5,
          entity: suspects[0].name,
          evidence: { basis: suspects.map((s) => `${s.name}:${s.n}次/${s.chapters.length}章`) },
          message: `${suspects.length} 个反复出现的人名没有建档：${suspects.map((s) => `${s.name}(${s.n})`).join('、')}。`,
          suggestion: '若是有名字无档案的杂名，加进 lexicon.allowlist；若该建档，请补角色卡。',
        })];
      },
    },

    'structure-invalid': {
      code: 'R14',
      defaultSeverity: 'error',
      scope: 'book',
      summary: '章号重复/非法、状态值非枚举、文件名与 frontmatter id 不符。',
      detail: '结构性问题会让所有依赖章序的规则失真，所以优先级最高。缺号只报 warn（删章后重排是正常路径，但没重排说明流程有漏）。',
      run(ctx) {
        const out = [];
        const byNumber = new Map();
        const byId = new Map();
        const bySlug = new Map();
        for (const ch of ctx.chapters) {
          if (!Number.isInteger(ch.number) || ch.number < 0) {
            out.push(diag('structure-invalid', {
              chapter: ch.id,
              message: `${ch.id} 的 number 是 ${JSON.stringify(ch.number)}，必须是 ≥0 的整数（0 = 楔子/序）。`,
              evidence: { basis: ['number 非法'] },
              suggestion: '修正 frontmatter 的 number。',
            }));
            continue;
          }
          if (byNumber.has(ch.number)) {
            out.push(diag('structure-invalid', {
              chapter: ch.id,
              message: `章号 ${ch.number} 被 ${byNumber.get(ch.number)} 与 ${ch.id} 同时使用，排序未定义。`,
              evidence: { basis: [`duplicate number=${ch.number}`] },
              suggestion: '重排章号，保证全书唯一且连续。',
            }));
          } else byNumber.set(ch.number, ch.id);

          if (byId.has(ch.id)) {
            out.push(diag('structure-invalid', {
              chapter: ch.id,
              message: `章节 id ${ch.id} 出现多次（${byId.get(ch.id)} 与 ${ch.id}）。`,
              evidence: { basis: ['duplicate id'] },
              suggestion: 'id 必须唯一，否则会互相覆盖。',
            }));
          } else byId.set(ch.id, ch.number);

          if (ch.slug) {
            if (bySlug.has(ch.slug)) {
              out.push(diag('structure-invalid', {
                chapter: ch.id, severity: 'warn',
                message: `slug「${ch.slug}」被 ${bySlug.get(ch.slug)} 与 ${ch.id} 共用。`,
                evidence: { basis: ['duplicate slug'] },
                suggestion: '给其中一个加后缀，否则文件名会互相覆盖。',
              }));
            } else bySlug.set(ch.slug, ch.id);
          }
          if (ch.status && Bible && !Bible.CHAPTER_STATUS.includes(ch.status)) {
            out.push(diag('structure-invalid', {
              chapter: ch.id,
              message: `${ch.id} 的 status「${ch.status}」不在允许值内。`,
              evidence: { basis: [`enum=${Bible.CHAPTER_STATUS.join('|')}`] },
              suggestion: '改成 outline/draft/revised/final/complete 之一。',
            }));
          }
        }
        const nums = [...byNumber.keys()].sort((a, b) => a - b);
        for (let i = 0; i < nums.length; i++) {
          if (nums[i] !== i + 1) {
            out.push(diag('structure-invalid', {
              severity: 'warn',
              entity: nums[i] ? byNumber.get(nums[i]) : null,
              message: `章号不连续：期望 ${i + 1}，实际 ${nums[i]}（${byNumber.get(nums[i])}）。`,
              evidence: { basis: ['number gap'] },
              suggestion: '跑一次重排，或在文档里说明留号意图。',
            }));
            break;
          }
        }
        return out;
      },
    },

    'dangling-reference': {
      code: 'R15',
      defaultSeverity: 'error',
      scope: 'chapter',
      summary: '引用了不存在的实体或章节。',
      detail:
        '扫描章 frontmatter 的 characters/mentions/locations、pov、time_anchor，角色卡的 first/died-in，' +
        '伏笔登记表的 setup/payoff/due 与 characters/world。断链会让别的规则静默失效，必须显式报出。',
      run(ctx) {
        const out = [];
        const charIds = new Set(ctx.characters.map((c) => c.id));
        const worldIds = new Set(ctx.world.map((w) => w.id));
        const chIds = new Set(ctx.chapters.map((c) => c.id));
        const anchorIds = new Set([...(ctx.timeline?.anchors || []), ...(ctx.timeline?.backstory || [])].map((a) => a.id));

        const push = (chapter, entity, ref, what) => out.push(diag('dangling-reference', {
          chapter, entity: entity || null,
          message: `${chapter || what} 引用的 ${what}「${ref}」不存在。`,
          evidence: { basis: [`未找到 ${ref}`] },
          suggestion: `建档，或改掉这个引用。`,
        }));

        for (const ch of ctx.chapters) {
          for (const id of ch.characters || []) if (!charIds.has(id)) push(ch.id, id, id, '角色');
          for (const id of ch.mentions || []) if (!charIds.has(id)) push(ch.id, id, id, '角色');
          for (const id of ch.locations || []) if (!worldIds.has(id)) push(ch.id, id, id, '世界条目');
          if (ch.pov && !charIds.has(ch.pov)) push(ch.id, ch.pov, ch.pov, '视角角色');
          if (ch.time_anchor && !anchorIds.has(ch.time_anchor)) push(ch.id, null, ch.time_anchor, '时间锚点');
        }
        for (const c of ctx.characters) {
          if (c.first && !chIds.has(c.first)) push(null, c.id, c.first, '首次出场章节');
          if (c['died-in'] && !chIds.has(c['died-in'])) push(null, c.id, c['died-in'], '死亡章节');
        }
        for (const it of ctx.promises?.items || []) {
          for (const ref of [it.setup?.chapter, it.payoff?.chapter, it.payoff?.due]) {
            if (ref && !chIds.has(ref)) push(null, it.id, ref, '伏笔关联章节');
          }
          for (const id of it.characters || []) if (!charIds.has(id)) push(null, it.id, id, '伏笔关联角色');
        }
        return out;
      },
    },

    'derived-field-touched': {
      code: 'R16',
      defaultSeverity: 'warn',
      scope: 'chapter',
      summary: '派生字段与重算结果不一致。',
      detail:
        'x-words 与全书统计字段只允许脚本写。不等说明有人手改过派生值，或写正文后没重算。' +
        '报告直接给出修复动作。',
      run(ctx) {
        const out = [];
        for (const ch of ctx.chapters) {
          if (ch.xWords == null) continue;
          const actual = T.countWords(ch.body);
          if (actual !== ch.xWords) {
            out.push(diag('derived-field-touched', {
              chapter: ch.id,
              message: `${ch.id} 的 x-words 是 ${ch.xWords}，重算结果是 ${actual}。`,
              evidence: { basis: [`x-words=${ch.xWords}`, `countWords(body)=${actual}`] },
              suggestion: '不要手改 x-* 字段；跑 `node scripts/nw-io.mjs recount` 让它回正。',
            }));
          }
        }
        const d = ctx.book?._derived;
        if (d && d.words != null) {
          const actual = ctx.chapters.reduce((s, c) => s + T.countWords(c.body), 0);
          if (actual !== d.words) {
            out.push(diag('derived-field-touched', {
              message: `book._derived.words 是 ${d.words}，重算结果是 ${actual}。`,
              evidence: { basis: ['_derived.words 过期'] },
              suggestion: '跑 `node scripts/nw-io.mjs recount` 重算全书统计。',
            }));
          }
        }
        return out;
      },
    },

    'chapter-end-hook': {
      code: 'R17',
      defaultSeverity: 'info',
      scope: 'chapter',
      summary: '章节结尾没有钩子信号（本章未新埋伏笔，结尾 300 字也无悬念标记）。',
      detail:
        '机器只能查结构信号：本章是否新埋了 promise（setup 指向本章），或结尾 300 字内' +
        '是否出现问号 / 突转 / 留白类标记。两者皆无时给 info。钩子的质量无法机器判定，' +
        '本条恒为 info，永不计入退出码；带 flashback 等豁免标记的章节跳过。',
      run(ctx) {
        const out = [];
        const items = ctx.promises?.items || [];
        // 短篇换挡：短篇一章往往只有几百字（一章≈一屏到三屏），800 字门槛会漏掉大半
        const isShort = ctx.book?.format === 'short';
        const minBody = isShort ? 300 : 800;
        for (const ch of ctx.chapters) {
          if (isExempt(ch)) continue;
          const body = (ch.body || '').trim();
          if (body.length < minBody) continue; // 短章与空章不评钩子
          const plants = items.some(
            (i) => i.type === 'promise' && i.setup?.chapter === ch.id && i.status !== 'cancelled',
          );
          if (plants) continue; // 本章新埋了伏笔，本身就是钩子
          if (HOOK_RE.test(body.slice(-300))) continue;
          out.push(diag('chapter-end-hook', {
            chapter: ch.id,
            severity: 'info',
            confidence: 0.5,
            evidence: { basis: ['本章无新埋伏笔', '结尾 300 字无悬念标记'] },
            message: `${ch.id} 结尾未检测到钩子信号。`,
            suggestion: isShort
              ? '短篇的每个收束点都是屏末，最好留一个反转或未决动作。若本章确为收束章，忽略即可。'
              : '网文一章的收尾最好留一个未决动作、问句或突转。若本章确为收束章，忽略即可。',
          }));
        }
        return out;
      },
    },

    'item-reappear': {
      code: 'R18',
      defaultSeverity: 'info',
      scope: 'book',
      summary: '物品在状态矩阵中连续缺席后又重新出现在持有物里。',
      detail:
        '以状态矩阵为准：某物品在某章记录于「持有物」，之后连续缺席，再往后又出现 —— ' +
        '要么是中间章节忘了记，要么是失去了又重新获得但没写。矩阵没记不等于物品不存在，' +
        '所以本条恒为 info，只提示补账或补情节，永不计入退出码。',
      run(ctx) {
        const out = [];
        const byChapter = ctx.states?.byChapter || {};
        const ents = new Map();
        for (const [chId, dims] of Object.entries(byChapter)) {
          const n = ctx.chapterNumbers.get(chId);
          if (n == null) continue;
          for (const [entId, d] of Object.entries(dims || {})) {
            if (!ents.has(entId)) ents.set(entId, []);
            ents.get(entId).push({
              n, chId,
              items: Array.isArray(d?.items) ? d.items.filter(Boolean) : [],
            });
          }
        }
        for (const [entId, recs] of ents) {
          if (recs.length < 3) continue; // 记录太少不足以判断"缺席"
          recs.sort((a, b) => a.n - b.n);
          const lastSeen = new Map(); // 物品 → 最后出现的章号
          const gapped = new Set();   // 已进入缺席期的物品
          for (const r of recs) {
            const cur = new Set(r.items);
            for (const item of cur) {
              const lastN = lastSeen.get(item);
              if (lastN != null && gapped.has(item) && r.n - lastN >= 2) {
                out.push(diag('item-reappear', {
                  chapter: r.chId,
                  entity: entId,
                  severity: 'info',
                  confidence: 0.6,
                  evidence: { basis: [`上次记录于第 ${lastN} 章`, `第 ${lastN + 1}-${r.n - 1} 章缺席`, `本章重现`] },
                  message: `物品「${item}」连续缺席后，在第 ${r.n} 章重新出现在持有物中。`,
                  suggestion: '若物品一直在身边，请补记中间章节的状态矩阵；若确已失去，补写重新获得的情节，或删除本条重现记录。',
                }));
              }
              lastSeen.set(item, r.n);
              gapped.delete(item);
            }
            for (const item of lastSeen.keys()) {
              if (!cur.has(item)) gapped.add(item);
            }
          }
        }
        return out;
      },
    },
  'relation-contradiction': {
    code: 'R19',
    defaultSeverity: 'warn',
    scope: 'book',
    summary: '称谓与登记关系不符，或同一对角色的关系边互相矛盾。',
    detail:
      '以 relations.edges 为准：①同一对实体存在两条 kind 不同的边 → warn（双向矛盾）；' +
      '②登记了 address 的边，正文出现其他强称谓词且客体名字在场 → 提示人工复核' +
      '（可能是口癖/反讽设计，所以保留 confidence 0.5）。关系是作者登记的结构化事实，' +
      '判断不经过模型与词频统计，属机器规则；但称谓设计空间大，故默认 warn 不作 error。',
    run(ctx) {
      const out = [];
      const edges = (ctx.relations?.edges || []).filter((e) => e && e.from && e.to && e.kind);
      if (!edges.length) return out;
      // ① 双向一致性
      const pairKey = (x, y) => [x, y].sort().join('|');
      const pairs = new Map();
      for (const e of edges) {
        const k = pairKey(e.from, e.to);
        if (!pairs.has(k)) pairs.set(k, []);
        pairs.get(k).push(e);
      }
      for (const [k, group] of pairs) {
        if (group.length < 2) continue;
        const kinds = new Set(group.map((e) => e.kind));
        if (kinds.size > 1) {
          out.push(diag('relation-contradiction', {
            entity: k,
            severity: 'warn',
            evidence: { basis: group.map((e) => e.from + '→' + e.to + ': ' + e.kind) },
            message: '同一对角色登记了互相矛盾的关系：' + [...kinds].join(' / ') + '。',
            suggestion: '确认哪条是对的：修正另一条，或给其中一条加 until 表示关系已变化。',
          }));
        }
      }
      // ② 称谓检查:仅对登记了 address 的边做正文比对
      const byId = new Map(ctx.characters.map((c) => [c.id, c]));
      for (const e of edges) {
        if (!e.address) continue;
        const from = byId.get(e.from), to = byId.get(e.to);
        if (!from || !to) continue;
        for (const ch of ctx.chapters) {
          if (isExempt(ch)) continue;
          const body = ch.body || '';
          if (!body.includes(from.name) || !body.includes(to.name)) continue;
          if (body.includes(e.address)) continue;
          const OTHER = /哥哥|姐姐|师父|师傅|师尊|老爷|大人|兄弟|姐妹|叔|伯|婶|姨|徒儿|徒弟/;
          if (OTHER.test(body)) {
            out.push(diag('relation-contradiction', {
              chapter: ch.id,
              entity: e.from + '|' + e.to,
              severity: 'warn',
              confidence: 0.5,
              evidence: { basis: ['登记称谓「' + e.address + '」', '正文出现其他称谓词'] },
              message: ch.id + ' 中 ' + from.name + ' 对 ' + to.name + ' 的称呼可能与登记关系「' + e.kind + '（' + e.address + '）」不符。',
              suggestion: '若为口癖/反讽设计，可忽略或豁免本条指纹；否则改称呼或修正关系登记。',
            }));
          }
        }
      }
      return out;
    },
  },

    'premature-reveal': {
      code: 'R20',
      defaultSeverity: 'error',
      scope: 'chapter',
      summary: '信息差账本里登记的秘密，在计划揭示章之前就被正文点破了。',
      detail:
        '逐条检查启用的登记：以 revealed_at（已回填的实际揭示章）优先、否则 reveal_chapter（排期章）' +
        '为揭示基线，在基线之前的章节正文里字面检索 term，命中即 error。' +
        '误报控制三道：①flashback/dream/quoted/offscreen 标记章整章豁免（与 R1 同一套标记）；' +
        '②作者登记过 first_chapter（允许开始铺垫的章）且命中章不早于它 → 降为 info；' +
        '③既无排期也没回填时不猜剧透，只报 warn 催登记。引用了不存在的章 id 直接跳过，那是 R15 的活。',
      run(ctx) {
        const out = [];
        for (const s of ctx.secrets || []) {
          if (s.enabled === false) continue;
          const term = String(s.term || '').trim();
          if (!term) continue;
          const planId = s.revealed_at || s.reveal_chapter;
          const planN = planId ? ctx.chapterNumbers.get(planId) : null;
          if (planId && planN == null) continue;
          const first = firstAppearance(ctx, term);
          if (!first) continue;
          if (planN == null) {
            out.push(diag('premature-reveal', {
              chapter: first.chapter,
              entity: s.id,
              severity: 'warn',
              evidence: { quote: first.quote, basis: [`term「${term}」首现于第 ${first.n} 章`, '这条登记没有揭示章'] },
              message: `信息差「${term}」已在第 ${first.n} 章出现，但这条登记没写揭示排期。`,
              suggestion: '补 reveal_chapter（计划）或 revealed_at（已揭示的实际章节），否则无从判断是否提前。',
            }));
            continue;
          }
          if (first.n >= planN) continue;
          const sanctioned = s.first_chapter ? ctx.chapterNumbers.get(s.first_chapter) : null;
          const allowed = sanctioned != null && first.n >= sanctioned;
          const basis = [`term「${term}」首现于第 ${first.n} 章`, `揭示基线 ${planId}（第 ${planN} 章）`];
          if (sanctioned != null) basis.push(`first_chapter 第 ${sanctioned} 章`);
          out.push(diag('premature-reveal', {
            chapter: first.chapter,
            entity: s.id,
            severity: allowed ? 'info' : 'error',
            evidence: { quote: first.quote, basis },
            message: `信息差「${term}」在第 ${first.n} 章就被点破，揭示排期在第 ${planN} 章。`,
            suggestion: allowed
              ? '与登记的铺垫起点一致：确认这是有意的，或把揭示章改到实际点破的这一章。'
              : '把这段改成不点破的写法，或把揭示排期提前；确属有意铺垫就登记 first_chapter。',
          }));
        }
        return out;
      },
    },

    'unresolved-secret': {
      code: 'R21',
      defaultSeverity: 'warn',
      scope: 'book',
      summary: '排了期的揭示章已经过去，这条信息在正文里从未出现。',
      detail:
        '启用的登记设了 reveal_chapter、没回填 revealed_at，最新章号已超过排期章，而 term 在全部' +
        '正文里一次都没出现过 → warn。漏写揭示、或揭示时换了别的说法（登记的 term 与正文用词不符）' +
        '都会命中，具体是哪种由作者判断。正文里出现过就不报 —— 那属于 R20 的范围。',
      run(ctx) {
        const out = [];
        const last = ctx.chapters.reduce((m, c) => Math.max(m, c.number || 0), 0);
        for (const s of ctx.secrets || []) {
          if (s.enabled === false) continue;
          const term = String(s.term || '').trim();
          if (!term || !s.reveal_chapter || s.revealed_at) continue;
          const n = ctx.chapterNumbers.get(s.reveal_chapter);
          if (n == null || last <= n) continue;
          if (firstAppearance(ctx, term)) continue;
          out.push(diag('unresolved-secret', {
            entity: s.id,
            severity: 'warn',
            evidence: { basis: [`排期 ${s.reveal_chapter}（第 ${n} 章）`, `已写到第 ${last} 章`, `「${term}」在正文里从未出现`] },
            message: `信息差「${term}」排在第 ${n} 章揭示，但到第 ${last} 章正文里从没出现过，revealed_at 也仍为空。`,
            suggestion: '补写揭示并回填 revealed_at；若已经用别的说法揭过，把 term 改成读者实际看到的那个词。',
          }));
        }
        return out;
      },
    },

    'ai-flavor': {
      code: 'R22',
      defaultSeverity: 'warn',
      scope: 'chapter',
      summary: '本章的 AI 腔禁词密度或句式套路过高（去 AI 味规则包）。',
      detail:
        '判据全部来自 NWStylePack 的统计，不做主观评价：禁词按每千字命中数算，句式只数那五条' +
        '（同开头连击、连续无对话段、二元对照句、三短句连击、破折号插入语）。密度 ≥3/千字 或 句式套路 ≥2 类为 warn，' +
        '低一档为 info；正文不足 500 字不评。作者可在本书的 stylePack 里关掉整组或加自己的禁词。' +
        '本条是文笔提示，不是事实矛盾：误报了关掉那组即可，不要拿它当门禁。',
      run(ctx) {
        const out = [];
        const opts = StylePack.optsFrom(ctx.book);
        for (const ch of ctx.chapters) {
          const body = (ch.body || '').trim();
          if (!body) continue;
          const r = StylePack.lint(body, opts);
          const v = StylePack.verdict(r);
          if (!v.severity) continue;
          const tally = new Map();
          for (const b of r.banned) tally.set(b.term, (tally.get(b.term) || 0) + 1);
          const hits = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
            .slice(0, 6).map(([term, n]) => `${term}×${n}`);
          const first = r.banned[0] ? r.banned[0].quote : (r.patterns[0]?.samples || [''])[0];
          out.push(diag('ai-flavor', {
            chapter: ch.id,
            severity: v.severity,
            confidence: 0.6,
            evidence: {
              basis: [...v.reasons, ...(hits.length ? [`高频：${hits.join('、')}`] : [])],
              quote: first,
              per1000: r.per1000,
              patterns: r.patterns.map((p) => ({ id: p.id, count: p.count })),
            },
            message: `${ch.id} 的 AI 味偏高：每千字 ${r.per1000} 处禁词，${r.patterns.length} 类句式套路。`,
            suggestion: '把心理名词换成动作、删掉喻体直接写下一件事、段尾收在台词或动作上；' +
              '确属本书用词习惯的，可在侧栏「文体规则」里关掉对应词组，或豁免本章。',
          }));
        }
        return out;
      },
    },

    'dialogue-ratio': {
      code: 'R23',
      defaultSeverity: 'info',
      scope: 'chapter',
      summary: '整章几乎没有人开口，或有一大段连续纯叙述没有一句台词。',
      detail:
        '对话字数按成对引号（“”/「」/『』）内的正文计，占比 = 对话字数 / 全章字数；' +
        '另一路判据是最长纯叙述连段（按段落累计，跨段不清零）。占比低于配额或连段超阈值才报。' +
        '正文不足门槛字数的章、带 flashback/dream/quoted/offscreen 标记的章不评。' +
        '恒为 info：整章没台词可能是战斗、可能是独角戏，让自修补写轮去凑对话只会塞出假台词。' +
        '一处漏掉的后引号会让它后面的叙述被当成对话，方向是少报不是多报。',
      run(ctx) {
        const out = [];
        const q = Tension.quotaFor(ctx.book);
        for (const ch of ctx.chapters) {
          const body = (ch.body || '').trim();
          if (!body || isExempt(ch)) continue;
          const s = Tension.stats(body);
          if (s.words < q.minWords) continue;
          const dry = s.ratio < q.ratioLow;
          const longRun = s.plainRuns.words >= q.plainInfo;
          if (!dry && !longRun) continue;
          const basis = [];
          if (dry) basis.push(`对话占比 ${(s.ratio * 100).toFixed(0)}%（配额 ${Math.round(q.ratioLow * 100)}%）`);
          if (longRun) basis.push(`最长 ${s.plainRuns.words} 字连续纯叙述（阈值 ${q.plainInfo}）`);
          out.push(diag('dialogue-ratio', {
            chapter: ch.id,
            severity: 'info',
            confidence: 0.6,
            evidence: { basis: [`全章 ${s.words} 字`, ...basis], quote: s.sample, ratio: s.ratio, plainRun: s.plainRuns.words },
            message: dry
              ? `${ch.id} 全章 ${s.words} 字，对话只占 ${(s.ratio * 100).toFixed(0)}%。`
              : `${ch.id} 有连续 ${s.plainRuns.words} 字没有一句台词。`,
            suggestion: dry
              ? '把一段说明改成两个人各执一词：立场不同的角色开口，比叙述更能把信息递到读者手里。'
              : '连着几百字都是叙述时，让一个人打断另一个人，或者把这段说明压进一句台词里。',
          }));
        }
        return out;
      },
    },

    'chapter-no-change': {
      code: 'R24',
      defaultSeverity: 'info',
      scope: 'chapter',
      summary: '本章在账本上没有任何变化点：没埋伏笔、没收伏笔、状态没动、信息没揭。',
      detail:
        '只看作者登记得了的事实：①伏笔表里 setup/payoff 指向本章；②状态矩阵里本章某实体相对' +
        '它上一次记录的维度有变（首次记录不算变化，那多半是补账）；③信息差账本的揭示章落在本章。' +
        '三者皆无才报。**全书一条登记都没有时整条规则闭嘴** —— 惩罚不记账的作者只会换来关检查器。' +
        '恒为 info：没登记不等于没发生，这规则查的是账本漏记与平章同一种形状，处置权在作者。',
      run(ctx) {
        const items = ctx.promises?.items || [];
        const byChapter = ctx.states?.byChapter || {};
        const secrets = (ctx.secrets || []).filter((s) => s.enabled !== false);
        if (!items.length && !Object.keys(byChapter).length && !secrets.length) return [];
        const q = Tension.quotaFor(ctx.book);
        const sorted = [...ctx.chapters].sort((a, b) => (a.number || 0) - (b.number || 0));
        const prevDims = new Map();
        const flat = [];
        const flatByNumber = new Set();
        for (const ch of sorted) {
          const body = (ch.body || '').trim();
          if (!body || T.countWords(body) < q.minBody) continue;
          const setups = items.filter((i) => i.type === 'promise' && i.status !== 'cancelled' && i.setup?.chapter === ch.id);
          const payoffs = items.filter((i) => i.type === 'promise' && i.payoff?.chapter === ch.id);
          const reveals = secrets.filter((s) => s.revealed_at === ch.id || s.reveal_chapter === ch.id);
          let stateMoves = 0;
          for (const [ent, dims] of Object.entries(byChapter[ch.id] || {})) {
            const before = prevDims.get(ent);
            if (before && dimsChanged(before, dims)) stateMoves += 1;
            prevDims.set(ent, dims);
          }
          if (setups.length || payoffs.length || reveals.length || stateMoves) continue;
          flat.push({ ch, backToBack: flatByNumber.has((ch.number || 0) - 1) });
          flatByNumber.add(ch.number || 0);
        }
        return flat.map(({ ch, backToBack }) => diag('chapter-no-change', {
          chapter: ch.id,
          severity: 'info',
          confidence: 0.5,
          evidence: { basis: ['伏笔表无 setup/payoff 指向本章', '状态矩阵本章无维度变化', '信息差账本本章无揭示'] },
          message: `${ch.id} 在账本上是一个平章：没有任何登记在册的变化。${backToBack ? '上一章同样如此。' : ''}`,
          suggestion: backToBack
            ? '连着两章什么都没改变，读者就没有翻页的理由了：本章确实推进了什么就去补登记，否则把它并进前后章。'
            : '若本章确实推进了剧情，去伏笔表／状态矩阵／信息差账本补一条；若它是过渡章，忽略即可。',
        }));
      },
    },

    'same-hook-streak': {
      code: 'R25',
      defaultSeverity: 'info',
      scope: 'book',
      summary: '连续几章用同一种结尾钩子（每章都是问句收尾，或每章都是突转收尾）。',
      detail:
        '只认两类判据确凿的钩子：结尾窗口内有问号 = 问句收尾，命中突转词表 = 突转收尾，其余不分类。' +
        '同一类连续达到配额章数才报，一段只报一条，落在这段的首章上（这样 --from/--to 能筛到）。' +
        '恒为 info：钩子写得好不好机器看不出来，这规则说的是「连着三章用同一个动作」。',
      run(ctx) {
        const q = Tension.quotaFor(ctx.book);
        const sorted = [...ctx.chapters]
          .filter((ch) => !isExempt(ch) && T.countWords((ch.body || '').trim()) >= q.minBody)
          .sort((a, b) => (a.number || 0) - (b.number || 0));
        const out = [];
        let streak = [];
        const flush = () => {
          if (streak.length >= q.hookRun) {
            const kind = streak[0].kind;
            const first = streak[0].ch, last = streak[streak.length - 1].ch;
            out.push(diag('same-hook-streak', {
              chapter: first.id,
              entity: kind,
              severity: 'info',
              confidence: 0.6,
              evidence: {
                basis: [`连续 ${streak.length} 章`, `第 ${first.number}–${last.number} 章`, `同类钩子：${Tension.HOOK_LABEL[kind]}`],
                quote: Tension.tailOf(last.body).slice(-40),
              },
              message: `第 ${first.number}–${last.number} 章连续 ${streak.length} 章都是${Tension.HOOK_LABEL[kind]}。`,
              suggestion: '换一种收尾：上一章留问句，这一章就把问题答在一个动作上。同质钩子的代价是读者学会忽略它。',
            }));
          }
          streak = [];
        };
        for (const ch of sorted) {
          const kind = Tension.hookKind(Tension.tailOf(ch.body));
          if (kind && (!streak.length || streak[0].kind === kind)) streak.push({ ch, kind });
          else { flush(); if (kind) streak.push({ ch, kind }); }
        }
        flush();
        return out;
      },
    },

    'repeated-sentence': {
      code: 'R26',
      defaultSeverity: 'info',
      scope: 'book',
      summary: '同一个长句被逐字写了两遍：本章内重复，或后面的章节原样复述上一章的句子。',
      detail:
        '句子取自 NWStylePack 的切分器（与 R22 同一份），去掉标点空白后 ≥18 字才参与比对，' +
        '短句、称呼、成语不算。含开引号的片段一律不参与 —— 切分器不认引号（它在引号内的句号上' +
        '也会断句），所以台词可能带着「她说：」这个前缀，只能按"含有引号"判；台词重复多半是有意的' +
        '复沓，机器分不开「口头禅」与「回声」，宁可少报。带 flashback/dream/quoted/offscreen ' +
        '标记的章整章不参与：' +
        '回忆章本来就该重演旧场景。同章内重复为 warn（到这一步几乎只能是粘贴或模型回声），' +
        '跨章重复为 info；同一句在 ≥3 章重复时只报一条，并按「固定用语」的说法写。',
      run(ctx) {
        const MIN = 18;
        const groups = new Map();
        const sorted = [...ctx.chapters].sort((a, b) => (a.number || 0) - (b.number || 0));
        for (const ch of sorted) {
          if (isExempt(ch)) continue;
          for (const para of StylePack.paragraphs(ch.body || '')) {
            for (const s of StylePack.sentences(para)) {
              if (/[「『“]/.test(s.text)) continue;
              const key = normText(s.text);
              if (key.length < MIN) continue;
              let g = groups.get(key);
              if (!g) { g = { text: s.text, hits: [] }; groups.set(key, g); }
              g.hits.push({ ch, start: s.start });
            }
          }
        }
        const out = [];
        for (const [key, g] of groups) {
          if (g.hits.length < 2) continue;
          const ids = T.uniq(g.hits.map((h) => h.ch.id));
          const first = g.hits[0], second = g.hits[1];
          const same = ids.length === 1;
          const clip = g.text.length > 40 ? `${g.text.slice(0, 40)}……` : g.text;
          const chapters = g.hits.map((h) => h.ch.number);
          const where = [...new Set(chapters)].slice(0, 4).join('、');
          out.push(diag('repeated-sentence', {
            chapter: second.ch.id,
            entity: key.slice(0, 16),
            severity: same ? 'warn' : 'info',
            confidence: same ? 0.8 : 0.6,
            evidence: {
              basis: same
                ? [`本章内原样出现 ${g.hits.length} 次`]
                : [`首现第 ${first.ch.number} 章`, `又在第 ${second.ch.number} 章原样出现`,
                  ...(ids.length >= 3 ? [`共 ${ids.length} 章：第 ${where} 章`] : [])],
              quote: clip,
              offset: [second.start, second.start + g.text.length],
            },
            message: same
              ? `第 ${second.ch.number} 章里这一句原样出现了 ${g.hits.length} 次：「${clip}」`
              : ids.length >= 3
                ? `「${clip}」在第 ${where} 等 ${ids.length} 个章节里一字不差地重复。`
                : `第 ${first.ch.number} 章写过的这一句，在第 ${second.ch.number} 章一字不差地又出现了一次：「${clip}」`,
            suggestion: same
              ? '删掉多余的那一份，或把第二次出现换个说法 —— 同一章里重复整句基本是粘贴或改写时没删干净。'
              : '承接上一章请用自己的话重述；若这是固定的系统提示语或人物口头禅，豁免这一条即可。',
          }));
        }
        return out;
      },
    },

    'evidence-mismatch': {
      code: 'R27',
      defaultSeverity: 'info',
      scope: 'book',
      summary: '伏笔登记的「原文依据」在它标的那一章正文里找不到。',
      detail:
        '把 setup.evidence 归一化（去标点空白）后在 setup.chapter 的正文里字面找。找不到再扫全书：' +
        '在别的章找得到 → 依据没记错、章标错了；全书都没有 → 这句多半被后来的改写冲掉了。' +
        '不查这些情形：依据不足 8 字（太短，找不到也不说明问题）、那一章还没写正文、' +
        '章 id 不存在（那是 R15 的活）、已作废的登记。' +
        '恒为 info：账本与正文对不上是真问题，但「凭记忆摘了一句」也长这样，不该替作者断定。',
      run(ctx) {
        const items = (ctx.promises?.items || [])
          .filter((i) => i.type === 'promise' && i.status !== 'cancelled');
        const bodies = ctx.chapters.map((ch) => ({ ch, norm: normText(ch.body || '') }));
        const out = [];
        for (const p of items) {
          const ev = String(p.setup?.evidence || '').trim();
          const chId = p.setup?.chapter;
          if (!ev || !chId) continue;
          const key = normText(ev);
          if (key.length < 8) continue;
          const target = bodies.find((b) => b.ch.id === chId);
          if (!target || !target.norm) continue;      // 章不存在或还没写正文
          if (target.norm.includes(key)) continue;
          const hit = bodies.find((b) => b.ch.id !== chId && b.norm.includes(key));
          const clip = ev.length > 40 ? `${ev.slice(0, 40)}……` : ev;
          out.push(diag('evidence-mismatch', {
            chapter: hit ? hit.ch.id : chId,
            entity: p.id,
            severity: 'info',
            confidence: 0.7,
            evidence: {
              basis: hit
                ? [`登记的埋设章：第 ${target.ch.number} 章`, `实际找得到：第 ${hit.ch.number} 章`]
                : [`登记的埋设章：第 ${target.ch.number} 章`, '全书正文里都没有这句'],
              quote: clip,
            },
            message: hit
              ? `伏笔「${p.title}」的原文依据不在第 ${target.ch.number} 章，倒是在第 ${hit.ch.number} 章里找得到。`
              : `伏笔「${p.title}」登记的原文依据在第 ${target.ch.number} 章正文里找不到，全书也没有。`,
            suggestion: hit
              ? `把 setup.chapter 改成第 ${hit.ch.number} 章，或换成第 ${target.ch.number} 章里真正埋它的那句。`
              : '多半是改正文时把这句删了：重新贴一句现在还在正文里的依据 —— 将来判有没有回收（R3/R3b）全靠它。',
          }));
        }
        return out;
      },
    },

    'world-destroyed-after': {
      code: 'R28',
      defaultSeverity: 'info',
      scope: 'book',
      summary: '设定在它登记「毁灭于」的那一章之后，还被正文原样点名。',
      detail:
        '只读 lifecycle["destroyed-in"]：这个字段由 nw-changes 的 world.destroy 算子写入，' +
        '导出导入一路带着走，此前没有任何规则读它 —— 记了不查等于没记。' +
        '取条目本名与 keys 里 ≥2 字的称呼，在销毁章**之后**的正文字面检索，一条设定只报最早撞见的那一章，' +
        '带 flashback/dream/quoted/offscreen 标记的章跳过。' +
        '恒为 info：写废墟、旧地重提与忘了它已经毁掉，机器分不开。' +
        'lifecycle["revealed-in"] 不查 —— 它没有任何生产者，而世界条目的名字天然早于正式解释出现，' +
        '这条判据按构造就是噪声。',
      run(ctx) {
        const out = [];
        const sorted = [...ctx.chapters].sort((a, b) => (a.number || 0) - (b.number || 0));
        for (const w of ctx.world || []) {
          if (w.enabled === false) continue;
          const deadId = w.lifecycle?.['destroyed-in'];
          if (!deadId) continue;
          const deadN = ctx.chapterNumbers.get(deadId);
          if (deadN == null) continue;                 // 引了不存在的章：R15 的活
          const terms = T.uniq([w.name, ...(w.keys || [])]
            .filter((t) => typeof t === 'string' && t.trim().length >= 2)
            .map((t) => t.trim()));
          if (!terms.length) continue;
          for (const ch of sorted) {
            if (isExempt(ch) || !Number.isFinite(ch.number) || ch.number <= deadN) continue;
            const body = ch.body || '';
            let at = null, term = '';
            for (const t of terms) {
              const i = occurrences(body, t)[0];
              if (i != null && (at == null || i < at)) { at = i; term = t; }
            }
            if (at == null) continue;
            out.push(diag('world-destroyed-after', {
              chapter: ch.id,
              entity: w.id,
              severity: 'info',
              confidence: 0.6,
              evidence: {
                basis: [`「${term}」首现于销毁之后`, `destroyed-in=${deadId}（第 ${deadN} 章）`, `本条只在第 ${ch.number} 章报一次`],
                ...quoteAt(body, at, term.length),
              },
              message: `设定「${w.name}」登记在第 ${deadN} 章毁灭，第 ${ch.number} 章的正文又把它当作还在的东西点了名。`,
              suggestion: '若写的是废墟、遗迹或旧事重提，忽略或豁免本章即可；若是忘了它已经毁掉，把这句改成毁灭之后的说法。',
            }));
            break;
          }
        }
        return out;
      },
    },

  };


  // ═══════════════════ 执行 ═══════════════════

  /** schema 校验单独跑；一旦失败就让其余规则全停，避免派生出几十条假诊断。 */
  function runSchemaRules(ctx) {
    if (!ctx.schema || !Bible) return { ok: true, diags: [] };
    const diags = [];
    const check = (kind, value, at) => {
      const def = ctx.schema.$defs?.[kind];
      if (!def) return;
      for (const e of Bible.validate(def, value, ctx.schema)) {
        diags.push(diag('schema-invalid', {
          chapter: at?.chapter || null,
          entity: at?.entity || value?.id || null,
          message: `${kind} ${e.path}: ${e.message}`,
          evidence: { basis: [`${e.keyword}@${e.path}`] },
          suggestion: '按 schemas/story-bible.v1.json 修正该字段。',
        }));
      }
    };
    check('book', ctx.book, {});
    for (const ch of ctx.chapters || []) check('chapter', ch.meta || ch, { chapter: ch.id });
    for (const c of ctx.characters || []) check('character', c, { entity: c.id });
    for (const w of ctx.world || []) check('worldEntry', w, { entity: w.id });
    if (ctx.promises) check('promises', ctx.promises, {});
    if (ctx.states) check('states', ctx.states, {});
    if (ctx.timeline) check('timeline', ctx.timeline, {});
    if (ctx.lexicon) check('lexicon', ctx.lexicon, {});
    return { ok: diags.length === 0, diags };
  }

  function prepare(ctx) {
    const c = { ...ctx };
    c.chapters = (c.chapters || []).map((ch) => ({
      flags: [], characters: [], mentions: [], locations: [], ...ch,
    }));
    c.characters = c.characters || [];
    c.world = c.world || [];
    c.promises = c.promises || { items: [] };
    c.states = c.states || { byChapter: {} };
    c.timeline = c.timeline || { anchors: [], backstory: [] };
    c.lexicon = c.lexicon || { names: {} };
    c.secrets = c.secrets || [];
    c.chapterNumbers = chapterNumberMap(c);
    return c;
  }

  /**
   * @param ctx 装配好的书（见 scripts/lib/book.mjs 的 loadBook）
   * @param opts { only, from, to, suppressions, source }
   */
  function runRules(rawCtx, opts = {}) {
    const ctx = prepare(rawCtx);
    const suppressions = new Map(
      ((opts.suppressions || rawCtx.suppressions || {}).items || []).map((s) => [s.fingerprint, s]),
    );

    const schemaResult = runSchemaRules(ctx);
    if (!schemaResult.ok) {
      // 结构都不对，继续跑别的规则只会产出假诊断
      return schemaResult.diags.map((d) => applySuppression(d, suppressions));
    }

    let chapters = ctx.chapters;
    const fromN = opts.from ? ctx.chapterNumbers.get(opts.from) : null;
    const toN = opts.to ? ctx.chapterNumbers.get(opts.to) : null;
    const scoped = (d) => {
      if (!d.chapter) return true;
      const n = ctx.chapterNumbers.get(d.chapter);
      if (n == null) return true;
      if (fromN != null && n < fromN) return false;
      if (toN != null && n > toN) return false;
      return true;
    };

    let out = [];
    for (const [name, rule] of Object.entries(RULES)) {
      if (opts.only && !opts.only.includes(name)) continue;
      let hits = [];
      try {
        hits = rule.run(ctx) || [];
      } catch (e) {
        hits = [diag('rule-crashed', {
          severity: 'warn',
          message: `规则 ${name} 执行异常：${e.message}`,
          evidence: { basis: [name] },
          suggestion: '这是引擎自身的缺陷，请把这条报告反馈出来。',
        })];
      }
      out.push(...hits);
    }
    out = out.filter(scoped).map((d) => applySuppression(d, suppressions));
    return out.sort((a, b) => rank(a) - rank(b) || String(a.chapter).localeCompare(String(b.chapter)) || a.rule.localeCompare(b.rule));
  }

  function applySuppression(d, suppressions) {
    const s = suppressions.get(d.fingerprint);
    return s ? { ...d, suppressedBy: s.reason || 'author', confidence: d.confidence } : d;
  }

  function rank(d) {
    return { error: 0, warn: 1, info: 2 }[d.severity] ?? 3;
  }

  function summarize(diags) {
    const s = { error: 0, warn: 0, info: 0, suppressed: 0, machine: 0, llm: 0 };
    for (const d of diags) {
      if (d.suppressedBy) s.suppressed++;
      s[d.severity] = (s[d.severity] || 0) + 1;
      s[d.source] = (s[d.source] || 0) + 1;
    }
    return s;
  }

  return {
    ENGINE_VERSION,
    RULES,
    ACTION_RE,
    RECALL_RE,
    runRules,
    runSchemaRules,
    summarize,
    diag,
    occurrences,
    nameForms,
    entityCandidates,
  };
});
