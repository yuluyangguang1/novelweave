/**
 * NovelWeave · 织文 — LLM 客户端与 Prompt 构造（UMD：浏览器与 Node 共用）
 * 浏览器直连 OpenAI 兼容 API，专为网文写作优化。
 *
 * Prompt 构造放这里而不是 app.js，是为了让 Web 面板和 agent 脚本走同一条
 * 召回路径：两边产出的上下文应当逐字一致，否则「在浏览器里没问题、agent
 * 写出来就崩」无法排查。
 */
(function (root, factory) {
  const mod = factory(root.NWText, root.NWStory, root.NWContext);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NovelLLM = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (NWText, NWStory, NWContext) {
  'use strict';

  const NW_LLM_CONFIG_KEY = 'nw_llm_config';

const NW_LLM_PRESETS = {
    // 2026-09-02 更新：型号经官方文档/定价页核对(智谱 docs.bigmodel.cn / Kimi platform.kimi.com / 硅基 models 页)
    zhipu: { label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.7-flash', note: 'Flash 免费 · GLM-5.3 已上线 · 国内直连' },
    deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', note: '便宜 · 长上下文好' },
    siliconflow: { label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen3.6-35B-A3B', note: 'Qwen3.6/DeepSeek-V4/GLM-5.2 · 国内直连' },
    moonshot: { label: 'Kimi 月之暗面', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3', note: '旗舰 · 1M token 上下文' },
    openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-chat-v3.1', note: '一个 Key 多家模型 · 有 :free 款' },
    gemini: { label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.5-flash', note: '免费层 · 多模态 · 1M ctx' },
    openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', note: '最稳，贵' },
    custom: { label: '自定义', baseURL: '', defaultModel: '', note: '任何兼容接口' },
  }

  function storage() {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  }

  function getLLMConfig() {
    try {
      const raw = storage()?.getItem(NW_LLM_CONFIG_KEY);
      if (!raw) return null;
      const cfg = JSON.parse(raw);
      return (cfg.apiKey && cfg.baseURL && cfg.model) ? cfg : null;
    } catch { return null; }
  }

  function setLLMConfig(cfg) { storage()?.setItem(NW_LLM_CONFIG_KEY, JSON.stringify(cfg)); }
  function hasLLMConfig() { return !!getLLMConfig(); }

  function renderLore(injected) {
    if (!injected.length) return '';
    return '【世界设定（按本章内容触发）】\n' + injected.map((e) => `- ${e.name}：${e.content}`).join('\n');
  }

  function renderCharacters(characters, only) {
    const pool = only && only.length
      ? (characters || []).filter((c) => only.includes(c.id) || only.includes(c.name))
      : characters || [];
    if (!pool.length) return '无角色设定';
    return pool.map((c) => `- ${c.name}（${c.role || '角色'}）：${c.personality || ''}${c.background ? '；背景：' + c.background : ''}`).join('\n');
  }

  // ═══════════════════ Prompt 构造 ═══════════════════

  const WRITING_RULES = (genre) => `写作要求：
- 保持角色性格和说话方式一致，已建立的设定不得自相矛盾
- 剧情自然推进，不要跳跃
- 已死亡或下落不明的人物不得凭空行动；外貌特征受已登记的变化区间约束
- 风格：${genre || '玄幻小说'}
- 字数要求 3000-5000 字
- 只输出小说正文，不要任何解释`;

  /**
   * 续写上下文。拼装本身在 src/core/context.js —— 那是 Web 与 CLI 共用的唯一实现。
   * 之前这里自己拼了 5 节，比 CLI 少注入了「状态快照」与「未结线索」，
   * 于是作者录进状态矩阵和伏笔表的事实在浏览器里根本没进 prompt。
   *
   * @param opts { ctx, chapterId: 'ch-003'|'next', budget, extraInstructions, style?: boolean }
   *   style: 开启「风格样例」节 —— 从作者已定稿章节取节选注入，模仿作者自己的笔法
   */
  function buildContinueContext(opts = {}) {
    const built = NWContext.buildSections(opts.ctx, {
      chapterId: opts.chapterId, budget: opts.budget, style: opts.style, embedHits: opts.embedHits,
    });
    const rules = WRITING_RULES(opts.ctx?.book?.genre)
      + (opts.extraInstructions ? `\n- ${opts.extraInstructions}` : '');
    return { prompt: NWContext.renderPrompt(built, rules), usage: built.usage, sections: built.sections };
  }

  function buildContinuePrompt(opts = {}) {
    return buildContinueContext(opts).prompt;
  }

  /** 一致性检查。输入是当前章正文 + 全部角色 + 触发的世界条目。 */
  function buildConsistencyCheckPrompt(content, characters, worldEntries, novel) {
    const lore = NWStory.loreTrigger(content, worldEntries);
    return `你是专业的网文编辑。请对比设定与前文，找出不一致的地方。

${renderLore(lore.entries)}${lore.entries.length ? '\n\n' : ''}【角色设定】
${renderCharacters(characters)}

【待检查内容】
${String(content || '').slice(0, 6000)}

逐条列出问题，每条注明：涉及角色/设定、原文引用、矛盾在哪、建议改法。
如果没有任何问题，只回复"一致"二字。`;
  }

  /** 章节总结。结果应当回写 chapter.summary，供后续召回使用。 */
  function buildSummarizePrompt(content, title) {
    return `用不超过 200 字总结下面这一章，格式为四行：
核心事件：
出场角色：
状态变化（谁的位置/伤势/持有物/认知发生了改变）：
新埋或回收的伏笔：

${title ? `【章节】${title}\n` : ''}${String(content || '').slice(0, 8000)}`;
  }

  /** 语病精修(Refine):只修语言,不动事实 —— 三重管线第二环(学 vela)。 */
  function buildRefinePrompt(content) {
    return `你是中文文字编辑。检查下面章节的语病、错别字、重复用词与不通顺的句子，逐一改正。

【要求】
- 只修语言问题：错别字、语法、搭配、重复、标点
- 不得改动情节事实、对白信息量与叙事顺序
- 只输出修改后的完整正文，不要任何解释

【正文】
${String(content || '').slice(0, 8000)}`;
  }

  /** 编辑视角评审(Review):三重管线第三环,只出报告不动稿。 */
  function buildReviewPrompt(content, chapterInfo) {
    return `你是资深网文编辑，以读者与编辑双重视角评审下面这一章。

${chapterInfo ? `【本章信息】${chapterInfo}\n` : ''}
【正文】
${String(content || '').slice(0, 8000)}

从四个维度逐条点评，每条注明原文依据与改进建议；没有问题的维度写"通过"：
1. 节奏：场景推进是否拖沓或跳跃，章末钩子是否成立
2. 人物：言行是否符合既定性格，动机是否成立
3. 伏笔：本章埋设/回收是否自然，是否与既定承诺一致
4. 文字：是否有明显的套路化表达或节奏单调

只输出评审报告，不要改写正文。`;
  }

  /** 润色。只改表达，不改事实——这条约束是防止 AI 顺手把剧情改了。 */
  function buildPolishPrompt(content, instructions) {
    return `润色下面的文字，保持原意、人称、时态和风格，使表达更流畅、有画面感。
硬性约束：不得改变任何情节事实（谁做了什么、谁在场、时间先后）、不得增删对白信息量。
只输出润色后的正文。
${instructions ? '额外要求：' + instructions + '\n' : ''}
【原文】
${String(content || '').slice(0, 6000)}`;
  }

  function buildOutlinePrompt(novel, existingChapters, characters) {
    const chText = (existingChapters || []).length
      ? [...existingChapters]
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map((c) => `第${c.order}章《${c.title}》：${c.summary || (c.content || '').slice(0, 200)}`)
          .join('\n')
      : '暂无章节';

    return `你是资深网文策划编辑。

【作品信息】
书名：${novel?.title || '未命名'}
类型：${novel?.genre || '玄幻'}
${novel?.description ? '概述：' + novel.description : ''}

【角色】
${renderCharacters(characters)}

【已有章节】
${chText}

请生成 20 章大纲，每章包含：序号、标题、核心事件（1-2 句话）、需要埋设或回收的伏笔。
若已有章节，从已有章节之后接着排。格式简洁即可。`;
  }

  // ═══════════════════ AI 起书（短篇从零向导） ═══════════════════
  // 从零管道的第一块试验田：想法 → 结构化梗概（可改）→ 建档落盘。
  // 正文仍由作者逐章「续写」产出 —— 向导建的是骨架，不是成品。

  /** 结构流派与篇幅档的口径与 skills/novelweave/assets/templates/short-presets.json 一致。 */
  const SHORT_STRUCTURES = ['反转流', '情感流', '脑洞设定流'];
  const SHORT_TIERS = ['微型（3k-6k 字，1-2 章）', '标准（8k-15k 字，3-6 章）', '大短篇（20k-30k 字，6-10 章）'];
  // 平台档位:名称 → 目标字数(与 short-presets.json 的 wordBudgets 同口径)
  const SHORT_PLATFORMS = [
    { id: 'gzh', label: '公众号（约 6k 字）', words: 6000 },
    { id: 'fanqie', label: '番茄短篇（约 2 万字）', words: 20000 },
    { id: 'yanxuan', label: '知乎盐选（约 5 万字）', words: 50000 },
  ];

  function buildShortConceptPrompt({ idea, genre, structure, tier }) {
    return `你是资深短篇网文编辑。根据作者的一句话想法，生成一篇短篇的完整梗概。

【题材】${genre || '不限'}
【结构流派】${structure || '反转流'}（反转流=层层反转；情感流=双时间线交错；脑洞设定流=设定推演到底）
【篇幅档】${tier || '标准（8k-15k 字，3-6 章）'}
【作者的想法】${idea}

要求：
- 反转要有公平性（前面留过线索），结尾必须有二次反转或情绪爆点
- 人物 2-4 个，每人一句话性格
- 章数按篇幅档；每章给出标题与拍点（该章发生什么 + 章末钩子）

只输出一个 JSON 对象，不要任何解释、不要代码块标记，格式：
{"title":"书名","logline":"一句话梗概","characters":[{"name":"名字","role":"主角","personality":"一句话性格"}],"chapters":[{"title":"章标题","beat":"该章拍点与章末钩子"}]}`;
  }

  /** 从模型输出里稳健地抠出梗概 JSON（容忍代码块围栏与前后废话）。 */
  function parseConceptJSON(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('模型没有返回可解析的梗概 JSON');
    const j = JSON.parse(m[0]);
    if (!j.title || !Array.isArray(j.chapters) || !j.chapters.length) {
      throw new Error('梗概缺少书名或章节，请重试或换个说法');
    }
    return {
      title: String(j.title).slice(0, 50),
      logline: String(j.logline || '').slice(0, 200),
      characters: j.characters.slice(0, 6).map((c) => ({
        name: String(c.name || '').slice(0, 20),
        role: String(c.role || '配角').slice(0, 10),
        personality: String(c.personality || '').slice(0, 60),
      })).filter((c) => c.name),
      world: (Array.isArray(j.world) ? j.world : []).slice(0, 6).map((w) => ({
        name: String(w.name || '').slice(0, 30),
        content: String(w.content || '').slice(0, 120),
      })).filter((w) => w.name),
      volumes: (Array.isArray(j.volumes) ? j.volumes : []).slice(0, 6).map((v) => ({
        title: String(v.title || '').slice(0, 40),
        summary: String(v.summary || '').slice(0, 200),
      })).filter((v) => v.title),
      chapters: j.chapters.slice(0, 12).map((c) => ({
        title: String(c.title || '').slice(0, 40),
        beat: String(c.beat || '').slice(0, 300),
      })).filter((c) => c.title),
    };
  }

  // ═══════════════════ AI 起书（长篇从零向导 · 卷纲层） ═══════════════════
  // 长篇骨架 = 人物 + 世界设定 + 卷纲 + 首卷前 12 章章纲。卷纲落「写作笔记」，
  // 世界设定落 worldbuilding,章纲落章节拍点 —— 全部走既有存储，不发明新格式。

  const LONG_VOLUME_OPTIONS = [2, 3, 5];

  function buildLongConceptPrompt({ idea, genre, volumes = 3 }) {
    const chs = Math.min(12, volumes * 4);
    return `你是资深网文策划编辑。根据作者的想法，为一部长篇连载生成全书骨架。

【题材】${genre || '玄幻'}
【计划卷数】约 ${volumes} 卷
【作者的想法】${idea}

要求：
- 人物 3-6 个：主角、对手、导师或配角各至少一人，每人一句话性格
- 世界设定 2-4 条（地点 / 势力 / 力量规则），每条不超过 40 字
- 卷纲 ${volumes} 卷：每卷一句话，写明该卷核心冲突与卷末结局
- 第一卷前 ${chs} 章的章纲：每章标题 + 拍点（该章发生什么 + 章末钩子）
- 第一章必须让主角以动作或抉择出场；前三章各留一个钩子

只输出一个 JSON 对象，不要任何解释、不要代码块标记，格式：
{"title":"书名","logline":"一句话梗概","characters":[{"name":"","role":"","personality":""}],"world":[{"name":"","content":""}],"volumes":[{"title":"","summary":""}],"chapters":[{"title":"","beat":""}]}`;
  }

  // ═══════════════════ 拆书(结构模式逆向) ═══════════════════
  // 学星月 AI 拆书:从已有文本抽取"结构模式"而非文字 —— 版权安全(只提取模式)。
  // 产物是可复用的拍点模板,与 genre-presets/golden-three 同格式家族。

  function buildDeconstructPrompt(text, meta = {}) {
    return `你是资深网文结构编辑。拆解下面的文本，抽取"结构模式"——只要骨架，不要复述情节或句子。

【文本来源】${meta.source || '作者提供'}
【篇幅】约 ${meta.words || '未知'} 字

请抽取：
1. 金手指/核心设定类型及其登场时机
2. 爽点节拍：几次、分别在第几屏/章、类型（打脸/升级/反转/情感）
3. 伏笔密度与回收节奏
4. 章末钩子类型分布（问句/突转/期限/身份悬置）
5. 节奏结构：按屏或章列拍点序列

只输出一个 JSON 对象，格式：
{"name":"模式名","goldenFinger":"类型及登场时机","beats":[{"at":"第1屏","type":"钩子","note":"模式描述"}],"foreshadowDensity":"描述","hookTypes":["类型"],"summary":"一段话总结该结构适合什么题材"}
`;
  }

  /** 从模型输出抠出拆解 JSON（容忍围栏）。 */
  function parseDeconstructJSON(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('模型没有返回可解析的拆解 JSON');
    const j = JSON.parse(m[0]);
    if (!j.name || !Array.isArray(j.beats) || !j.beats.length) throw new Error('拆解缺少模式名或拍点');
    return {
      name: String(j.name).slice(0, 40),
      goldenFinger: String(j.goldenFinger || '').slice(0, 120),
      beats: j.beats.slice(0, 20).map((b) => ({ at: String(b.at || '').slice(0, 20), type: String(b.type || '').slice(0, 20), note: String(b.note || '').slice(0, 120) })),
      foreshadowDensity: String(j.foreshadowDensity || '').slice(0, 120),
      hookTypes: (Array.isArray(j.hookTypes) ? j.hookTypes : []).slice(0, 6).map((h) => String(h).slice(0, 20)),
      summary: String(j.summary || '').slice(0, 200),
    };
  }

    // ═══════════════════ 传输 ═══════════════════

  function endpoint(cfg) {
    return `${String(cfg.baseURL || '').replace(/\/$/, '')}/chat/completions`;
  }

  async function* streamChat(messages, opts = {}) {
    const cfg = opts.config || getLLMConfig();
    if (!cfg) { yield { type: 'error', content: '请先配置 API Key' }; return; }
    let res;
    try {
      res = await fetch(endpoint(cfg), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model, messages, stream: true,
          temperature: opts.temperature ?? 0.8, max_tokens: opts.max_tokens ?? 8000,
        }),
        signal: opts.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') { yield { type: 'aborted' }; return; }
      yield { type: 'error', content: '网络错误：' + e.message };
      return;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      yield { type: 'error', content: `HTTP ${res.status}: ${t.slice(0, 300)}` };
      return;
    }
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') { yield { type: 'done' }; return; }
          try {
            const j = JSON.parse(payload);
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) yield { type: 'chunk', content: delta };
          } catch {}
        }
      }
      yield { type: 'done' };
    } catch (e) {
      if (e.name === 'AbortError') yield { type: 'aborted' };
      else yield { type: 'error', content: '流中断：' + e.message };
    }
  }

  async function requestChat(messages, opts = {}) {
    let full = '';
    for await (const m of streamChat(messages, { ...opts, max_tokens: opts.max_tokens ?? 4000 })) {
      if (m.type === 'chunk') full += m.content;
      else if (m.type === 'error') return { error: m.content };
      else if (m.type === 'aborted') return { error: '已中断' };
    }
    return { content: full };
  }

  /** 连接测试。旧版在 settings 和 workspace 两处各抄了一份，收敛成一个。 */
  async function testConnection({ baseURL, apiKey, model }) {
    try {
      const res = await fetch(endpoint({ baseURL }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false }),
      });
      return res.ok
        ? { ok: true }
        : { ok: false, message: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 150)}` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  return {
    PRESETS: NW_LLM_PRESETS,
    CONFIG_KEY: NW_LLM_CONFIG_KEY,
    getConfig: getLLMConfig, setConfig: setLLMConfig, hasConfig: hasLLMConfig,
    
    buildContinuePrompt, buildContinueContext, buildConsistencyCheckPrompt, buildSummarizePrompt,
    buildPolishPrompt, buildOutlinePrompt,
    buildShortConceptPrompt, parseConceptJSON, SHORT_STRUCTURES, SHORT_TIERS, SHORT_PLATFORMS,
    buildRefinePrompt, buildReviewPrompt,
    buildDeconstructPrompt, parseDeconstructJSON,
    buildLongConceptPrompt, LONG_VOLUME_OPTIONS,
    streamChat, requestChat, testConnection,
  };
});
