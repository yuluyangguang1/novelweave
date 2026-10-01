/**
 * NovelWeave · 织文 — 工作流预设（UMD：浏览器与 Node 共用）
 *
 * roadmap 从 P1-2 起就写着「工作流 / 模板分享」，而盘上一直没有它：作者把一本书的
 * 篇幅档、字数目标、去 AI 味八组的开关调顺了，开第二本书时得从头再调一遍，
 * 而且**调完对不对没人能核对** —— 那几格散在两个向导和「文体规则」页里。
 *
 * 这一份只回答三件事，别处一律改问它：
 * 1. **什么才算工作流**：FIELDS 那三格。书名、类型、简介是这一本的书，不是工作方式，
 *    不进预设。基准章（那格记的是本书若干章的身份证）也不进 —— 换一本书那些 id 就
 *    指向不存在的东西，它是身份不是设置（见 NOT_SHARED，界面上不许自己拼这句话）。
 * 2. **一份外来预设到底能信到哪一步**：认不出的键、认不出的禁词组、长篇配字数目标
 *    这三类各归各的说法，**一条都不许悄悄丢掉**。悄悄丢掉就是「分享者关掉了两组禁词，
 *    接收者的正文里那两组还在生效，而两个人都以为已经生效了」—— 本项目反复犯的病。
 * 3. **应用到这本书会改哪几格**：逐格「现在 / 预设 / 会不会变」由这里算，
 *    界面只负责画它给的行，不许自己比第二遍。
 *
 * 刻意不做的事：不做「预设里带 prompt 文本」（界面上填不出、导出不往返的东西不算设置，
 * 见 src/core/llm.js 那几句是写死的）；不做云端与链接分享（这站的存储由作者自己带）；
 * 不自动应用 —— 预设必须经过那一张逐格 diff 的确认框才写库。
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWStylePack, root.NWTension);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWWorkflow = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, SP, Tension) {
  'use strict';

  const WORKFLOW_VERSION = '1.0.0';
  const KIND = 'novelweave.workflow';
  /** 文件里的格式号。与 WORKFLOW_VERSION 分两家：模块改实现不必升格式，
   *  格式升了旧文件必须被认出来（不猜），而不是按新字段校验一遍再应用半套。 */
  const FILE_VERSION = 1;

  /** 可分享的三格 —— 这份清单是唯一出处：写预设、读预设、画 diff、schema 都问它。 */
  const FIELDS = ['format', 'target_words', 'stylePack'];

  /** 明确不进预设的那几格，连同「为什么不进」的一句话。界面与文档都引这里，不许各写一遍。 */
  const NOT_SHARED = [
    { key: 'styleAnchor', why: '它记的是这本书里若干章的身份证，换一本书那些 id 就指不到东西 —— 那是身份，不是设置' },
    { key: 'title / genre / description', why: '这一本是什么书，不是怎么写书' },
  ];

  /**
   * 篇幅档只有这两个值 —— **不在这里定**：出处是 `NWTension.FORMATS`。
   * 这里是别名（同一个数组，不是复制），因为建书弹窗的下拉、两份 schema 的 enum、
   * 预设过闸那一句「篇幅档只认 …」都要对着同一份清单核（见 tests/guards 那三条）。
   */
  const FORMATS = Tension.FORMATS;
  const formatLabel = Tension.formatLabel;

  /**
   * 字数目标的上下限。**不在这里定**：出处是 `NWTension.TARGET_MIN` / `TARGET_MAX`
   * （那两份又对着 schemas 的 `target_words.minimum` / `maximum` 核）。这里是别名，
   * 因为打包、过闸、逐格 diff 与 CLI 那句说明都要念同一对数 —— 抄一份就意味着
   * core 改了界而预设那边还在按旧的拦。
   */
  const TARGET_MIN = Tension.TARGET_MIN;
  const TARGET_MAX = Tension.TARGET_MAX;

  const FIELD_LABEL = {
    format: '篇幅档',
    target_words: '全篇字数目标',
    stylePack: '去 AI 味规则包',
  };

  /** 一格里能出现的规则包子键，同样只在这里数一遍。 */
  const PACK_KEYS = ['enabled', 'disabled', 'extraBanned'];

  /**
   * 「长篇没有字数目标这一格」那句说法的唯一出处。过闸要说它（长篇配目标是坏搭配），
   * 逐格 diff 也要说它（一本长篇收到只带目标的预设，那一格落不下），两处必须是同一句 ——
   * 否则一处拦、一处照写：那一格写进了库，进度条不显示、打包也带不出来，
   * 而评分卡还在按它算分。作者看见的是「（这一格没设）」，实际吃到的却是那个数。
   */
  const LONG_NO_TARGET = '长篇没有字数目标这一格（建档那一路把它留空），要设目标得把篇幅档一起换成短篇';

  /** 反方向那一格的说法：不另写一句，还是上面那一条判据，只是这次库里那个数要清走。 */
  const CLEAR_NO_TARGET = `（清掉）${LONG_NO_TARGET}`;

  function groupIds() {
    return ((SP && SP.GROUPS) || []).map((g) => g.id);
  }

  /** 一组的开关状态收成一句人话（「八组全开」/「关掉 2 组：段尾金句、抽象概括」）。 */
  function packSummary(opts) {
    const o = opts || {};
    if (o.enabled === false) return '整包关掉（生成时不提去 AI 味）';
    const disabled = (o.disabled || []).map((id) => {
      const meta = SP && SP.groupMeta ? SP.groupMeta(id) : null;
      return meta ? meta.label : id;
    });
    const extra = (o.extraBanned || []).length;
    const bits = [];
    bits.push(disabled.length ? `关掉 ${disabled.length} 组：${disabled.join('、')}` : `${groupIds().length} 组全开`);
    if (extra) bits.push(`自添 ${extra} 个禁词`);
    return bits.join(' · ');
  }

  /** 任何来源的 stylePack（库行里的、预设里的）都先过这一道，出来永远是完整三键。 */
  function normalizePack(input) {
    const sp = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    const disabled = Array.isArray(sp.disabled) ? sp.disabled.filter((id) => typeof id === 'string') : [];
    const extra = Array.isArray(sp.extraBanned)
      ? [...new Set(sp.extraBanned.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))]
      : [];
    return { enabled: sp.enabled !== false, disabled: [...new Set(disabled)], extraBanned: extra };
  }

  /** 从一本书的库行打包成预设。写预设只走这里 —— 界面不许自己挑字段。 */
  function pack(book, { name, note } = {}) {
    const b = book || {};
    const fields = { format: Tension.fmtOf(b) };
    // 带不带这一格，问的是 core 那一句「这一档有没有字数目标」：长篇库里那个遗留数
    // 不该被打包成「这份预设要的目标」，而一个低于下限的数在库里本来就不算设过。
    const target = Tension.targetOf(b);
    if (target !== null) fields.target_words = target;
    fields.stylePack = normalizePack(SP && SP.optsFrom ? SP.optsFrom(b) : {});
    return {
      kind: KIND,
      version: FILE_VERSION,
      name: String(name || b.title || '未命名工作流'),
      note: String(note || ''),
      fields,
    };
  }

  /**
   * 外来预设过闸：分成「能用」「认不出」「不合理」三堆，每堆都要能说出口。
   * 键不认识 → unknown（不应用、但报数）；值不合理 → bad（连原因一起报）。
   * 单格坏了不连累整份：其余格照样能应用，因为确认框会逐格显示这一格为什么没进去。
   */
  function normalize(input) {
    const out = { ok: false, name: '', note: '', fields: {}, unknown: [], bad: [], errors: [] };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      out.errors.push('不是预设文件：顶层得是一个对象');
      return out;
    }
    if (input.kind !== KIND) {
      out.errors.push(`不是织文的工作流预设（kind 是「${String(input.kind ?? '（没有）')}」）`);
      return out;
    }
    if (Number(input.version) !== FILE_VERSION) {
      out.errors.push(`这份预设是第 ${String(input.version ?? '?')} 号格式，这个程序只认第 ${FILE_VERSION} 号 —— 不猜怎么读它`);
      return out;
    }
    out.name = String(input.name || '未命名工作流');
    out.note = String(input.note || '');
    const src = (input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)) ? input.fields : {};
    for (const key of Object.keys(src)) {
      if (!FIELDS.includes(key)) {
        out.unknown.push(key);
        continue;
      }
      if (key === 'format') {
        if (!FORMATS.includes(src.format)) {
          out.bad.push({ key, reason: `篇幅档只认 ${FORMATS.join(' 或 ')}，这份写的是「${String(src.format)}」` });
          continue;
        }
        out.fields.format = src.format;
      } else if (key === 'target_words') {
        // 「这个数算不算一个字数目标」与打包、建档问的是同一句（连布尔与对象不许混进来那条）
        const raw = src.target_words;
        const n = Tension.targetValue(raw);
        if (n === null) {
          out.bad.push({ key, reason: `字数目标得是 ${TARGET_MIN} 到 ${TARGET_MAX} 之间的整数（与书存档同一套上下限），这份写的是「${String(raw)}」` });
          continue;
        }
        out.fields.target_words = n;
      } else if (key === 'stylePack') {
        const sp = (src.stylePack && typeof src.stylePack === 'object' && !Array.isArray(src.stylePack)) ? src.stylePack : null;
        if (!sp) {
          out.bad.push({ key, reason: '规则包那格得是一组开关，不是一个字或一个数' });
          continue;
        }
        const weirdKeys = Object.keys(sp).filter((k) => !PACK_KEYS.includes(k));
        if (weirdKeys.length) {
          out.bad.push({ key, reason: `规则包里有认不出的子键：${weirdKeys.join('、')}` });
          continue;
        }
        const known = groupIds();
        const raw = Array.isArray(sp.disabled) ? sp.disabled : [];
        const ghostGroups = raw.filter((id) => !known.includes(id));
        if (ghostGroups.length) {
          out.bad.push({ key, reason: `这版程序里没有这些禁词组：${ghostGroups.map((g) => String(g)).join('、')}` });
          continue;
        }
        if (sp.enabled !== undefined && typeof sp.enabled !== 'boolean') {
          out.bad.push({ key, reason: '整包开关只能是开或关' });
          continue;
        }
        if (sp.extraBanned !== undefined && !Array.isArray(sp.extraBanned)) {
          out.bad.push({ key, reason: '自添禁词得是一个列表' });
          continue;
        }
        out.fields.stylePack = normalizePack(sp);
      }
    }
    // 两格的搭配在这儿一次判完 —— 放在整轮之后，所以「fields 里谁先谁后」不影响判决。
    // 这里问的是**这份预设自己声明了哪一档**（`format` 这一格可能根本没写，没写就不算它说了长篇：
    // 只带字数目标的预设要退 0、由 diffFields 判它在这本书上落不落得下），
    // 不是「某本书算哪一档」，所以不走 isShort。
    if (out.fields.format === 'long' && out.fields.target_words !== undefined) {
      delete out.fields.target_words;
      out.bad.push({ key: 'target_words', reason: LONG_NO_TARGET });
    }
    // 认不出的键整份拒收，不是「剩下的照用」：一份带着我们没见过的高阶设置的文件，
    // 用半份下去会让分享者以为自己那套已经落地，而接收者看不出没落地的那部分。
    if (out.unknown.length) out.errors.push(`这版程序认不出这些键：${out.unknown.join('、')} —— 整份预设没有应用`);
    out.ok = out.bad.length === 0 && out.unknown.length === 0
      && Object.keys(out.fields).length > 0 && !out.errors.length;
    if (!out.ok && !out.errors.length && !out.bad.length && !Object.keys(out.fields).length) {
      out.errors.push('这份预设里一格设置都没有');
    }
    return out;
  }

  /** 逐格比现在与预设 —— 只在这里比，界面与 CLI 都引它。changed 为假的那些格不许写库。 */
  function diffFields(book, fields) {
    const b = book || {};
    const now = pack(b).fields;
    const want = { ...(fields || {}) };
    // 外来那格先过同一道整理，否则「少写一个 enabled」会被比成改动
    if (want.stylePack) want.stylePack = normalizePack(want.stylePack);
    // 这一格在这本书里到底落不落得下，按**应用之后**的篇幅档判：预设把长篇换成短篇时，
    // 它带来的目标字数是有落点的，拿换之前的档拦就等于把整套短篇工作流挡在门外。
    const after = want.format !== undefined ? want.format : Tension.fmtOf(b);
    // pack 会替长篇把这一格藏起来（长篇没有它），可那个数还躺在库行里：进度条不画、
    // 面板说「没设」，而评分卡以前还照它算分。所以这里问的是「库里躺着数没有」，
    // 用与档无关的那一句（targetValue），不是「这一档该不该有它」（targetOf）——
    // 长篇遗留那一个正是清走的依据。
    const leftover = Tension.targetValue(b.target_words);
    return FIELDS.flatMap((key) => {
      if (want[key] === undefined) {
        // 只在这一份预设自己把篇幅档换成长篇时才清它：预设没带 format 却顺手抹掉作者定的
        // 目标，就是「应用只改它带来的格」这句话破了。
        if (key !== 'target_words' || leftover === null || want.format !== 'long') return [];
        return [{ key, label: FIELD_LABEL[key], current: valueText(key, leftover), incoming: CLEAR_NO_TARGET, blocked: null, clears: true, changed: true }];
      }
      const a = JSON.stringify(now[key] ?? null);
      const z = JSON.stringify(want[key] ?? null);
      const blocked = key === 'target_words' && after !== 'short' ? LONG_NO_TARGET : null;
      return [{ key, label: FIELD_LABEL[key], current: valueText(key, now[key]), incoming: valueText(key, want[key]), blocked, clears: false, changed: !blocked && a !== z }];
    });
  }

  function valueText(key, v) {
    if (v === undefined) return '（这一格没设）';
    if (key === 'format') return formatLabel(v);
    if (key === 'target_words') return `${v} 字`;
    return packSummary(v);
  }

  /** 交给写库那一路的补丁 —— 只含预设真带、且真变了的那几格。 */
  function patchOf(book, fields) {
    const rows = diffFields(book, fields).filter((r) => r.changed);
    const patch = {};
    // clears 那一格预设里没有对应的值（它带的就是「别留」），写 null 与建档那一路同一做法：
    // 库行里 target_words 为 null 时导出会把它整个丢掉（见 src/core/project.js 的 pick）。
    for (const r of rows) patch[r.key] = r.clears ? null : fields[r.key];
    return patch;
  }

  /** 文件名：slug 走 NWText.slugify 那一个出处，不许界面自己拼一遍书名。 */
  function fileName(preset) {
    const slug = (T && T.slugify ? T.slugify((preset && preset.name) || 'workflow') : '') || 'workflow';
    return `novelweave-workflow-${slug}.json`;
  }

  /**
   * 随货内置预设。三条都是 normalize 过得去的（有一条守卫专门拿这份自我校验），
   * 禁词组 id 一律现取 SP.GROUPS，抄错就在守卫里红。
   */
  const BUILTINS = [
    {
      name: '网文日更 · 长篇',
      note: '只定篇幅档：字数目标与基准章留给这一本书自己长出来',
      fields: { format: 'long' },
    },
    {
      name: '短篇 · 全套机检',
      note: '八组禁词全开、不自添，先按 8000 字的目标写',
      fields: { format: 'short', target_words: 8000, stylePack: { enabled: true, disabled: [], extraBanned: [] } },
    },
    {
      name: '短篇 · 手松一档',
      note: '把最容易被误伤的两组（段尾金句、抽象概括）关掉，其余照旧',
      fields: { format: 'short', target_words: 3000, stylePack: { enabled: true, disabled: ['aphorism', 'abstract'], extraBanned: [] } },
    },
  ];

  return {
    WORKFLOW_VERSION, KIND, FILE_VERSION, FIELDS, NOT_SHARED, FORMATS, FIELD_LABEL, PACK_KEYS, BUILTINS,
    TARGET_MIN, TARGET_MAX, LONG_NO_TARGET, CLEAR_NO_TARGET,
    pack, normalize, diffFields, patchOf, fileName, packSummary, valueText, normalizePack, groupIds,
  };
});
