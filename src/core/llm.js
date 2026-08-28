/**
 * NovelWeave · 织文 — LLM 客户端与 Prompt 构造（UMD：浏览器与 Node 共用）
 * 浏览器直连 OpenAI 兼容 API，专为网文写作优化。
 *
 * Prompt 构造放这里而不是 app.js，是为了让 Web 面板和 agent 脚本走同一条
 * 召回路径：两边产出的上下文应当逐字一致，否则「在浏览器里没问题、agent
 * 写出来就崩」无法排查。
 */
(function (root, factory) {
  const mod = factory(root.NWText);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NovelLLM = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (NWText) {
  'use strict';

  const NW_LLM_CONFIG_KEY = 'nw_llm_config';

  /** 上下文字节预算。长篇必爆的第一原因就是无脑塞全文，这里默认按字节硬截。 */
  const DEFAULT_BUDGET = {
    contextBytes: 12288,   // 整份派生上下文
    loreBytes: 4096,       // 其中分给世界设定的额度
    prevTailChars: 2000,   // 前文结尾
    currentTailChars: 3000, // 本章已有正文
  };

  const NW_LLM_PRESETS = {
    openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-chat-v3.1', note: '多模型可切换' },
    deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', note: '便宜，长上下文好' },
    siliconflow: { label: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen2.5-72B-Instruct', note: '国内直连' },
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

  // ═══════════════════ 世界书关键词触发 ═══════════════════
  // 语义参考 SillyTavern World Info / Character Card V2 的 character_book.entries[]，
  // 字段名对齐，便于日后「导出为 lorebook」只是搬字段。

  /** 把 IndexedDB 里的 worldbuilding 行归一成 lorebook 条目。 */
  function toLoreEntry(wb, index = 0) {
    const keys = Array.isArray(wb.keys) && wb.keys.length ? wb.keys : [wb.name].filter(Boolean);
    return {
      id: wb.id,
      name: wb.name,
      comment: wb.comment ?? wb.name,
      type: wb.type || 'custom',
      content: wb.content ?? wb.description ?? '',
      keys: keys.map(String),
      secondary_keys: (wb.secondary_keys || []).map(String),
      selective: wb.selective ?? false,
      constant: wb.constant ?? (wb.type === 'rule' || wb.type === 'system'),
      position: wb.position || 'before_character_definition',
      insertion_order: wb.insertion_order ?? (100 + index * 10),
      priority: wb.priority ?? 0,
      enabled: wb.enabled !== false,
      case_sensitive: wb.case_sensitive ?? false,
    };
  }

  function hasKey(text, key, caseSensitive) {
    if (!key) return false;
    if (caseSensitive) return text.includes(key);
    return text.toLowerCase().includes(key.toLowerCase());
  }

  /**
   * 按扫描窗口内出现的关键词挑选世界条目。
   * constant 条目无条件注入；selective 条目要求主键与副键同时命中。
   * 排序：priority 降序 → insertion_order 升序；超额即截断（不静默：返回 dropped）。
   */
  function loreTrigger(text, entries, opts = {}) {
    const budget = Object.assign({}, DEFAULT_BUDGET, opts);
    const hay = String(text || '');
    const scanWindow = budget.scanDepthChars
      ? hay.slice(-budget.scanDepthChars)
      : hay;
    const pool = (entries || []).map(toLoreEntry).filter((e) => e.enabled && e.content);

    const matched = [];
    for (const e of pool) {
      const primary = e.keys.some((k) => hasKey(scanWindow, k, e.case_sensitive));
      const secondaryOk = !e.selective || !e.secondary_keys.length
        ? true
        : e.secondary_keys.some((k) => hasKey(scanWindow, k, e.case_sensitive));
      if (e.constant || (primary && secondaryOk)) matched.push(e);
    }

    matched.sort((a, b) => (b.priority - a.priority) || (a.insertion_order - b.insertion_order));

    const included = [], dropped = [];
    let bytes = 0;
    for (const e of matched) {
      const line = `【${e.name}】${e.content}`;
      const size = NWText.bytesOf(line);
      if (bytes + size > budget.loreBytes) { dropped.push(e.id); continue; }
      bytes += size;
      included.push(e);
    }
    return { entries: included, dropped, bytes };
  }

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

  /**
   * 续写。旧版这里有个致命问题：形参 chapter 在函数体内完全没被使用，
   * 而调用点 prevChapter 恒传 null —— 结果是 prompt 里一个字正文都没有，
   * 模型只看到一份角色清单。现在正文、前文、世界设定三者都进上下文。
   *
   * opts: { novel, characters, worldEntries, currentChapter, prevChapter, nextTitle, budget }
   */
  function buildContinuePrompt(opts = {}) {
    return buildContinueContext(opts).prompt;
  }

  /**
   * 构造续写上下文，并附一份**用量报告**。
   * 静默裁切是最坑人的失败方式：它不报错，只是写出来的东西和前文脱节，
   * 而作者会以为模型看过了全书。所以截断必须显式回传。
   */
  function buildContinueContext(opts = {}) {
    const b = Object.assign({}, DEFAULT_BUDGET, opts.budget);
    const { novel, characters, worldEntries, currentChapter, prevChapter } = opts;

    const scanText = [prevChapter?.content, currentChapter?.content].filter(Boolean).join('\n');
    const lore = loreTrigger(scanText, worldEntries, b);
    const prevTail = prevChapter?.content
      ? `【上一章《${prevChapter.title || '未命名'}》结尾】\n…${prevChapter.content.slice(-b.prevTailChars)}\n\n`
      : '';
    const fresh = !!currentChapter?.content?.trim();
    const curBody = fresh
      ? `【本章《${currentChapter.title || '未命名'}》已写正文】\n…${currentChapter.content.slice(-b.currentTailChars)}\n\n请从上面正文的末尾接着写下去，不要重复已有内容。\n`
      : `【本章《${opts.nextTitle || currentChapter?.title || '下一章'}》尚未开始】\n请接着上一章写本章。\n`;

    const prompt = `${novel?.description ? '【作品设定】\n' + novel.description + '\n\n' : ''}${renderLore(lore.entries)}${lore.entries.length ? '\n\n' : ''}【角色设定】
${renderCharacters(characters)}

${prevTail}${curBody}
写作要求：
- 保持角色性格和说话方式一致，已建立的设定不得自相矛盾
- 剧情自然推进，不要跳跃
- 风格：${novel?.genre || '玄幻小说'}
- 字数要求 3000-5000 字
- 只输出小说正文，不要任何解释${opts.extraInstructions ? '\n- ' + opts.extraInstructions : ''}`;

    return {
      prompt,
      usage: {
        bytes: NWText.bytesOf(prompt),
        budgetBytes: b.contextBytes,
        sections: [
          { name: '作品设定', present: !!novel?.description, bytes: NWText.bytesOf(novel?.description || '') },
          { name: '世界设定', present: lore.entries.length > 0, bytes: lore.bytes,
            included: lore.entries.map((e) => e.name), dropped: lore.dropped },
          { name: '角色设定', present: !!(characters || []).length, bytes: NWText.bytesOf(renderCharacters(characters)) },
          { name: '上一章结尾', present: !!prevTail, bytes: NWText.bytesOf(prevTail) },
          { name: '本章已写正文', present: fresh, bytes: NWText.bytesOf(curBody) },
        ],
        hasPrevChapter: !!prevTail,
        hasCurrentBody: fresh,
        loreDropped: lore.dropped,
        truncated: lore.dropped.length > 0,
      },
    };
  }

  /** 一致性检查。输入是当前章正文 + 全部角色 + 触发的世界条目。 */
  function buildConsistencyCheckPrompt(content, characters, worldEntries, novel) {
    const lore = loreTrigger(content, worldEntries);
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
    DEFAULT_BUDGET,
    CONFIG_KEY: NW_LLM_CONFIG_KEY,
    getConfig: getLLMConfig, setConfig: setLLMConfig, hasConfig: hasLLMConfig,
    toLoreEntry, loreTrigger,
    buildContinuePrompt, buildContinueContext, buildConsistencyCheckPrompt, buildSummarizePrompt,
    buildPolishPrompt, buildOutlinePrompt,
    streamChat, requestChat, testConnection,
  };
});
