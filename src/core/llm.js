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
    // 2026-08 更新：对齐 yu.ai/key.html 收录的免费额度，免费优先
    zhipu: { label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.7-flash', note: 'Flash 免费 · 国内直连' },
    deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', note: 'V3.1 · 便宜 · 长上下文好' },
    siliconflow: { label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen2.5-7B-Instruct', note: '免费档 16+ 模型 · 国内直连' },
    moonshot: { label: 'Kimi 月之暗面', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k2-0905-preview', note: '256K 超长上下文' },
    openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-chat-v3.1', note: '一个 Key 多家模型 · 有 :free 款' },
    gemini: { label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.5-flash', note: '免费层 · 多模态 · 1M ctx' },
    openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', note: '最稳，贵' },
    custom: { label: '自定义', baseURL: '', defaultModel: '', note: '任何兼容接口' },
  };

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
      chapterId: opts.chapterId, budget: opts.budget, style: opts.style,
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
    streamChat, requestChat, testConnection,
  };
});
