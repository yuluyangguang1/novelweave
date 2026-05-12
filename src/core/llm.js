/**
 * NovelWeave · 织文 — LLM Client
 * 浏览器直连 OpenAI 兼容 API，专为网文写作优化。
 */

const NW_LLM_CONFIG_KEY = 'nw_llm_config';

const NW_LLM_PRESETS = {
  openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-chat-v3.1', note: '多模型可切换' },
  deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', note: '便宜，长上下文好' },
  siliconflow: { label: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen2.5-72B-Instruct', note: '国内直连' },
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', note: '最稳，贵' },
  custom: { label: '自定义', baseURL: '', defaultModel: '', note: '任何兼容接口' },
};

function getLLMConfig() {
  try {
    const raw = localStorage.getItem(NW_LLM_CONFIG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    return (cfg.apiKey && cfg.baseURL && cfg.model) ? cfg : null;
  } catch { return null; }
}

function setLLMConfig(cfg) { localStorage.setItem(NW_LLM_CONFIG_KEY, JSON.stringify(cfg)); }
function hasLLMConfig() { return !!getLLMConfig(); }

function buildContinuePrompt(chapter, prevChapter, novel, chars) {
  const charCtx = chars?.length
    ? chars.map(c => `- ${c.name}：${c.personality || ''}，${c.background || ''}`).join('\n')
    : '无角色设定';
  
  const worldCtx = novel?.description ? `【作品设定】\n${novel.description}` : '';
  const prevContent = prevChapter
    ? `【前文结尾】\n${prevChapter.content.slice(-3000)}\n\n`
    : '';
  
  return `${worldCtx}

【角色设定】
${charCtx}

${prevContent}请继续写下一章内容。

写作要求：
- 保持角色性格和说话方式一致
- 剧情自然推进，不要跳跃
- 风格：${novel?.genre || '玄幻小说'}
- 字数要求 3000-5000 字
- 只输出小说正文，不要任何解释`;
}

function buildConsistencyCheckPrompt(content, chars) {
  const charInfo = chars?.length
    ? chars.map(c => `- ${c.name}：${c.personality || ''}，${c.appearance || ''}，${c.background || ''}`).join('\n')
    : '无角色设定';
  
  return `你是专业的网文编辑。请对比角色设定和章节内容，找出不一致的地方。

【角色设定】
${charInfo}

【章节内容】
${content.slice(0, 6000)}

逐条列出问题。如果没有问题回复"一致"。`;
}

function buildOutlinePrompt(novel, existingChapters) {
  const chText = existingChapters.length
    ? existingChapters
        .sort((a, b) => a.order - b.order)
        .map(c => `第${c.order}章《${c.title}》：${(c.content || '').slice(0, 200)}...`)
        .join('\n')
    : '暂无章节';
  
  return `你是资深网文策划编辑。

【作品信息】
书名：${novel?.title || '未命名'}
类型：${novel?.genre || '玄幻'}
${novel?.description ? '概述：' + novel.description : ''}

【已有章节】
${chText}

请生成 20 章大纲，每章包含：序号、标题、核心事件（1-2 句话）。
格式简洁即可。`;
}

async function* streamChat(messages, opts = {}) {
  const cfg = getLLMConfig();
  if (!cfg) {
    yield { type: 'error', content: '请先配置 API Key' };
    return;
  }
  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model, messages, stream: true,
        temperature: opts.temperature ?? 0.8, max_tokens: opts.max_tokens ?? 8000,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      yield { type: 'error', content: `HTTP ${res.status}: ${t.slice(0, 300)}` };
      return;
    }
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
    yield { type: 'error', content: '网络错误：' + e.message };
  }
}

async function requestChat(messages, opts = {}) {
  const cfg = getLLMConfig();
  if (!cfg) return { error: '请先配置 API Key' };
  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model, messages, stream: false,
        temperature: opts.temperature ?? 0.7, max_tokens: opts.max_tokens ?? 4000,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    const json = await res.json();
    return { content: json.choices?.[0]?.message?.content || '' };
  } catch (e) {
    return { error: '网络错误：' + e.message };
  }
}

window.NovelLLM = {
  PRESETS: NW_LLM_PRESETS,
  getConfig: getLLMConfig, setConfig: setLLMConfig, hasConfig: hasLLMConfig,
  buildContinuePrompt, buildConsistencyCheckPrompt, buildOutlinePrompt,
  streamChat, requestChat,
};
