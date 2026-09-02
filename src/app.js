/**
 * NovelWeave · 织文 — 主应用
 *
 * 三条贯穿全文件的规矩：
 * 1. 用户数据绝不进内联脚本。DOM 上只放 data-action / data-id，点击走事件委托。
 *    （旧版把整章正文 JSON.stringify 塞进 onclick 属性，正文里一个半角双引号
 *     就闭合了属性，那一章直接点不开。）
 * 2. 往 DOM 写文本一律用 NWText.esc / textContent，派生数字不靠 HTML 回填。
 * 3. 路由参数是唯一权威，页面按 id 去数据层取，不依赖模块级变量传递。
 */

const APP = {
  novelId: null,
  novel: null,
  chapter: null,
  activeTab: 'chapters',
  autoSaveTimer: null,
  dirty: false,
  lastAIResult: '',
  aiAbort: null,
  revisions: null,
};

const { esc, attr, countWords } = NWText;

/** 引用 index.html 里的内联 sprite；描线继承 currentColor，故自动跟随主题。 */
const icon = (name, cls = '') => `<svg class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const AUTOSAVE_MS = 15000;

/** AI 工具箱的唯一权威表：面板按钮和 runAITool 的分支由它保证一致。
 *  旧版 index.html 里写死了四个 onclick 调用根本不存在的函数，面板整块是死的。 */
const AI_TOOLS = [
  { id: 'continue',    icon: 'insert',  label: '续写',     needsChapter: true,  maxTokens: 8000 },
  { id: 'polish',      icon: 'sparkle', label: '润色',     needsChapter: true,  maxTokens: 4000, needsContent: true },
  { id: 'refine',      icon: 'check',    label: '语病精修', needsChapter: true,  maxTokens: 4000, needsContent: 200 },
  { id: 'review',      icon: 'bank',     label: '编辑评审', needsChapter: true,  maxTokens: 3000, needsContent: 200 },
  { id: 'consistency', icon: 'search',  label: '一致性检查', needsChapter: true,  maxTokens: 4000, needsContent: 100 },
  { id: 'summarize',   icon: 'note',    label: '总结本章',  needsChapter: true,  maxTokens: 1000, needsContent: true },
  { id: 'outline',     icon: 'chapter', label: '生成大纲',  needsChapter: true,  maxTokens: 4000 },
];

const TABS = [
  { id: 'chapters',   icon: 'chapter',  label: '章节',     hasAdd: true,  addTitle: '添加章节' },
  { id: 'characters', icon: 'users',    label: '角色',     hasAdd: true,  addTitle: '添加角色' },
  { id: 'world',      icon: 'globe',    label: '世界设定', hasAdd: true,  addTitle: '添加设定' },
  { id: 'promises',   icon: 'thread',   label: '伏笔',     hasAdd: true,  addTitle: '登记伏笔' },
  { id: 'timeline',   icon: 'clock',    label: '时间线',   hasAdd: true,  addTitle: '添加时间锚点' },
  { id: 'states',     icon: 'compass',  label: '状态',     hasAdd: false, addTitle: '' },
  { id: 'continuity', icon: 'search',   label: '连续性',   hasAdd: false, addTitle: '' },
  { id: 'decisions',  icon: 'bank',     label: '决策',     hasAdd: true,  addTitle: '记一条创作决策' },
  { id: 'relations',  icon: 'thread',   label: '关系',     hasAdd: true,  addTitle: '登记一条关系' },
  { id: 'notes',      icon: 'note',     label: '写作笔记', hasAdd: true,  addTitle: '添加笔记' },
  { id: 'settings',   icon: 'settings', label: 'AI 设置',  hasAdd: false, addTitle: '' },
];

// ═══════════════════ 初始化 ═══════════════════

async function initApp() {
  wireDelegation();
  renderAIPanelTools();
  bindEditorShortcuts();

  // SW 横幅刷新按钮
  // SW 横幅:刷新按钮 + 关闭(会话内不再弹,clients.claim 会反复发消息)
  const swBanner = document.getElementById('sw-banner');
  const swClose = document.getElementById('sw-close');
  const swBtn = document.getElementById('sw-reload');
  if (swClose) swClose.onclick = () => {
    try { sessionStorage.setItem('nw_sw_dismissed', '1'); } catch (_) {}
    swBanner.hidden = true;
  };
  if (swBtn) swBtn.onclick = () => location.reload();

  // Esc 可达性:连续生成进度层停止 → AI 面板关闭 → 普通弹层关闭(评审 #四.5)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const batchMask = document.getElementById('batch-mask');
    if (batchMask) {
      if (APP.batchAbort) APP.batchAbort.abort();
      batchMask.remove();
      return;
    }
    const panel = document.getElementById('ai-panel');
    if (panel && !panel.classList.contains('hidden')) { closeAIPanel(); return; }
    const dlg = document.querySelector('.modal-overlay');
    if (dlg) dlg.remove();
  });

  // 旧版增量记账已经把历史作品的字数弄错了（单改一次标题就扣掉一整章），启动时校正一次。
  try { await NovelDB.recountAll(); } catch (e) { console.warn('统计校正失败', e); }

  router.onPage = onPageEntered;
  const enteredOn = (location.hash || '').replace(/^#/, '');
  router.start();

  if (!NovelLLM.hasConfig()) {
    showToast('这本书可以先写；续写 / 润色要先配 API Key');
  }

  // 首启引导：只出现一次，且不再把人硬带去设置页 —— 没有 Key 也有一本
  // 示例书和全部本地能力，先让人看到产品最值钱的部分再谈 Key。
  try {
    if (!localStorage.getItem('nw_onboarded')) {
      localStorage.setItem('nw_onboarded', '1');
      if (enteredOn === '' || enteredOn === '/' || enteredOn === '/home') showOnboarding();
    }
  } catch (_) {}
}

/** 首启引导：三步讲清织文是什么、没 Key 能玩什么、Key 从哪来。 */
function showOnboarding() {
  if (document.getElementById('onboard-mask')) return;
  const mask = document.createElement('div');
  mask.id = 'onboard-mask';
  mask.className = 'onboard-mask';
  mask.innerHTML = `
    <div class="onboard-card">
      <div class="onboard-kicker">yu.ai · novelweave</div>
      <div class="onboard-title">先把设定织成网，再谈写作</div>
      <p class="onboard-sub">织文不替你写书 —— 它把角色、伏笔、时间线落成可校验的状态，让长篇写到几十章也不自相矛盾。</p>
      <div class="onboard-steps">
        <div class="onboard-step"><span class="onboard-num">壹</span><div><b>载入示例书</b><p>没有 Key 也能玩：状态矩阵、伏笔表、连续性检查全部本地跑，还能看到机检如何抓出人设矛盾。</p></div></div>
        <div class="onboard-step"><span class="onboard-num">贰</span><div><b>写作与自检</b><p>续写自动带上硬禁令与你自己的文风样例；生成后先过机器规则自检一轮，再交到你手里。</p></div></div>
        <div class="onboard-step"><span class="onboard-num">叁</span><div><b>配一个 Key</b><p>只有续写 / 润色需要。yu.ai 收录了各家免费额度，智谱 GLM-Flash、火山豆包日更额度都是零成本。</p></div></div>
      </div>
      <div class="onboard-actions">
        <button class="btn btn-primary" id="onboard-demo">先逛示例书</button>
        <button class="btn btn-secondary" id="onboard-key">去配置 Key</button>
        <button class="btn btn-secondary" id="onboard-skip">直接开始</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('#onboard-demo').onclick = () => { close(); loadDemoBook(); };
  mask.querySelector('#onboard-key').onclick = () => { close(); router.go('settings'); };
  mask.querySelector('#onboard-skip').onclick = close;
}

async function onPageEntered(page, params) {
  if (page === 'home') { await renderHomePage(); return; }
  if (page === 'settings') { await renderSettings(); return; }
  if (page === 'workspace') { await enterWorkspace(params); return; }
}

// ═══════════════════ 事件委托 ═══════════════════

const ACTIONS = {
  'go-home':       () => router.go('home'),
  'go-settings':   () => router.go('settings'),
  // 移动端 @media 把侧栏压成 max-width:0，没有 .open 的入口就等于手机上根本进不去
  'toggle-sidebar': () => document.getElementById('workspace-sidebar')?.classList.toggle('open'),
  'open-novel':    (id) => router.go('workspace', { novelId: id }),
  'del-novel':     (id) => confirmDeleteNovel(id),
  'create-novel':  () => showCreateNovel(),
  'ai-short-book': () => showAIShortWizard(),
  'ai-long-book': () => showAILongWizard(),
  'deconstruct': () => showDeconstruct(),
  'batch-generate': () => batchGenerateBook(),
  'load-demo':     () => loadDemoBook(),
  'open-chapter':  (id) => openChapterById(id),
  'del-chapter':   (id) => deleteCh(id),
  'add-chapter':   () => addChapter(),
  'edit-char':     (id) => editCharacter(id),
  'edit-world':    (id) => editWorldbuilding(id),
  'edit-note':     (id) => editNote(id),
  'edit-decision': (id) => editDecision(id),
  'edit-relation': (id) => editRelation(id),
  'save-chapter':  () => saveChapter(),
  'edit-cast':     () => showCastPanel(),
  'edit-summary':  () => showSummaryEditor(),
  'show-revisions': () => showRevisions(),
  'toggle-revision': (id, el) => toggleRevision(id, el),
  'restore-revision': (id) => restoreRevision(id),
  'run-ai':        (id, el) => runAIPanel(el.dataset.tool || id),
  'close-ai':      () => closeAIPanel(),
  'switch-tab':    (id, el) => switchTab(el.dataset.tab),
  'goto-settings': () => switchTab('settings'),
};

function wireDelegation() {
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    if (el.dataset.stop !== 'false') e.stopPropagation();
    fn(el.dataset.id, el);
  });
}

function bindEditorShortcuts() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveChapter();
    }
  });
  // 切走或关页面时把未保存的正文落库，避免丢掉最后一个 15 秒窗口
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && APP.dirty) saveChapter(null, true);
  });
}

// ═══════════════════ 通用 UI ═══════════════════

function showToast(msg, dur = 2200) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('visible'), dur);
}

function formatWordCount(n) {
  if (!n) return '0 字';
  if (n < 10000) return `${n} 字`;
  return `${(n / 10000).toFixed(1)} 万字`;
}

function closeModal() {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
}

function showModal(title, bodyHTML, onSave, onDelete) {
  closeModal();
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  o.innerHTML = `<div class="modal"><div class="modal-title"></div>${bodyHTML}
    <div class="modal-actions">
      ${onDelete ? '<button class="btn btn-danger" id="modal-del-btn">删除</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn btn-secondary" id="modal-cancel">${onSave ? '取消' : '关闭'}</button>
      ${onSave ? '<button class="btn btn-primary" id="modal-save">保存</button>' : ''}
    </div></div>`;
  // 标题可能是书名等用户数据，用 textContent 而不是拼进 HTML
  o.querySelector('.modal-title').textContent = title;
  document.body.appendChild(o);
  o.querySelector('#modal-cancel').onclick = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
  if (onDelete) o.querySelector('#modal-del-btn').onclick = onDelete;
  if (onSave) o.querySelector('#modal-save').onclick = onSave;
  return o;
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function emptyHint(text) {
  return `<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:14px;">${esc(text)}</div>`;
}

// ═══════════════════ 首页 ═══════════════════

// ═══════════════════ 每日问候与码字统计 ═══════════════════
// 「每日字数」口径:每章按天取当日最后一版快照的字数,与前一天比较,
// 增量记到当天 —— 快照只在覆盖式写入时产生,所以这是净增字数,不是击键数。

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function computeDailyStats() {
  const daily = new Map(); // 'YYYY-MM-DD' → 当日净增字数
  let totalWords = 0, totalChapters = 0;
  const novels = await NovelDB.novels.list();
  for (const n of novels) {
    totalWords += n.word_count || 0;
    totalChapters += n.chapter_count || 0;
    const chapters = await NovelDB.chapters.list(n.id);
    for (const ch of chapters) {
      const revs = (await NovelDB.revisions.list(ch.id)).slice().reverse(); // 旧 → 新
      const dayWords = new Map();
      for (const r of revs) dayWords.set(dayKey(r.at), r.word_count ?? countWords(r.content));
      dayWords.set(dayKey(Date.now()), countWords(ch.content)); // 今天以编辑器当前内容为准
      let prev = 0;
      for (const day of [...dayWords.keys()].sort()) {
        const w = dayWords.get(day) || 0;
        daily.set(day, (daily.get(day) || 0) + Math.max(0, w - prev));
        prev = w;
      }
    }
  }
  return { daily, totalWords, totalChapters };
}

function streakFrom(daily) {
  let streak = 0;
  const d = new Date();
  if (!daily.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1); // 今天没写也不断更
  for (;;) {
    if ((daily.get(dayKey(d.getTime())) || 0) > 0) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

async function renderHomeStats() {
  const host = document.getElementById('home-stats');
  if (!host) return { todayWords: 0, streak: 0 };
  try {
    const { daily, totalWords, totalChapters } = await computeDailyStats();
    const todayWords = daily.get(dayKey(Date.now())) || 0;
    const streak = streakFrom(daily);
    host.innerHTML = `<span>今日 <b>${todayWords}</b> 字</span>`
      + `<span>连续更文 <b>${streak}</b> 天</span>`
      + `<span>共 <b>${totalChapters}</b> 章 · ${formatWordCount(totalWords)}</span>`;
    host.classList.toggle('is-empty', totalWords === 0 && totalChapters === 0);
    return { todayWords, streak };
  } catch (_) { return { todayWords: 0, streak: 0 }; }
}

const GREETINGS = [
  ['早上好', ['雾还没散，正好写字。', '三千阶，也是一步一步上去的。', '把昨天的那一段，先改顺。']],
  ['下午好', ['写不动的时候，就去改一段旧文。', '灯比星子密的日子，还在后头。', '今天的目标，可以先是一段。']],
  ['晚上好', ['夜深了，正好织字。', '今天的账，落笔就算数。', '写完这一段，就睡。']],
];

/** 每日问候:一天一次,带当日码字数。 */
function maybeDailyGreeting(todayWords, streak) {
  try {
    const today = dayKey(Date.now());
    if (localStorage.getItem('nw_greet') === today) return;
    localStorage.setItem('nw_greet', today);
    const h = new Date().getHours();
    const [label, lines] = h < 11 ? GREETINGS[0] : h < 18 ? GREETINGS[1] : GREETINGS[2];
    const line = lines[Math.floor(Math.random() * lines.length)];
    const stat = todayWords > 0 ? `今日已写 ${todayWords} 字${streak > 1 ? `，连续 ${streak} 天` : ''}。` : '';
    showToast(`${label}。${line}${stat ? ' ' + stat : ''}`);
  } catch (_) {}
}

async function renderHomePage() {
  const novels = await NovelDB.novels.list();
  const listEl = document.getElementById('novel-list');
  const emptyEl = document.getElementById('home-empty');
  if (!listEl) return;

  if (!novels.length) {
    if (emptyEl) emptyEl.style.display = '';
    listEl.innerHTML = '';
    renderHomeStats(); // 无书也要刷新统计条(空态隐藏),否则残留上一本的数字
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // 每日统计条 + 一天一次的问候(带今日码字数)
  renderHomeStats().then((st) => maybeDailyGreeting(st.todayWords, st.streak));

  // static HTML 骨架，所有动态值经 esc
  listEl.innerHTML = novels.map((n) => {
    const d = n.updated_at ? new Date(n.updated_at).toLocaleDateString('zh-CN') : '';
    const isDemo = typeof NWDemo !== 'undefined' && NWDemo.isDemo(n.id);
    // 书封：书名竖排上封面，短篇在书脊下加一枚小圆点以示区分
    const titleForCover = (n.title || '未命名').replace(/^《|》$/g, '');
    const coverTitle = titleForCover.slice(0, 6);
    return `<div class="novel-card" data-action="open-novel" data-id="${attr(n.id)}">
      <div class="novel-card-cover${n.format === 'short' ? ' short' : ''}" aria-hidden="true"><span>${esc(coverTitle)}</span></div>
      <div class="novel-card-body">
      <div class="novel-card-actions">
        <button class="del-btn" data-action="del-novel" data-id="${attr(n.id)}" title="删除作品">${icon('trash')}</button>
      </div>
      ${isDemo ? '<span class="novel-card-badge">示例</span>' : ''}
      ${(typeof NWDemo !== 'undefined' && isDemo && (n.demo_version || 0) < ((window.NWDemo && NWDemo.DEMO_VERSION) || 4))
        ? '<span class="novel-card-upgrade" data-action="load-demo" title="载入最新版示例书">内容已升级 · 点击更新</span>'
        : ''}
      <div class="novel-card-title">${esc(n.title)}</div>
      <div class="novel-card-meta">
        <span>${esc(n.genre)}</span>
        <span>${n.chapter_count || 0} 章</span>
        <span>${formatWordCount(n.word_count)}</span>
        ${n.format === 'short' ? '<span>短篇</span>' : ''}
        <span>${esc(d)}</span>
      </div>
      </div>
    </div>`;
  }).join('');
}

async function loadDemoBook() {
  try {
    const id = await NWDemo.seed();
    router.go('workspace', { novelId: id });
  } catch (e) {
    showToast('载入示例失败：' + e.message);
  }
}

function showCreateNovel() {
  const genres = ['玄幻','都市','仙侠','科幻','历史','武侠','奇幻','现实','悬疑','轻小说','同人','游戏'];
  showModal('创建新作品', `
    <div class="settings-field"><label class="settings-label">作品名称</label>
      <input class="settings-input" id="inp-novel-title" placeholder="输入小说名字" maxlength="50"></div>
    <div class="settings-field"><label class="settings-label">织物规格</label>
      <select class="settings-select" id="inp-novel-format">
        <option value="long">长篇连载 —— 卷 / 时间线 / 状态矩阵 / 滚动前情</option>
        <option value="short">短篇 —— 几千至三万字，上下文全量注入，机检更密</option>
      </select></div>
    <div class="settings-field"><label class="settings-label">类型</label>
      <select class="settings-select" id="inp-novel-genre">
        ${genres.map((g) => `<option value="${attr(g)}">${esc(g)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">概述（可选）</label>
      <textarea class="settings-input" id="inp-novel-desc" rows="2" placeholder="一句话简介"></textarea></div>
  `, async () => {
    const title = val('inp-novel-title');
    if (!title) { showToast('请输入作品名称'); return; }
    const novel = await NovelDB.novels.create({
      title,
      genre: val('inp-novel-genre') || '玄幻',
      description: val('inp-novel-desc'),
      format: val('inp-novel-format'),
    });
    closeModal();
    showToast(`「${title}」已创建`);
    await renderHomePage();
    router.go('workspace', { novelId: novel.id });
  });
  setTimeout(() => document.getElementById('inp-novel-title')?.focus(), 60);
}

// ═══════════════════ AI 起书（短篇从零向导） ═══════════════════
// 想法 → 结构化梗概（每项可直接改）→ 建档落盘。建的是骨架不是成品：
// 正文由作者逐章「续写」产出（自带硬禁令 / 风格样例 / 机检自检）。
// 结构流派与篇幅档口径同 short-presets.json 模板。

function showAIShortWizard() {
  if (!NovelLLM.hasConfig()) {
    showToast('AI 起书要先配 API Key（状态管理与连续性检查不需要）');
    router.go('settings');
    return;
  }
  const structures = NovelLLM.SHORT_STRUCTURES;
  const tiers = NovelLLM.SHORT_TIERS;
  const genres = ['不限','玄幻','都市','仙侠','科幻','悬疑','言情','脑洞','现实','历史'];
  showModal('AI 起书 · 短篇', `
    <div class="settings-field"><label class="settings-label">一句话想法 *</label>
      <textarea class="settings-input" id="inp-ai-idea" rows="3" placeholder="例：外卖员发现自己送的第 43 单，收货地址是二十年前自己家。"></textarea></div>
    <div class="settings-field"><label class="settings-label">结构流派</label>
      <select class="settings-select" id="inp-ai-structure">
        ${structures.map((s) => `<option value="${attr(s)}">${esc(s)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">篇幅档</label>
      <select class="settings-select" id="inp-ai-tier">
        ${tiers.map((t) => `<option value="${attr(t)}">${esc(t)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">题材</label>
      <select class="settings-select" id="inp-ai-genre">
        ${genres.map((g) => `<option value="${attr(g)}">${esc(g)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><button class="btn btn-primary" id="ai-gen-btn" style="width:100%">生成梗概（约 10 秒）</button></div>
  `, null);
  document.getElementById('modal-cancel').textContent = '关闭';
  document.getElementById('ai-gen-btn').onclick = async function () {
    const idea = document.getElementById('inp-ai-idea').value.trim();
    if (!idea) { showToast('先写一句话想法'); return; }
    this.disabled = true;
    this.textContent = '生成中…';
    const res = await NovelLLM.requestChat([
      { role: 'system', content: '你是资深短篇网文编辑，只输出 JSON。' },
      { role: 'user', content: NovelLLM.buildShortConceptPrompt({
          idea,
          genre: document.getElementById('inp-ai-genre').value,
          structure: document.getElementById('inp-ai-structure').value,
          tier: document.getElementById('inp-ai-tier').value,
        }) },
    ], { maxTokens: 3000 });
    this.disabled = false;
    this.textContent = '生成梗概（约 10 秒）';
    if (res.error) { showToast('生成失败：' + res.error); return; }
    let concept;
    try { concept = NovelLLM.parseConceptJSON(res.content); }
    catch (e) { showToast('解析失败：' + e.message); return; }
    closeModal();
    const platformSel = document.getElementById('inp-ai-platform');
    const targetWords = Number(platformSel?.selectedOptions[0]?.dataset.words || 0) || null;
    showConceptConfirm(concept, document.getElementById('inp-ai-genre').value, targetWords);
  };
  // 平台联动篇幅档:6k→微型,2 万→标准,5 万→大短篇
  document.getElementById('inp-ai-platform').onchange = function () {
    const words = Number(this.selectedOptions[0]?.dataset.words || 0);
    const tierSel = document.getElementById('inp-ai-tier');
    if (!words || !tierSel) return;
    const idx = words <= 6000 ? 0 : words <= 15000 ? 1 : 2;
    if (tiers[idx]) tierSel.selectedIndex = idx;
  };
  setTimeout(() => document.getElementById('inp-ai-idea')?.focus(), 60);
}

/** 梗概确认：书名 / 一句话 / 章节（标题|拍点，一行一章）/ 人物（名字|角色|性格），全部可直接改。 */
function showConceptConfirm(concept, genre, targetWords = null) {
  const chText = concept.chapters.map((c) => `${c.title}|${c.beat}`).join('\n') || '开篇|第一屏就立住钩子';
  const peText = concept.characters.map((c) => `${c.name}|${c.role}|${c.personality}`).join('\n');
  showModal('确认梗概 —— 每一项都可以改', `
    <div class="settings-field"><label class="settings-label">书名</label>
      <input class="settings-input" id="inp-c-title" value="${attr(concept.title)}" maxlength="50"></div>
    <div class="settings-field"><label class="settings-label">一句话梗概</label>
      <textarea class="settings-input" id="inp-c-logline" rows="2">${esc(concept.logline)}</textarea></div>
    <div class="settings-field"><label class="settings-label">章节（一行一章：标题|拍点与章末钩子）</label>
      <textarea class="settings-input" id="inp-c-chapters" rows="8">${esc(chText)}</textarea></div>
    <div class="settings-field"><label class="settings-label">人物（一行一个：名字|角色|性格）</label>
      <textarea class="settings-input" id="inp-c-chars" rows="4">${esc(peText)}</textarea></div>
    <p class="usage-bar" style="margin-top:8px;">保存即建档：书 + 角色 + 空章节。正文由你逐章「续写」产出，生成完自动过机检。</p>
  `, async () => {
    const title = val('inp-c-title');
    if (!title) { showToast('书名不能为空'); return; }
    const chapters = document.getElementById('inp-c-chapters').value.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l, i) => { const [t, b] = l.split('|'); return { title: (t || `第${i + 1}章`).trim(), beat: (b || '').trim() }; });
    if (!chapters.length) { showToast('至少要有一章'); return; }
    const chars = document.getElementById('inp-c-chars').value.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => { const [name, role, personality] = l.split('|'); return { name: (name || '').trim(), role: (role || '配角').trim(), personality: (personality || '').trim() }; })
      .filter((c) => c.name);
    const novel = await NovelDB.novels.create({
      title, genre: genre === '不限' ? '短篇' : genre,
      description: document.getElementById('inp-c-logline').value.trim(), format: 'short', targetWords,
    });
    for (const c of chars) await NovelDB.characters.create(novel.id, c);
    for (let i = 0; i < chapters.length; i++) {
      await NovelDB.chapters.create(novel.id, { title: chapters[i].title, summary: chapters[i].beat, order: i + 1 });
    }
    closeModal();
    showToast(`梗概已建档：${chapters.length} 章。进第一章点「续写」即可成稿。`);
    await renderHomePage();
    router.go('workspace', { novelId: novel.id });
    // 向导的收尾一步：建档即问要不要连续生成（可停，不是无确认直出）
    if (confirm(`梗概已建档。\n\n立即连续生成全部 ${chapters.length} 章正文？\n每章自动过机检并自修一轮，过程中可随时停止，已完成的章节不受影响。`)) {
      await batchGenerateBook(novel.id);
    }
  });
}

// ═══════════════════ AI 起书（长篇从零向导 · 卷纲层） ═══════════════════
// 长篇骨架 = 人物 + 世界设定 + 卷纲 + 首卷章纲。卷纲写进「写作笔记」，
// 世界设定进 worldbuilding，章纲落章节拍点 —— 全部走既有存储，不发明新格式。


// ═══════════════════ 拆书(结构模式逆向) ═══════════════════
// 学星月 AI 拆书:粘贴/导入已有文本 → LLM 抽取结构模式(金手指/爽点节拍/伏笔密度/钩子分布)
// → 产物存入当前书的「写作笔记」(模式名+拍点序列),供起书向导与章纲生成引用。
// 版权安全:只提取模式,不复制表达;文本不落盘。

function showDeconstruct() {
  if (!NovelLLM.hasConfig()) {
    showToast('拆书要先配 API Key');
    router.go('settings');
    return;
  }
  showModal('拆书 · 结构模式逆向', `
    <div class="settings-field"><label class="settings-label">粘贴要拆解的文本 *</label>
      <textarea class="settings-input" id="inp-dec-text" rows="10" placeholder="粘贴一章或若干章正文（建议整章，3000 字以上效果最好）"></textarea></div>
    <div class="settings-field"><label class="settings-label">来源标注（存入笔记用，可选）</label>
      <input class="settings-input" id="inp-dec-src" placeholder="例：《某某某》第 1-3 章" maxlength="40"></div>
    <div class="settings-field"><button class="btn btn-primary" id="dec-run" style="width:100%">抽取结构模式（约 15 秒）</button></div>
    <div class="settings-hint">只提取结构模式（金手指/爽点节拍/伏笔密度/钩子类型），不复制文字表达。</div>
  `, null);
  document.getElementById('modal-cancel').textContent = '关闭';
  document.getElementById('dec-run').onclick = async function () {
    const text = document.getElementById('inp-dec-text').value.trim();
    if (text.length < 500) { showToast('文本太短，建议至少 500 字'); return; }
    this.disabled = true;
    this.textContent = '拆解中…';
    const t0 = Date.now();
    const res = await NovelLLM.requestChat([
      { role: 'system', content: '你是资深网文结构编辑，只输出 JSON。' },
      { role: 'user', content: NovelLLM.buildDeconstructPrompt(text, { source: document.getElementById('inp-dec-src').value.trim(), words: String(text.length) }) },
    ], { maxTokens: 2500 });
    this.disabled = false;
    this.textContent = '抽取结构模式（约 15 秒）';
    if (res.error) { showToast('拆解失败：' + res.error); return; }
    let pat;
    try { pat = NovelLLM.parseDeconstructJSON(res.content); }
    catch (e) { showToast('解析失败：' + e.message); return; }
    try {
      if (APP.novelId) NovelDB.usage.record(APP.novelId, { tool: 'deconstruct', charsIn: text.length, charsOut: res.content.length, durationMs: Date.now() - t0 });
    } catch (_) {}
    closeModal();
    // 结果落进「写作笔记」,作者可编辑可删
    const note = [
      '【模式名】' + pat.name,
      pat.goldenFinger ? '【金手指】' + pat.goldenFinger : '',
      '【拍点序列】',
      ...pat.beats.map((b) => '- ' + b.at + '（' + b.type + '）：' + b.note),
      pat.foreshadowDensity ? '【伏笔密度】' + pat.foreshadowDensity : '',
      pat.hookTypes.length ? '【钩子类型】' + pat.hookTypes.join('、') : '',
      '【适用】' + pat.summary,
    ].filter(Boolean).join('\n');
    if (!APP.novel) {
      showToast('已拆解。先创建或进入一本书，再拆可自动存入笔记');
      await navigator.clipboard?.writeText(note).catch(() => {});
      showToast('结构模式已复制到剪贴板');
      return;
    }
    await NovelDB.notes.save(APP.novel.id, { title: '拆书：' + pat.name, content: note, tags: ['拆书'] });
    showToast('结构模式已存入「写作笔记」');
  };
  setTimeout(() => document.getElementById('inp-dec-text')?.focus(), 60);
}

function showAILongWizard() {
  if (!NovelLLM.hasConfig()) {
    showToast('AI 起书要先配 API Key（状态管理与连续性检查不需要）');
    router.go('settings');
    return;
  }
  const volumes = NovelLLM.LONG_VOLUME_OPTIONS;
  const genres = ['不限','玄幻','都市','仙侠','科幻','悬疑','言情','历史','脑洞','现实'];
  showModal('AI 起书 · 长篇', `
    <div class="settings-field"><label class="settings-label">一句话想法 *</label>
      <textarea class="settings-input" id="inp-ai-idea-l" rows="3" placeholder="例：扫地的少年每天给一座无面石像上香，直到石像流出了眼泪。"></textarea></div>
    <div class="settings-field"><label class="settings-label">计划卷数</label>
      <select class="settings-select" id="inp-ai-vol">
        ${volumes.map((v) => `<option value="${attr(String(v))}" ${v === 3 ? 'selected' : ''}>约 ${v} 卷</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">题材</label>
      <select class="settings-select" id="inp-ai-genre-l">
        ${genres.map((g) => `<option value="${attr(g)}">${esc(g)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><button class="btn btn-primary" id="ai-gen-btn-l" style="width:100%">生成全书骨架（约 20 秒）</button></div>
  `, null);
  document.getElementById('modal-cancel').textContent = '关闭';
  document.getElementById('ai-gen-btn-l').onclick = async function () {
    const idea = document.getElementById('inp-ai-idea-l').value.trim();
    if (!idea) { showToast('先写一句话想法'); return; }
    this.disabled = true;
    this.textContent = '生成中…（长篇骨架较大）';
    const res = await NovelLLM.requestChat([
      { role: 'system', content: '你是资深网文策划编辑，只输出 JSON。' },
      { role: 'user', content: NovelLLM.buildLongConceptPrompt({
          idea,
          genre: document.getElementById('inp-ai-genre-l').value,
          volumes: Number(document.getElementById('inp-ai-vol').value) || 3,
        }) },
    ], { maxTokens: 4000 });
    this.disabled = false;
    this.textContent = '生成全书骨架（约 20 秒）';
    if (res.error) { showToast('生成失败：' + res.error); return; }
    let concept;
    try { concept = NovelLLM.parseConceptJSON(res.content); }
    catch (e) { showToast('解析失败：' + e.message); return; }
    closeModal();
    showLongConceptConfirm(concept, document.getElementById('inp-ai-genre-l').value);
  };
  setTimeout(() => document.getElementById('inp-ai-idea-l')?.focus(), 60);
}

/** 长篇骨架确认：书名 / 梗概 / 人物 / 世界设定 / 卷纲 / 首卷章纲，全部可直接改。 */
function showLongConceptConfirm(concept, genre) {
  const chText = concept.chapters.map((c) => `${c.title}|${c.beat}`).join('\n') || '第一章|主角以动作或抉择出场，章末留钩子';
  const wText = concept.world.map((w) => `${w.name}|${w.content}`).join('\n');
  const vText = concept.volumes.map((v) => `${v.title}|${v.summary}`).join('\n');
  const peText = concept.characters.map((c) => `${c.name}|${c.role}|${c.personality}`).join('\n');
  showModal('确认长篇骨架 —— 每一项都可以改', `
    <div class="settings-field"><label class="settings-label">书名</label>
      <input class="settings-input" id="inp-c-title" value="${attr(concept.title)}" maxlength="50"></div>
    <div class="settings-field"><label class="settings-label">一句话梗概</label>
      <textarea class="settings-input" id="inp-c-logline" rows="2">${esc(concept.logline)}</textarea></div>
    <div class="settings-field"><label class="settings-label">人物（名字|角色|性格）</label>
      <textarea class="settings-input" id="inp-c-chars" rows="4">${esc(peText)}</textarea></div>
    <div class="settings-field"><label class="settings-label">世界设定（一行一条：名称|内容）</label>
      <textarea class="settings-input" id="inp-c-world" rows="3">${esc(wText)}</textarea></div>
    <div class="settings-field"><label class="settings-label">卷纲（一行一卷：卷名|核心冲突与结局）</label>
      <textarea class="settings-input" id="inp-c-vols" rows="3">${esc(vText)}</textarea></div>
    <div class="settings-field"><label class="settings-label">第一卷章纲（标题|拍点与章末钩子）</label>
      <textarea class="settings-input" id="inp-c-chapters" rows="8">${esc(chText)}</textarea></div>
    <p class="usage-bar" style="margin-top:8px;">保存即建档：书 + 角色 + 世界设定 + 卷纲（写入写作笔记）+ 带拍点的空章节。正文由你逐章「续写」产出。</p>
  `, async () => {
    const title = val('inp-c-title');
    if (!title) { showToast('书名不能为空'); return; }
    const parseLines = (id) => document.getElementById(id).value.split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => { const [a, ...rest] = l.split('|'); return { a: (a || '').trim(), b: rest.join('|').trim() }; });
    const chapters = parseLines('inp-c-chapters').filter((c) => c.a);
    if (!chapters.length) { showToast('至少要有一章'); return; }
    const novel = await NovelDB.novels.create({
      title, genre: genre === '不限' ? '长篇' : genre,
      description: document.getElementById('inp-c-logline').value.trim(), format: 'long',
    });
    for (const c of parseLines('inp-c-chars')) {
      if (!c.a) continue;
      const [name, role, personality] = c.a.split('|');
      await NovelDB.characters.create(novel.id, { name: (name || '').trim(), role: (role || '配角').trim(), personality: (personality || '').trim() });
    }
    for (const w of parseLines('inp-c-world')) {
      if (!w.a) continue;
      await NovelDB.worldbuilding.create(novel.id, { name: w.a, type: 'custom', description: w.b });
    }
    const vols = parseLines('inp-c-vols').filter((v) => v.a);
    if (vols.length) {
      await NovelDB.notes.save(novel.id, { title: '卷纲', content: vols.map((v) => `【${v.a}】${v.b}`).join('\n') });
    }
    for (let i = 0; i < chapters.length; i++) {
      await NovelDB.chapters.create(novel.id, { title: chapters[i].a, summary: chapters[i].b, order: i + 1 });
    }
    closeModal();
    showToast(`长篇骨架已建档：${chapters.length} 章。逐章「续写」即可成稿。`);
    await renderHomePage();
    router.go('workspace', { novelId: novel.id });
    if (confirm(`立即连续生成已建档的 ${chapters.length} 章正文？每章自动过机检，可随时停止。`)) await batchGenerateBook(novel.id);
  });
}

// ═══════════════════ 连续生成（短/长篇 · 逐章自动续写 + 机检自检） ═══════════════════
// 梗概建档后的收尾一步：一键逐章成稿。每一章都是完整的续写管道
// （硬禁令 + 上下文 → 生成 → 机检自检 → 修订），可随时停止 —— 停在哪一章，
// 哪一章都合法；只生成空章节，已有正文的一律不碰。

async function batchGenerateBook(novelId) {
  if (!NovelLLM.hasConfig()) { showToast('连续生成要先配 API Key'); router.go('settings'); return; }
  // 向导建档后立刻调用时,enterWorkspace 可能还没跑完 —— 等工作区真正切到这本书再动手,
  // 否则 loadStoryCtx 读到的会是上一本书,新章节会被生成到错误的上下文里。
  const targetId = novelId || APP.novelId;
  let waited = 0;
  while (APP.novelId !== targetId && waited < 2000) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  if (APP.novelId !== targetId) { showToast('工作区未就绪，请稍后在书内点「连续生成正文」'); return; }
  APP.chaptersCache = null; // 等待期间可能残留上一本书的章列表,强制重读
  const all = APP.chaptersCache && APP.chaptersCache.length ? APP.chaptersCache : (await NovelDB.chapters.list(APP.novelId));
  const pending = all.filter((c) => !(c.body || '').trim());
  if (!pending.length) { showToast('没有待生成的空章节'); return; }
  // 成本预估(保守:每章输入约 12KB 上下文 + 输出至多 8k tokens)
  const estIn = pending.length * 12, estOut = pending.length * 8; // 单位 KB
  const estNote = getEmbedConfig() ? '（含语义检索 embedding 调用）' : '';
  if (!confirm(`将按顺序逐章生成 ${pending.length} 章正文。\n预估消耗：输入约 ${estIn}KB + 输出约 ${estOut}KB tokens${estNote}。\n每章自动过机检并自修一轮；可随时点「停止」，已有正文的章节一律不碰。\n\n继续？`)) return;

  APP.batchAbort = new AbortController();
  const mask = document.createElement('div');
  mask.id = 'batch-mask';
  mask.className = 'onboard-mask';
  const card = document.createElement('div');
  card.className = 'onboard-card';
  card.innerHTML = `<div class="onboard-kicker">batch · 连续生成</div>
    <div class="onboard-title">逐章成稿中</div>
    <div class="onboard-steps" id="batch-list"></div>
    <div class="onboard-actions"><button class="btn btn-danger" id="batch-stop">停止</button></div>`;
  mask.appendChild(card);
  document.body.appendChild(mask);
  const list = card.querySelector('#batch-list');
  const row = (ch, state, note) => {
    let el = list.querySelector(`[data-batch="${ch.id}"]`);
    if (!el) { el = document.createElement('div'); el.className = 'onboard-step'; el.dataset.batch = ch.id; list.appendChild(el); }
    el.innerHTML = `<span class="onboard-num">${ch.order ?? ''}</span><div><b>${esc(ch.title)}</b><p>${esc(state)}${note ? ' · ' + esc(note) : ''}</p></div>`;
  };
  card.querySelector('#batch-stop').onclick = () => APP.batchAbort.abort();

  let done = 0, fixed = 0;
  for (const ch of pending) {
    if (APP.batchAbort.signal.aborted) { row(ch, '已停止'); break; }
    try {
      row(ch, '生成中…');
      const storyCtx = await loadStoryCtx();
      const built = NovelLLM.buildContinueContext({ ctx: storyCtx, chapterId: ch.id, style: true });
      let full = '';
      for await (const msg of NovelLLM.streamChat([
          { role: 'system', content: '你是一名经验丰富的中文网文作家，负责在既有设定与前文之下续写。' },
          { role: 'user', content: built.prompt },
        ], { maxTokens: 8000, signal: APP.batchAbort.signal })) {
        if (msg.type === 'chunk') full += msg.content;
        else if (msg.type === 'error') throw new Error(msg.content);
        else if (msg.type === 'aborted') break;
      }
      if (!full.trim()) { row(ch, '模型没有返回内容，已停止'); break; }

      // 机检自检一轮：只修草稿新引入的问题（基线外），info 不触发
      let reviseRounds = 0;
      const sc = NWSelfCheck.runSelfCheck(storyCtx, { chapterId: ch.id, draft: full });
      if (sc.actionable.length) {
        row(ch, `机检发现 ${sc.actionable.length} 处问题，自修中…`);
        const revised = await NovelLLM.requestChat([
          { role: 'system', content: '你是中文小说编辑，只消除连续性矛盾，不改其他内容。' },
          { role: 'user', content: NWSelfCheck.buildRevisePrompt(full, sc.actionable) },
        ], { maxTokens: 8000, signal: APP.batchAbort.signal });
        if (revised && revised.content && revised.content.trim()) { full = revised.content.trim(); reviseRounds = 1; }
      }
      if (APP.batchAbort.signal.aborted) { row(ch, '已停止（本章未保存）'); break; }
      await NovelDB.chapters.update(ch.id, { content: full });
      APP.chaptersCache = null; // 让下一章的 loadStoryCtx 读到刚落盘的正文
      done++; if (reviseRounds) fixed++;
      row(ch, `完成 ${countWords(full)} 字`, reviseRounds ? '自修 1 轮' : '');
    } catch (e) {
      if (APP.batchAbort.signal.aborted) { row(ch, '已停止'); break; }
      row(ch, '失败：' + (e.message || '未知错误') + '（已停止，不烧额度）');
      break;
    }
  }
  APP.batchAbort = null;
  const footer = document.createElement('div');
  footer.className = 'onboard-actions';
  const remaining = (await NovelDB.chapters.list(APP.novelId)).filter((c) => !(c.body || '').trim()).length;
  footer.innerHTML = `<button class="btn btn-primary" id="batch-done">完成（${done}/${pending.length} 章${fixed ? `，${fixed} 章自修` : ''}）</button>`
    + (remaining && !APP.batchAbort?.signal?.aborted === false || remaining ? ` <button class="btn btn-secondary" id="batch-continue">续跑剩余 ${remaining} 章</button>` : '');
  card.querySelector('.onboard-actions').replaceWith(footer);
  const contBtn = footer.querySelector('#batch-continue');
  if (contBtn) contBtn.onclick = async () => { mask.remove(); await batchGenerateBook(APP.novelId); };
  footer.querySelector('#batch-done').onclick = async () => {
    mask.remove();
    try { await NovelDB.recountNovelStats(APP.novelId); } catch (_) {}
    await renderSidebar();
    const firstEmpty = (await NovelDB.chapters.list(APP.novelId)).find((c) => !(c.body || '').trim());
    if (firstEmpty) await openChapterById(firstEmpty.id);
  };
}

async function confirmDeleteNovel(id) {
  const novel = await NovelDB.novels.get(id);
  if (!novel) { showToast('作品不存在'); return; }
  if (!confirm(`确定删除「${novel.title}」？所有章节、角色、设定将永久丢失。`)) return;
  if (!confirm('最后确认：真的要删除吗？此操作不可撤销。')) return;
  await NovelDB.novels.delete(id);
  showToast(`「${novel.title}」已删除`);
  await renderHomePage();
}

// ═══════════════════ 工作区 ═══════════════════

async function enterWorkspace(params) {
  const novelId = params.novelId;
  const novel = novelId ? await NovelDB.novels.get(novelId) : null;
  if (!novel) {
    showToast('作品不存在，可能已被删除');
    router.replace('home', {});
    return;
  }

  // 换书时必须清空上一章状态，否则会把 A 书的正文显示并保存到 B 书里
  const switched = APP.novelId !== novelId;
  if (switched) {
    stopAutoSave();
    await flushPendingSave();
    APP.novelId = novelId;
    APP.chapter = null;
    APP.activeTab = 'chapters';
    APP.dirty = false;
  }
  APP.novel = novel;

  const chapters = await NovelDB.chapters.list(novelId);
  APP.chaptersCache = chapters;
  let target = params.chapterId ? chapters.find((c) => c.id === params.chapterId) : null;
  if (!target && !params.chapterId) target = chapters[0] || null;
  if (!target && params.chapterId) {
    // URL 里的章节 id 已失效（被删了），回落到第一章而不是留在空编辑器
    target = chapters[0] || null;
    showToast('该章节已不存在');
  }

  await renderSidebar();
  await renderSidebarPanel();
  if (target) await openChapter(target);
  else showEditorEmpty();
}

async function renderSidebar() {
  if (!APP.novelId) return;
  // 统计量由数据层重算，快照在这里统一回读；否则侧栏会一直显示进入工作区时的旧字数
  APP.novel = (await NovelDB.novels.get(APP.novelId)) || APP.novel;
  const novel = APP.novel;
  if (!novel) return;
  const counts = {
    chapters: (await NovelDB.chapters.list(novel.id)).length,
    characters: (await NovelDB.characters.list(novel.id)).length,
    world: (await NovelDB.worldbuilding.list(novel.id)).length,
    promises: (await NovelDB.promises.list(novel.id)).filter((p) => ['planned', 'planted'].includes(p.status)).length,
    notes: (await NovelDB.notes.list(novel.id)).length,
  };

  document.getElementById('sidebar-nav').innerHTML = `
    <div style="padding:12px; border-bottom:1px solid var(--border);">
      <button class="sidebar-back" data-action="go-home">${icon('back')}<span>返回</span></button>
      <div style="margin-top:6px; display:flex; align-items:center; gap:8px; font-size:14px; color:var(--text-primary); font-family:Georgia,serif; font-weight:600;">
        <img src="icons/icon-192.png" style="width:16px;height:16px;display:block" alt="">${esc(novel.title)}
      </div>
      <div style="margin-top:2px; font-size:12px; color:var(--text-secondary);">${counts.chapters} 章 · ${formatWordCount(novel.word_count)}</div>
    </div>
    <div style="padding:8px;">
      ${(novel.format === 'short'
        ? // 短篇收敛：时间线/状态矩阵是长篇的重型机械，短篇面板里折叠掉（数据仍在，导出照带）
          TABS.filter((t) => t.id !== 'timeline' && t.id !== 'states')
        : TABS
      ).map((t) => `
        <div class="sidebar-nav-item ${APP.activeTab === t.id ? 'active' : ''}" data-action="switch-tab" data-tab="${attr(t.id)}">
          <span class="sidebar-nav-icon">${icon(t.icon)}</span><span class="sidebar-nav-label">${esc(t.label)}</span>
          ${counts[t.id] != null ? `<span class="sidebar-nav-count">${counts[t.id]}</span>` : ''}
          ${t.hasAdd ? `<span class="sidebar-nav-add" data-action="${attr('nav-add-' + t.id)}" title="${attr(t.addTitle)}">${icon('plus')}</span>` : ''}
        </div>`).join('')}
      ${novel.format === 'short' && novel.target_words ? `
      <div class="target-progress" title="按汉字计，不含标点">
        <div class="target-progress-bar"><span style="width:${Math.min(100, Math.round((novel.word_count || 0) / novel.target_words * 100))}%"></span></div>
        <div class="target-progress-text">${formatWordCount(novel.word_count || 0)} / ${formatWordCount(novel.target_words)}${(novel.word_count || 0) >= novel.target_words ? ' · 已达标' : ''}</div>
      </div>` : ''}
      ${novel.format === 'short' ? `
      <div style="padding:10px 4px 2px;">
        <button class="btn btn-secondary" style="width:100%;font-size:12px;" data-action="batch-generate">连续生成正文</button>
      </div>` : ''}
    </div>`;
}

const ADD_ACTIONS = {
  'nav-add-chapters': () => addChapter(),
  'nav-add-characters': () => showCreateCharacter(),
  'nav-add-world': () => showCreateWorldbuilding(),
  'nav-add-promises': () => showCreatePromise(),
  'nav-add-timeline': () => showCreateAnchor(),
  'nav-add-notes': () => showCreateNote(),
  'nav-add-decisions': () => showCreateDecision(),
  'nav-add-relations': () => showCreateRelation(),
};
Object.assign(ACTIONS, ADD_ACTIONS);
Object.assign(ACTIONS, {
  'edit-promise':    (id) => editPromise(id),
  'del-promise':     (id) => removePromise(id),
  'edit-anchor':     (id) => editAnchor(id),
  'edit-state':      (id, el) => showStateEditor(el.dataset.chapter, el.dataset.entity),
  'jump-diag':       (id, el) => jumpToEvidence(el.dataset.chapter, el.dataset.start, el.dataset.len),
  'suppress-diag':   (id, el) => suppressDiagnostic(el.dataset.fp, el),
  'rerun-continuity': () => renderSidebarPanel(),
});

/** 侧栏面板分派表。旧版定义了四个列表函数却从不调用，导致四个 tab 永远空白。 */
const SIDEBAR_VIEWS = {
  chapters: renderChapterList,
  characters: showCharacterList,
  world: showWorldList,
  promises: showPromiseList,
  timeline: showTimelineList,
  states: showStatesPanel,
  continuity: showContinuity,
  decisions: showDecisionList,
  relations: showRelationList,
  notes: showNotesList,
  settings: renderWorkspaceSettings,
};

async function switchTab(tab) {
  if (!SIDEBAR_VIEWS[tab]) tab = 'chapters';
  APP.activeTab = tab;
  await renderSidebar();
  await renderSidebarPanel();
}

async function renderSidebarPanel() {
  const host = document.getElementById('sidebar-content');
  if (!host) return;
  host.dataset.tab = APP.activeTab;
  host.innerHTML = '';
  await (SIDEBAR_VIEWS[APP.activeTab] || renderChapterList)(host);
}

// ═══════════════════ 章节列表 ═══════════════════

async function renderChapterList(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  // 用户正在看别的 tab 时不要抢占侧栏容器
  if (host.id === 'sidebar-content' && host.dataset.tab && host.dataset.tab !== 'chapters') return;
  const chapters = await NovelDB.chapters.list(APP.novel.id);

  if (!chapters.length) {
    host.innerHTML = emptyHint('点击 + 创建第一章');
    return;
  }
  // 只放 id，正文留在 IndexedDB
  host.innerHTML = `<div class="chapter-list">
    ${chapters.map((ch) => `
      <div class="chapter-item ${APP.chapter?.id === ch.id ? 'active' : ''}" data-action="open-chapter" data-id="${attr(ch.id)}">
        <span class="chapter-item-number">${ch.order ?? '-'}</span>
        <span class="chapter-item-title">${esc(ch.title)}</span>
        ${(ch.word_count || 0) >= 300 && !(ch.summary || '').trim()
          ? `<span class="chapter-item-flag" title="摘要未填：续写时注入的前情会缺这一章">摘缺</span>` : ''}
        <span class="chapter-item-words">${formatWordCount(ch.word_count)}</span>
        <button class="chapter-item-del" data-action="del-chapter" data-id="${attr(ch.id)}" title="删除本章">${icon('close','icon-sm')}</button>
      </div>`).join('')}
  </div>`;
}

async function openChapterById(id) {
  const ch = await NovelDB.chapters.get(id);
  if (!ch) { showToast('章节不存在'); return; }
  await openChapter(ch);
}

async function addChapter() {
  if (!APP.novel) return;
  const order = await NovelDB.chapters.nextOrder(APP.novel.id);
  const cn = ['一','二','三','四','五','六','七','八','九','十'];
  const title = order <= 10 ? `第${cn[order - 1]}章` : `第${order}章`;
  const ch = await NovelDB.chapters.create(APP.novel.id, { title, order });
  showToast(`「${title}」已创建`);
  await switchTab('chapters');
  await openChapter(ch);
}

async function deleteCh(id) {
  const ch = await NovelDB.chapters.get(id);
  if (!ch) return;
  if (!confirm(`删除「${ch.title}」？该章正文将永久丢失。`)) return;
  stopAutoSave();
  if (APP.chapter?.id === id) { APP.dirty = false; APP.chapter = null; }
  await NovelDB.chapters.delete(id);
  showToast('已删除，剩余章节序号已重排');
  const rest = await NovelDB.chapters.list(APP.novel.id);
  await switchTab('chapters');
  if (rest.length) await openChapter(rest[0]);
  else showEditorEmpty();
}

// ═══════════════════ 编辑器 ═══════════════════

async function openChapter(chapter) {
  stopAutoSave();
  await flushPendingSave();

  const fresh = await NovelDB.chapters.get(chapter.id);
  if (!fresh) { showToast('章节已不存在'); showEditorEmpty(); return; }

  APP.chapter = fresh;
  APP.dirty = false;

  const hdr = document.getElementById('editor-header');
  const area = document.getElementById('editor-area');
  hdr.innerHTML = `
    <div class="editor-crumb">${esc(APP.novel?.title || '')}<span class="crumb-sep" aria-hidden="true">·</span></div>
    <input class="editor-title" id="edt-title" value="${attr(fresh.title)}" data-chapter-id="${attr(fresh.id)}">
    <div class="editor-toolbar">
      <button data-action="toggle-sidebar" title="展开/收起侧栏">${icon('menu')}</button>
      <span class="toolbar-sep" aria-hidden="true"></span>
      <span class="word-count" id="wc-label" title="按汉字计，不含标点">${formatWordCount(fresh.word_count)}</span>
      <span class="saved-hint" id="saved-hint" hidden>已保存</span>
      <span class="toolbar-sep" aria-hidden="true"></span>
      ${AI_TOOLS.filter((t) => t.id !== 'outline').map((t) => `
        <button data-action="run-ai" data-tool="${attr(t.id)}" title="${attr(t.label)}">${icon(t.icon)}</button>`).join('')}
      <button data-action="edit-summary" class="${(fresh.summary || '').trim() ? 'filled' : ''}"
        title="${(fresh.summary || '').trim() ? '本章摘要（已填）' : '本章摘要（未填 —— 续写时前情会缺这一章）'}">${icon('scroll')}</button>
      <span class="toolbar-sep" aria-hidden="true"></span>
      <button data-action="edit-cast" title="声明本章出场角色">${icon('cast')}</button>
      <button data-action="show-revisions" title="正文历史版本">${icon('revisions')}</button>
      <button data-action="save-chapter" title="保存 (Ctrl+S)">${icon('save')}</button>
    </div>`;

  area.innerHTML = `<textarea class="editor-textarea" id="edt-content" placeholder="开始写作吧..." spellcheck="false"></textarea>`;
  const ta = document.getElementById('edt-content');
  ta.value = fresh.content || '';
  ta.addEventListener('input', onEditorInput);

  startAutoSave(fresh.id);
  hdr.querySelector('#edt-title').addEventListener('change', (e) => updateChapterTitle(fresh.id, e.target.value));
  router.sync('workspace', { novelId: fresh.novel_id, chapterId: fresh.id });

  await renderChapterList();
  ta.focus();
}

function showEditorEmpty() {
  stopAutoSave();
  APP.chapter = null;
  document.getElementById('editor-header').innerHTML = '';
  document.getElementById('editor-area').innerHTML =
    `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);">选择或创建章节</div>`;
  renderChapterList();
}

function onEditorInput() {
  const ta = document.getElementById('edt-content');
  const wc = document.getElementById('wc-label');
  if (wc && ta) wc.textContent = formatWordCount(countWords(ta.value));
  APP.dirty = true;
}

function startAutoSave(chapterId) {
  stopAutoSave();
  APP.autoSaveTimer = setInterval(() => {
    if (APP.dirty) saveChapter(chapterId, true);
  }, AUTOSAVE_MS);
}

function stopAutoSave() {
  if (APP.autoSaveTimer) { clearInterval(APP.autoSaveTimer); APP.autoSaveTimer = null; }
}

/** 有未保存内容时先落库，再切章节 —— 否则最后一个输入窗口的字会丢。 */
async function flushPendingSave() {
  if (!APP.dirty || !APP.chapter) return;
  await saveChapter(APP.chapter.id, true);
}

/** 保存成功后字数旁闪 2 秒「已保存」(静默自动保存也有感知)。 */
function flashSavedHint() {
  const el = document.getElementById('saved-hint');
  if (!el) return;
  el.hidden = false;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; el.hidden = true; }, 2000);
}

async function saveChapter(idOrSkip, silent) {
  const ta = document.getElementById('edt-content');
  const titleEl = document.getElementById('edt-title');
  const id = (typeof idOrSkip === 'string' ? idOrSkip : null) || titleEl?.dataset?.chapterId || APP.chapter?.id;

  if (!id) { if (!silent) showToast('没有打开中的章节'); return; }
  if (!ta) { if (!silent) showToast('编辑器未打开'); return; }

  try {
    // 只给「作者主动定稿」留版本：自动保存 15 秒一发，留底会被噪声淹掉
    if (!silent) await NovelDB.revisions.snapshot({
      ...APP.chapter, id, novel_id: APP.chapter?.novel_id || APP.novel?.id,
      title: titleEl?.value ?? APP.chapter?.title, content: ta.value,
    }, 'save');
    const saved = await NovelDB.chapters.update(id, { title: titleEl?.value ?? APP.chapter?.title, content: ta.value });
    APP.chapter = { ...APP.chapter, ...saved };
    APP.dirty = false;
    const wc = document.getElementById('wc-label');
    if (wc) wc.textContent = formatWordCount(saved.word_count);
    flashSavedHint();
    await renderSidebar();
    await renderChapterList();
    if (!silent) showToast('已保存');
  } catch (e) {
    stopAutoSave();
    showToast('保存失败：' + e.message);
    console.error(e);
  }
}

async function updateChapterTitle(id, title) {
  const clean = String(title || '').trim();
  if (!clean) { showToast('标题不能为空'); const el = document.getElementById('edt-title'); if (el) el.value = APP.chapter?.title || ''; return; }
  await NovelDB.chapters.update(id, { title: clean });
  if (APP.chapter?.id === id) APP.chapter = { ...APP.chapter, title: clean };
  await renderChapterList();
  showToast('标题已更新');
}

// ═══════════════════ 本章摘要 / 正文历史 ═══════════════════

/** 摘要写回后，工具栏按钮与列表标记都要跟上，否则会一直显示「未填」。 */
async function refreshSummaryMarks() {
  const btn = document.querySelector('[data-action="edit-summary"]');
  if (btn && APP.chapter) {
    const has = !!(APP.chapter.summary || '').trim();
    btn.classList.toggle('filled', has);
    btn.title = has ? '本章摘要（已填）' : '本章摘要（未填 —— 续写时前情会缺这一章）';
  }
  await renderChapterList();
}

async function saveSummary(text) {
  if (!APP.chapter) throw new Error('没有打开中的章节');
  const saved = await NovelDB.chapters.update(APP.chapter.id, { summary: String(text || '').trim() });
  APP.chapter = { ...APP.chapter, ...saved };
  await refreshSummaryMarks();
  return saved;
}

/** 超 400 不拦（作者说了算），但要说出来：导出后 nw-validate 会把整本书判成违规。 */
function announceSummary(saved) {
  const n = (saved.summary || '').length;
  showToast(n > 400 ? `摘要已存，但 ${n} 字超 schema 上限 400` : '摘要已保存', n > 400 ? 4200 : 2200);
}

function showSummaryEditor() {
  const ch = APP.chapter;
  if (!ch) { showToast('请先打开章节'); return; }
  showModal(`本章摘要 · ${ch.title}`, `
    <div class="settings-field">
      <label class="settings-label">前情摘要 <span class="sum-count" id="sum-count"></span></label>
      <textarea class="settings-input" id="inp-summary" rows="7" spellcheck="false"
        placeholder="核心事件：&#10;出场角色：&#10;状态变化：&#10;新埋或回收的伏笔：">${esc(ch.summary || '')}</textarea>
      <div class="settings-hint">续写时这一节替代「回读全文」：只取每章「核心事件」一行进上下文，
        位置 / 伤势 / 持有物走状态快照、伏笔走未结线索，互不重复。
        也可以用 AI 工具箱的「总结本章」生成后一键写回。</div>
    </div>`, async () => {
      try {
        announceSummary(await saveSummary(val('inp-summary')));
        closeModal();
      } catch (e) { showToast('保存失败：' + e.message); }
    });
  const ta = document.getElementById('inp-summary');
  // 上限与 schemas/story-bible.v1.json 的 maxLength 同口径（UTF-16 长度），
  // 超了这里不拦，但导出后 nw-validate 会把整本书判成违规
  const meter = document.getElementById('sum-count');
  const paint = () => {
    const n = ta.value.length;
    meter.textContent = `${n} / 400`;
    meter.classList.toggle('over', n > 400);
  };
  ta.addEventListener('input', paint);
  paint();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

const REVISION_SOURCE_ZH = {
  save: '保存定格', 'pre-polish': 'AI 替换前', 'pre-import': '导入覆盖前', 'pre-restore': '回退前',
};

function revTime(ms) {
  if (!ms) return '未知时间';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

async function showRevisions() {
  const ch = APP.chapter;
  if (!ch) { showToast('请先打开章节'); return; }
  const list = await NovelDB.revisions.list(ch.id);
  APP.revisions = list;
  const keep = NovelDB.revisions.keep;
  const curContent = document.getElementById('edt-content')?.value ?? ch.content ?? '';
  // 同一份文字可能在两个时间点各留一版（保存过一次、导入又盖回同样的内容），
  // 逐行按文本相等判「当前」会让两行都亮起来 —— 只标最新那条。
  let curTagged = false;
  const body = list.length ? `
    <div class="settings-hint" style="margin-bottom:10px;">每章最多留 ${keep} 版，更早的自动丢弃。
      正文历史只在本机，不进 .novelweave/ 导出 —— 目录那份交给 git。</div>
    <div class="rev-list">${list.map((r) => {
      const same = (r.content || '') === curContent;
      const isCur = same && !curTagged;
      if (isCur) curTagged = true;
      return `
      <div class="rev-row${isCur ? ' current' : ''}">
        <div class="rev-head">
          <span class="rev-time">${esc(revTime(r.at))}</span>
          <span class="rev-src">${esc(REVISION_SOURCE_ZH[r.source] || r.source)}</span>
          <span class="rev-words">${formatWordCount(r.word_count)}</span>
          ${isCur ? '<span class="rev-tag">当前</span>' : ''}
        </div>
        <div class="rev-preview">${esc(previewLine(r.content))}</div>
        <div class="rev-actions">
          <button class="btn btn-secondary" data-action="toggle-revision" data-id="${attr(r.id)}">${icon('search', 'icon-sm')}<span>查看</span></button>
          ${same ? '' : `<button class="btn btn-secondary" data-action="restore-revision" data-id="${attr(r.id)}">${icon('undo', 'icon-sm')}<span>回退到这一版</span></button>`}
        </div>
        <pre class="rev-body" id="rev-body-${attr(r.id)}" hidden></pre>
      </div>`; }).join('')}
    </div>` : emptyHint(`还没有历史版本。手动保存（Ctrl+S）、AI 整章替换、导入覆盖这几处会各留一版，最多 ${keep} 版。`);
  showModal(`正文历史 · ${ch.title}`, body, null);
}

function previewLine(content) {
  const flat = String(content || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '（空）';
  return flat.slice(0, 90) + (flat.length > 90 ? '…' : '');
}

function toggleRevision(id, el) {
  const rev = (APP.revisions || []).find((r) => r.id === id);
  const pre = document.getElementById('rev-body-' + id);
  if (!rev || !pre) return;
  const open = !pre.hidden;
  pre.hidden = open;
  if (!open && !pre.dataset.filled) { pre.textContent = rev.content || '（这一版是空的）'; pre.dataset.filled = '1'; }
  if (el) el.querySelector('span').textContent = open ? '查看' : '收起';
}

async function restoreRevision(id) {
  const rev = (APP.revisions || []).find((r) => r.id === id);
  const ch = APP.chapter;
  if (!rev || !ch) return;
  const target = `${revTime(rev.at)}（${formatWordCount(rev.word_count)}）`;
  if (!confirm(`把正文回退到 ${target} 这一版？\n当前编辑器里的文字会先留成一版，不会丢。`)) return;
  const ta = document.getElementById('edt-content');
  try {
    if (ta) await NovelDB.revisions.snapshot({ ...ch, content: ta.value }, 'pre-restore');
    const saved = await NovelDB.chapters.update(ch.id, { content: rev.content || '' });
    APP.chapter = { ...APP.chapter, ...saved };
    APP.dirty = false;
    if (ta) { ta.value = saved.content || ''; ta.dispatchEvent(new Event('input')); }
    await renderChapterList();
    showToast(`已回退到 ${target}`);
    await showRevisions();
  } catch (e) { showToast('回退失败：' + e.message); }
}

// ═══════════════════ 角色 ═══════════════════

const CHARACTER_STATUS_ZH = { alive: '在世', deceased: '已死亡', unknown: '未知', missing: '下落不明' };

/** appearance_tokens ⇄ 「特征词 | 从第N章 | 到第M章」行式文本 */
function tokensToText(tokens) {
  const num = (id) => { const c = (APP.chaptersCache || []).find((x) => x.id === id); return c ? c.order : null; };
  return (tokens || []).map((t) => {
    const from = num(t.since), to = num(t.until);
    return [t.key, from ? `从第${from}章` : '', to ? `到第${to}章` : ''].filter(Boolean).join(' | ');
  }).join('\n');
}

function textToTokens(text) {
  const byOrder = new Map((APP.chaptersCache || []).map((c) => [c.order, c.id]));
  const chapterOf = (s) => { const m = String(s || '').match(/(\d+)/); return m ? (byOrder.get(+m[1]) || null) : null; };
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [key, from, to] = line.split('|').map((x) => (x || '').trim());
    return { key, since: chapterOf(from), until: chapterOf(to) };
  }).filter((t) => t.key);
}

function characterFields(prefix, c = {}) {
  return `
    <div class="settings-field"><label class="settings-label">角色名称</label>
      <input class="settings-input" id="${prefix}-name" value="${attr(c.name || '')}" placeholder="角色名字"></div>
    <div class="settings-field"><label class="settings-label">定位</label>
      <select class="settings-select" id="${prefix}-role">
        ${NovelDB.CHARACTER_ROLES.map((r) => `<option value="${attr(r)}" ${c.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">状态</label>
      <select class="settings-select" id="${prefix}-status">
        ${NovelDB.CHARACTER_STATUS.map((s) => `<option value="${attr(s)}" ${(c.status || 'alive') === s ? 'selected' : ''}>${esc(CHARACTER_STATUS_ZH[s] || s)}</option>`).join('')}
      </select>
      <div class="settings-hint">标为「已死亡」后，之后章节里他一旦有动作就会被查出来。</div></div>
    <div class="settings-field"><label class="settings-label">死于哪章（仅已死亡时填）</label>${chapterSelect(`${prefix}-diedin`, c['died-in'])}</div>
    <div class="settings-field"><label class="settings-label">首次出场</label>${chapterSelect(`${prefix}-first`, c.first)}</div>
    <div class="settings-field"><label class="settings-label">性格特点</label>
      <textarea class="settings-input" id="${prefix}-personality" rows="2" placeholder="简短描述性格">${esc(c.personality || '')}</textarea></div>
    <div class="settings-field"><label class="settings-label">外观描述</label>
      <textarea class="settings-input" id="${prefix}-appearance" rows="2" placeholder="外貌、穿着等">${esc(c.appearance || '')}</textarea></div>
    <div class="settings-field"><label class="settings-label">外貌特征区间（每行一条）</label>
      <textarea class="settings-input mono" id="${prefix}-tokens" rows="3" placeholder="左臂断裂 | 从第3章&#10;断臂 | 从第3章 | 到第9章">${esc(tokensToText(c.appearance_tokens))}</textarea>
      <div class="settings-hint">格式：<code>特征词 | 从第N章 | 到第M章</code>，后两项可省。填了才能查出「断臂又长回来了」。</div></div>
    <div class="settings-field"><label class="settings-label">别称（顿号分隔）</label>
      <input class="settings-input" id="${prefix}-aliases" value="${attr((c.aliases || []).map((a) => (typeof a === 'string' ? a : a.text)).join('、'))}" placeholder="小焰、林师兄"></div>
    <div class="settings-field"><label class="settings-label">背景故事</label>
      <textarea class="settings-input" id="${prefix}-background" rows="3" placeholder="角色的背景经历">${esc(c.background || '')}</textarea></div>
    <div class="settings-field"><label class="settings-label">备注</label>
      <textarea class="settings-input" id="${prefix}-notes" rows="2">${esc(c.notes || '')}</textarea></div>`;
}

function readCharacterForm(prefix) {
  return {
    name: val(`${prefix}-name`),
    role: val(`${prefix}-role`),
    status: val(`${prefix}-status`),
    'died-in': val(`${prefix}-diedin`) || null,
    first: val(`${prefix}-first`) || null,
    personality: val(`${prefix}-personality`),
    appearance: val(`${prefix}-appearance`),
    appearance_tokens: textToTokens(document.getElementById(`${prefix}-tokens`)?.value || ''),
    aliases: val(`${prefix}-aliases`).split(/[、,，]/).map((s) => s.trim()).filter(Boolean).map((text) => ({ text, kind: 'nickname' })),
    background: val(`${prefix}-background`),
    notes: val(`${prefix}-notes`),
  };
}

function showCreateCharacter() {
  showModal('添加角色', characterFields('m'), async () => {
    const data = readCharacterForm('m');
    if (!data.name) { showToast('请输入角色名称'); return; }
    await NovelDB.characters.create(APP.novel.id, data);
    closeModal();
    showToast(`「${data.name}」已添加`);
    await switchTab('characters');
  });
  setTimeout(() => document.getElementById('m-name')?.focus(), 60);
}

async function editCharacter(id) {
  const c = await NovelDB.characters.get(id);
  if (!c) { showToast('角色不存在'); return; }
  showModal(`编辑角色 · ${c.name}`, characterFields('e', c), async () => {
    const data = readCharacterForm('e');
    if (!data.name) { showToast('名称不能为空'); return; }
    await NovelDB.characters.update(id, data);
    closeModal();
    showToast('角色已更新');
    await switchTab('characters');
  }, async () => {
    if (!confirm(`删除角色「${c.name}」？`)) return;
    await NovelDB.characters.delete(id);
    closeModal();
    showToast('已删除');
    await switchTab('characters');
  });
}

async function showCharacterList(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  const chars = await NovelDB.characters.list(APP.novel.id);
  if (!chars.length) { host.innerHTML = emptyHint('点击 + 创建角色'); return; }
  host.innerHTML = `<div class="char-list">
    ${chars.map((c) => `
      <div class="char-card" data-action="edit-char" data-id="${attr(c.id)}">
        <div class="char-card-name">${esc(c.name)}</div>
        <div class="char-card-role">${esc(c.role || '角色')}</div>
        <div class="char-card-desc">${esc((c.personality || '').slice(0, 50))}</div>
      </div>`).join('')}
  </div>`;
}

// ═══════════════════ 世界设定 ═══════════════════

function worldFields(prefix, w = {}) {
  return `
    <div class="settings-field"><label class="settings-label">类型</label>
      <select class="settings-select" id="${prefix}-wb-type">
        ${Object.entries(NovelDB.WORLD_TYPES).map(([v, label]) => `<option value="${attr(v)}" ${(w.type || 'location') === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">名称</label>
      <input class="settings-input" id="${prefix}-wb-name" value="${attr(w.name || '')}" placeholder="名称（会作为触发关键词）"></div>
    <div class="settings-field"><label class="settings-label">详细描述</label>
      <textarea class="settings-input" id="${prefix}-wb-desc" rows="6" placeholder="详细描述...">${esc(w.description || '')}</textarea></div>`;
}

function showCreateWorldbuilding() {
  showModal('添加世界设定', worldFields('m'), async () => {
    const name = val('m-wb-name');
    if (!name) { showToast('请输入名称'); return; }
    await NovelDB.worldbuilding.create(APP.novel.id, {
      type: val('m-wb-type') || 'location', name, description: val('m-wb-desc'),
    });
    closeModal();
    showToast(`「${name}」已添加`);
    await switchTab('world');
  });
}

async function editWorldbuilding(id) {
  const w = await NovelDB.worldbuilding.get(id);
  if (!w) { showToast('设定不存在'); return; }
  showModal(`编辑设定 · ${w.name}`, worldFields('e', w), async () => {
    const name = val('e-wb-name');
    if (!name) { showToast('名称不能为空'); return; }
    await NovelDB.worldbuilding.update(id, { name, description: val('e-wb-desc'), type: val('e-wb-type') });
    closeModal();
    showToast('已更新');
    await switchTab('world');
  }, async () => {
    if (!confirm(`删除设定「${w.name}」？`)) return;
    await NovelDB.worldbuilding.delete(id);
    closeModal();
    showToast('已删除');
    await switchTab('world');
  });
}

async function showWorldList(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  const items = await NovelDB.worldbuilding.list(APP.novel.id);
  const WORLD_ICONS = { location: 'pin', faction: 'bank', rule: 'scroll', system: 'bolt' };
  if (!items.length) { host.innerHTML = emptyHint('点击 + 添加设定'); return; }
  host.innerHTML = `<div class="char-list">
    ${items.map((w) => `
      <div class="char-card" data-action="edit-world" data-id="${attr(w.id)}">
        <div class="char-card-name">${icon(WORLD_ICONS[w.type] || 'dot')} ${esc(w.name)}</div>
        <div class="char-card-desc">${esc((w.description || '').slice(0, 80))}</div>
      </div>`).join('')}
  </div>`;
}

// ═══════════════════ 笔记 ═══════════════════

function noteFields(prefix, n = {}) {
  return `
    <div class="settings-field"><label class="settings-label">标题</label>
      <input class="settings-input" id="${prefix}-note-title" value="${attr(n.title || '')}" placeholder="笔记标题"></div>
    <div class="settings-field"><label class="settings-label">内容</label>
      <textarea class="settings-input" id="${prefix}-note-content" rows="7" placeholder="写作备忘、灵感、伏笔记录...">${esc(n.content || '')}</textarea></div>`;
}

function showCreateNote() {
  showModal('添加笔记', noteFields('m'), async () => {
    const title = val('m-note-title') || '无标题';
    await NovelDB.notes.save(APP.novel.id, { title, content: val('m-note-content') });
    closeModal();
    showToast('笔记已保存');
    await switchTab('notes');
  });
}

async function editNote(id) {
  const n = await NovelDB.notes.get(id);
  if (!n) { showToast('笔记不存在'); return; }
  showModal(`笔记 · ${n.title}`, noteFields('e', n), async () => {
    await NovelDB.notes.update(id, { title: val('e-note-title') || '无标题', content: val('e-note-content') });
    closeModal();
    showToast('已保存');
    await switchTab('notes');
  }, async () => {
    if (!confirm('删除这条笔记？')) return;
    await NovelDB.notes.delete(id);
    closeModal();
    showToast('已删除');
    await switchTab('notes');
  });
}

async function showNotesList(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  const notes = await NovelDB.notes.list(APP.novel.id);
  if (!notes.length) { host.innerHTML = emptyHint('点击 + 添加笔记'); return; }
  host.innerHTML = `<div class="char-list">
    ${notes.map((n) => `
      <div class="char-card" data-action="edit-note" data-id="${attr(n.id)}">
        <div class="char-card-name">${esc(n.title)}</div>
        <div class="char-card-desc">${esc((n.content || '').slice(0, 60))}</div>
      </div>`).join('')}
  </div>`;
}

// ═══════════════════ 伏笔登记表 ═══════════════════

function chapterSelect(idName, selected) {
  const chapters = APP.chaptersCache || [];
  return `<select class="settings-select" id="${idName}">
    <option value="">（未定）</option>
    ${chapters.map((c) => `<option value="${attr(c.id)}" ${selected === c.id ? 'selected' : ''}>第${c.order}章 ${esc(c.title)}</option>`).join('')}
  </select>`;
}

const PROMISE_STATUS_ZH = { planned: '计划埋设', planted: '已埋未收', 'paid-off': '已回收', dropped: '已弃用' };
const PROMISE_WEIGHT_ZH = { major: '主线级', minor: '支线级', candidate: '待确认' };

function promiseFields(prefix, p = {}) {
  const setup = p.setup || {}, payoff = p.payoff || {};
  return `
    <div class="settings-field"><label class="settings-label">伏笔是什么</label>
      <input class="settings-input" id="${prefix}-p-title" value="${attr(p.title || '')}" placeholder="例：半枚铜印的来历"></div>
    <div class="settings-field"><label class="settings-label">状态</label>
      <select class="settings-select" id="${prefix}-p-status">
        ${NovelDB.PROMISE_STATUS.map((s) => `<option value="${attr(s)}" ${p.status === s ? 'selected' : ''}>${esc(PROMISE_STATUS_ZH[s] || s)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">分量</label>
      <select class="settings-select" id="${prefix}-p-weight">
        ${NovelDB.PROMISE_WEIGHTS.map((w) => `<option value="${attr(w)}" ${(p.weight || 'minor') === w ? 'selected' : ''}>${esc(PROMISE_WEIGHT_ZH[w] || w)}</option>`).join('')}
      </select>
      <div class="settings-hint">主线级埋下 10 章未收即告警，支线级 25 章。待确认的不打扰你。</div></div>
    <div class="settings-field"><label class="settings-label">埋于哪一章</label>${chapterSelect(`${prefix}-p-setup`, setup.chapter)}</div>
    <div class="settings-field"><label class="settings-label">埋设时的原文依据</label>
      <textarea class="settings-input" id="${prefix}-p-evidence" rows="2" placeholder="贴一句正文，将来判断有没有回收全靠它">${esc(setup.evidence || '')}</textarea></div>
    <div class="settings-field"><label class="settings-label">回收于哪一章</label>${chapterSelect(`${prefix}-p-payoff`, payoff.chapter)}</div>
    <div class="settings-field"><label class="settings-label">最迟该在哪章收</label>${chapterSelect(`${prefix}-p-due`, payoff.due)}
      <div class="settings-hint">设了期限就走「逾期」检查，比笼统的未回收更准。</div></div>
    <div class="settings-field"><label class="settings-label">备注</label>
      <textarea class="settings-input" id="${prefix}-p-notes" rows="2">${esc(p.notes || '')}</textarea></div>`;
}

function readPromiseForm(prefix) {
  return {
    title: val(`${prefix}-p-title`),
    status: val(`${prefix}-p-status`),
    weight: val(`${prefix}-p-weight`),
    setup_chapter: val(`${prefix}-p-setup`),
    setup_evidence: val(`${prefix}-p-evidence`),
    payoff_chapter: val(`${prefix}-p-payoff`),
    payoff_due: val(`${prefix}-p-due`),
    notes: val(`${prefix}-p-notes`),
  };
}

function showCreatePromise() {
  showModal('登记伏笔', promiseFields('m'), async () => {
    const data = readPromiseForm('m');
    if (!data.title) { showToast('请写清这条伏笔是什么'); return; }
    await NovelDB.promises.save(APP.novel.id, data);
    closeModal();
    showToast('已登记');
    await switchTab('promises');
  });
  setTimeout(() => document.getElementById('m-p-title')?.focus(), 60);
}

async function editPromise(id) {
  const p = await NovelDB.promises.get(id);
  if (!p) { showToast('伏笔不存在'); return; }
  showModal(`伏笔 · ${p.title}`, promiseFields('e', p), async () => {
    await NovelDB.promises.save(APP.novel.id, { ...readPromiseForm('e'), id: p.id, created_at: p.created_at });
    closeModal();
    showToast('已更新');
    await switchTab('promises');
  }, async () => { await removePromise(id); });
}

async function removePromise(id) {
  if (!confirm('删除这条伏笔登记？')) return;
  await NovelDB.promises.delete(id);
  closeModal();
  showToast('已删除');
  await switchTab('promises');
}

async function showPromiseList(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  const items = await NovelDB.promises.list(APP.novel.id);
  if (!items.length) { host.innerHTML = emptyHint('点击 + 登记第一条伏笔'); return; }
  const open = items.filter((i) => ['planned', 'planted'].includes(i.status)).length;
  host.innerHTML = `<div class="char-list">
    <div style="padding:8px 12px;font-size:12px;color:var(--text-secondary);">共 ${items.length} 条，未收 ${open} 条</div>
    ${items.map((p) => {
      const unpaid = ['planned', 'planted'].includes(p.status);
      return `<div class="char-card" data-action="edit-promise" data-id="${attr(p.id)}">
        <div class="char-card-name">${icon(unpaid ? 'dot' : p.status === 'paid-off' ? 'check' : 'ban', 'sev-' + (unpaid ? 'warn' : p.status === 'paid-off' ? 'ok' : 'dim'))} ${esc(p.title)}</div>
        <div class="char-card-role">${esc(PROMISE_STATUS_ZH[p.status] || p.status)} · ${esc(PROMISE_WEIGHT_ZH[p.weight] || p.weight)}</div>
        <div class="char-card-desc">${esc(p.setup?.evidence || p.notes || '')}</div>
      </div>`;
    }).join('')}
  </div>`;
}

// ═══════════════════ 时间线 ═══════════════════

const CLOCKS = ['黎明', '晨', '午', '暮', '夜', '三更'];
const CONFIDENCE_ZH = { explicit: '正文明说', implied: '叙述推断', author: '作者设定' };

function anchorFields(prefix, a = {}) {
  return `
    <div class="settings-field"><label class="settings-label">发生了什么</label>
      <input class="settings-input" id="${prefix}-t-label" value="${attr(a.label || '')}" placeholder="例：山门夜火"></div>
    <div class="settings-field"><label class="settings-label">发生在第几章</label>${chapterSelect(`${prefix}-t-chapter`, a.chapter)}</div>
    <div class="settings-field"><label class="settings-label">故事内第几天</label>
      <input class="settings-input" id="${prefix}-t-day" type="number" step="1" value="${attr(a.day ?? '')}" placeholder="0 = 开篇之日"></div>
    <div class="settings-field"><label class="settings-label">时辰</label>
      <select class="settings-select" id="${prefix}-t-clock">
        <option value="">（未定）</option>
        ${CLOCKS.map((c) => `<option value="${attr(c)}" ${a.clock === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">所属叙事线</label>
      <input class="settings-input" id="${prefix}-t-thread" value="${attr(a.thread || '')}" placeholder="留空表示主线">
      <div class="settings-hint">并行展开的多条线各填不同名字，它们之间永远不会被比较时间先后。</div></div>
    <div class="settings-field"><label class="settings-label">这条时间怎么来的</label>
      <select class="settings-select" id="${prefix}-t-conf">
        ${Object.entries(CONFIDENCE_ZH).map(([v, label]) => `<option value="${attr(v)}" ${(a.confidence || 'author') === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <div class="settings-hint">「叙述推断」出来的时间只会提示、不会报错。</div></div>`;
}

function readAnchorForm(prefix) {
  return {
    label: val(`${prefix}-t-label`),
    chapter: val(`${prefix}-t-chapter`),
    day: val(`${prefix}-t-day`),
    clock: val(`${prefix}-t-clock`),
    thread: val(`${prefix}-t-thread`),
    confidence: val(`${prefix}-t-conf`),
  };
}

function showCreateAnchor() {
  showModal('添加时间锚点', anchorFields('m'), async () => {
    const data = readAnchorForm('m');
    if (!data.label) { showToast('请写清发生了什么'); return; }
    await NovelDB.timeline.save(APP.novel.id, data);
    closeModal();
    showToast('已添加');
    await switchTab('timeline');
  });
  setTimeout(() => document.getElementById('m-t-label')?.focus(), 60);
}

async function editAnchor(id) {
  const a = await NovelDB.timeline.get(id);
  if (!a) { showToast('锚点不存在'); return; }
  showModal(`时间锚点 · ${a.label}`, anchorFields('e', a), async () => {
    await NovelDB.timeline.save(APP.novel.id, { ...readAnchorForm('e'), id: a.id });
    closeModal();
    showToast('已更新');
    await switchTab('timeline');
  }, async () => {
    if (!confirm('删除这个时间锚点？')) return;
    await NovelDB.timeline.delete(id);
    closeModal();
    showToast('已删除');
    await switchTab('timeline');
  });
}

async function showTimelineList(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  const rows = await NovelDB.timeline.list(APP.novel.id);
  if (!rows.length) {
    host.innerHTML = emptyHint('点击 + 记录第一件事发生在第几天，之后就能查出时间倒流');
    return;
  }
  const byChapter = new Map((APP.chaptersCache || []).map((c) => [c.id, c]));
  const sorted = [...rows].sort((a, b) => (byChapter.get(a.chapter)?.order ?? 0) - (byChapter.get(b.chapter)?.order ?? 0) || (a.day ?? 0) - (b.day ?? 0));
  host.innerHTML = `<div class="char-list">
    ${sorted.map((a) => `
      <div class="char-card" data-action="edit-anchor" data-id="${attr(a.id)}">
        <div class="char-card-name">第${a.day ?? '?'}天${a.clock ? '·' + esc(a.clock) : ''} ${esc(a.label)}</div>
        <div class="char-card-role">${esc((byChapter.get(a.chapter)?.title) || '未定章')}${a.thread ? ' · ' + esc(a.thread) + '线' : ''} · ${esc(CONFIDENCE_ZH[a.confidence] || a.confidence || '')}</div>
      </div>`).join('')}
  </div>`;
}

// ═══════════════════ 章节出场声明 ═══════════════════

/**
 * 作者显式声明「谁在本章出场并行动 / 只是被提到 / 涉及哪些地点」。
 * 这决定 R1 用最强的章级信号还是退化成动作词邻近扫描 —— 之前只能由 agent 写，
 * 作者自己反而声明不了。
 */
async function showCastPanel() {
  if (!APP.chapter) { showToast('请先打开一章'); return; }
  const [characters, world] = await Promise.all([
    NovelDB.characters.list(APP.novel.id), NovelDB.worldbuilding.list(APP.novel.id),
  ]);
  if (!characters.length && !world.length) { showToast('先在角色和世界设定里登记一些条目'); return; }
  const body = editorText();
  const cast = {
    characters: APP.chapter.characters || [],
    mentions: (APP.chapter.declaredMentions && APP.chapter.declaredMentions.length)
      ? APP.chapter.declaredMentions
      : characters.filter((c) => body.includes(c.name)).map((c) => c.id),
    locations: APP.chapter.locations || [],
  };
  const row = (kind, id, label, checked, extra = '') => `
    <label class="cast-row">
      <input type="checkbox" data-cast="${kind}" value="${attr(id)}" ${checked ? 'checked' : ''}>
      <span>${esc(label)}</span>${extra ? `<em>${esc(extra)}</em>` : ''}
    </label>`;
  const group = (title, kind, list, nameOf, hint) => list.length ? `
    <div class="cast-group"><div class="cast-title">${esc(title)}</div>${hint ? `<div class="settings-hint">${esc(hint)}</div>` : ''}
      ${list.map((x) => row(kind, x.id, nameOf(x), cast[kind].includes(x.id), x.status === 'deceased' ? '已死亡' : '')).join('')}
    </div>` : '';

  showModal(`本章出场 · ${APP.chapter.title}`,
    group('实际出场并有行动', 'characters', characters, (c) => c.name, '标为已死亡的角色若勾在这里，会被直接判为矛盾')
    + group('仅被提及（不出场）', 'mentions', characters, (c) => c.name)
    + group('涉及地点', 'locations', world, (w) => w.name),
    async () => {
      const picked = (kind) => [...document.querySelectorAll(`input[data-cast="${kind}"]:checked`)].map((i) => i.value);
      const characters2 = picked('characters');
      await NovelDB.chapters.update(APP.chapter.id, {
        characters: characters2,
        // 出场即视为被提到；剩下的勾选项才是纯提及
        mentions: [...new Set([...characters2, ...picked('mentions')])],
        locations: picked('locations'),
      });
      APP.chapter = await NovelDB.chapters.get(APP.chapter.id);
      closeModal();
      showToast('已记录本章出场名单');
      await renderSidebarPanel();
    });
}

// ═══════════════════ 状态矩阵 ═══════════════════

const ALIVE_ZH = { alive: '在世', deceased: '已亡', unknown: '不明', missing: '失踪' };

/** 格子摘要：位置首词 + 生死 + 三个列表维度的计数 */
function stateCellText(row, card) {
  if (!row) return '<span class="cell-empty">·</span>';
  const bits = [];
  if (row.loc) bits.push(esc(String(row.loc).slice(0, 6)));
  if (row.alive) bits.push(ALIVE_ZH[row.alive] || row.alive);
  const counts = ['injury', 'items', 'knows'].map((d) => (row[d] || []).length).reduce((a, b) => a + b, 0);
  if (counts) bits.push(`${counts}项`);
  if (row.goal) bits.push(icon('target', 'icon-sm'));
  const conflict = row.alive && card && row.alive !== card.status;
  return `<span class="${conflict ? 'cell-conflict' : ''}">${bits.join(' · ') || '·'}</span>`;
}

async function showStatesPanel(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  const [chars, rows, chapters] = await Promise.all([
    NovelDB.characters.list(APP.novel.id), NovelDB.states.list(APP.novel.id), NovelDB.chapters.list(APP.novel.id),
  ]);
  if (!chars.length) { host.innerHTML = emptyHint('先到「角色」里登记人物，再记录他们的状态'); return; }
  if (!chapters.length) { host.innerHTML = emptyHint('先到「章节」里建一章'); return; }

  const byKey = new Map(rows.map((r) => [r.id, r]));
  const total = rows.length;
  host.innerHTML = `<div class="state-wrap">
    <div class="state-legend">已记录 ${total} 格 · 红格=与角色卡状态冲突 · 点任意格子编辑（空格子=新增）</div>
    <table class="state-matrix">
      <thead><tr><th class="col-name">角色</th>
        ${chapters.map((c) => `<th title="${attr(c.title)}">${c.order}</th>`).join('')}
      </tr></thead>
      <tbody>
      ${chars.map((card) => `<tr>
        <td class="col-name">${esc(card.name)}${card.status === 'deceased' ? ' <em>亡</em>' : ''}</td>
        ${chapters.map((c) => {
          const row = byKey.get(NovelDB.states.idOf(c.id, card.id));
          const conflict = row?.alive && row.alive !== card.status;
          return `<td class="${conflict ? 'cell-bad' : ''}" data-action="edit-state" data-chapter="${attr(c.id)}" data-entity="${attr(card.id)}">${stateCellText(row, card)}</td>`;
        }).join('')}
      </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

async function showStateEditor(chapterId, entityId) {
  const [chapter, card] = await Promise.all([NovelDB.chapters.get(chapterId), NovelDB.characters.get(entityId)]);
  if (!chapter || !card) { showToast('章节或角色不存在'); return; }
  const chapterRows = await NovelDB.states.listForChapter(chapterId);
  const row = chapterRows.find((r) => r.entity === entityId) || {};
  const p = 'st';

  const area = (label, key, value, hint, rows = 2) => `
    <div class="settings-field"><label class="settings-label">${esc(label)}</label>
      <textarea class="settings-input" id="${p}-${key}" rows="${rows}" placeholder="${attr(hint)}">${esc(Array.isArray(value) ? value.join('\n') : value || '')}</textarea></div>`;

  const conflictHint = row.alive && row.alive !== card.status
    ? `<div class="state-conflict">${icon('warn')}这里写「${ALIVE_ZH[row.alive]}」，但角色卡是「${ALIVE_ZH[card.status] || card.status}」——连续性检查会按矛盾报出（R2）。</div>` : '';

  showModal(`${card.name} · 第${chapter.order}章结束时`, `
    ${conflictHint}
    ${area('位置', 'loc', row.loc, '在哪；写地点名或一句话', 1)}
    <div class="settings-field"><label class="settings-label">生死状态</label>
      <select class="settings-select" id="${p}-alive">
        <option value="">（未记）</option>
        ${Object.entries(ALIVE_ZH).map(([v, l]) => `<option value="${attr(v)}" ${row.alive === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <div class="settings-hint">与角色卡不一致时会被 R2 报出；留空表示本章没改变他的状态。</div></div>
    ${area('伤势', 'injury', row.injury, '每行一条')}${area('持有物', 'items', row.items, '每行一条')}
    ${area('已知信息', 'knows', row.knows, '每行一条：他知道而别人不知道的，最容易写漏')}
    ${area('当前目标', 'goal', row.goal, '一句话', 1)}
    <div class="state-bytes" id="${p}-bytes"></div>
  `, async () => {
    const g = (k) => document.getElementById(`${p}-${k}`)?.value ?? '';
    await NovelDB.states.save(APP.novel.id, {
      chapter: chapterId, entity: entityId,
      loc: g('loc').trim(), alive: g('alive'), injury: g('injury'),
      items: g('items'), knows: g('knows'), goal: g('goal').trim(),
    });
    closeModal();
    showToast('状态已记录');
    await renderSidebarPanel();
  }, row.id ? async () => {
    if (!confirm(`删除 ${card.name} 在第${chapter.order}章的状态记录？`)) return;
    await NovelDB.states.delete(row.id);
    closeModal(); showToast('已删除'); await renderSidebarPanel();
  } : null);

  const refreshBytes = async () => {
    const el = document.getElementById(`${p}-bytes`);
    if (!el) return;
    // 把正在编辑的内容算进去，否则作者要保存后才知道超没超
    const draft = { chapter: chapterId, entity: entityId,
      loc: document.getElementById(`${p}-loc`)?.value.trim() || '',
      alive: document.getElementById(`${p}-alive`)?.value || '',
      injury: NWStory.toLines(document.getElementById(`${p}-injury`)?.value),
      items: NWStory.toLines(document.getElementById(`${p}-items`)?.value),
      knows: NWStory.toLines(document.getElementById(`${p}-knows`)?.value),
      goal: document.getElementById(`${p}-goal`)?.value.trim() || '' };
    const others = (await NovelDB.states.listForChapter(chapterId)).filter((r) => r.entity !== entityId);
    const bytes = NWText.bytesOf(NWText.canonicalJson(
      Object.fromEntries([...others, draft].map((r) => [r.entity, NWStory.dimsOf(r)]))));
    const limit = NWBible.MAX_STATE_BYTES_PER_CHAPTER;
    el.textContent = `本章快照 ${bytes} / ${limit} 字节`;
    el.classList.toggle('over', bytes > limit);
    if (bytes > limit) el.textContent += '（超限：写作时会被裁切，请精简 mood/goal 这类低价值维度）';
  };
  document.getElementById(`${p}-bytes`) && [`${p}-loc`, `${p}-alive`, `${p}-injury`, `${p}-items`, `${p}-knows`, `${p}-goal`]
    .forEach((id) => document.getElementById(id)?.addEventListener('input', refreshBytes));
  refreshBytes();
}

// ═══════════════════ 连续性面板 ═══════════════════

/** 读全库装配 ctx。与 CLI 唯一的差别是不跑 schema 校验（浏览器里没有那份 JSON）。 */
async function loadStoryCtx() {
  const novelId = APP.novel.id;
  const [novel, chapters, characters, world, promises, timeline, suppressions, states] = await Promise.all([
    NovelDB.novels.get(novelId), NovelDB.chapters.list(novelId), NovelDB.characters.list(novelId),
    NovelDB.worldbuilding.list(novelId), NovelDB.promises.list(novelId),
    NovelDB.timeline.list(novelId), NovelDB.suppressions.list(novelId), NovelDB.states.list(novelId),
  ]);
  APP.chaptersCache = chapters;
  return NWStory.buildCtx({ novel, chapters, characters, world, promises, timeline, suppressions, states, relations: { edges: relations } });
}

async function showContinuity(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  host.innerHTML = `<div style="padding:12px;">
    <button class="btn btn-secondary" style="width:100%" data-action="rerun-continuity">${icon('search')} 重新检查</button>
    <div id="diag-body" style="margin-top:10px;">检查中…</div>
  </div>`;

  const ctx = await loadStoryCtx();
  const diags = NWRules.runRules(ctx);
  APP.diags = diags;
  const s = NWRules.summarize(diags);
  const body = document.getElementById('diag-body');
  if (!body) return;

  const counts = [`${icon('x','sev-error')}${s.error}`, `${icon('warn','sev-warn')}${s.warn}`, `${icon('info','sev-info')}${s.info}`]
    .map((x) => `<span class="count">${x}</span>`).join('')
    + (s.suppressed ? `<span class="count muted">${icon('ban')}${s.suppressed}</span>` : '');
  const visible = diags.filter((d) => !d.suppressedBy);
  if (!visible.length) {
    body.innerHTML = `<div class="diag-clean">${icon('check')}没有发现矛盾（${ctx.chapters.length} 章）</div>
      <div class="settings-hint" style="margin-top:8px;">只检查机器可判的 ${Object.keys(NWRules.RULES).length} 条规则，不判断文笔与情节好坏。伏笔、时间线、角色状态、外貌区间填得越全，检查越准。</div>`;
    return;
  }
  body.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">${counts}</div>`
    + visible.map((d) => {
      const sevIcon = icon(d.rule === 'unregistered-entity' ? 'info' : d.severity === 'error' ? 'x' : d.severity === 'warn' ? 'warn' : 'info', 'sev-' + d.severity);
      const code = NWRules.RULES[d.rule]?.code || d.rule;
      const quote = d.evidence?.quote;
      const off = d.evidence?.offset || [];
      return `<div class="char-card" ${d.chapter ? `data-action="jump-diag" data-chapter="${attr(d.chapter)}" data-start="${off[0] ?? ''}" data-len="${(off[1] ?? 0) - (off[0] ?? 0)}"` : ''}>
        <div class="char-card-name">${sevIcon}<span class="diag-code">${code}</span> · ${esc(d.chapter || '全书')}</div>
        <div class="char-card-desc">${esc(d.message)}</div>
        ${quote ? `<div class="diag-quote">「${esc(quote)}」</div>` : ''}
        ${d.suggestion ? `<div class="diag-suggest">→ ${esc(d.suggestion)}</div>` : ''}
        <div class="diag-actions">
          <button class="btn btn-secondary" data-action="suppress-diag" data-fp="${attr(d.fingerprint)}" title="确认是有意的（闪回/伏笔故意悬置），不再提醒">豁免</button>
        </div>
      </div>`;
    }).join('');
}

async function suppressDiagnostic(fingerprint, el) {
  const reason = prompt('豁免理由（会留痕，随时可撤销）：', '作者确认，是有意的');
  if (reason === null) return;
  await NovelDB.suppressions.save(APP.novel.id, fingerprint, reason || '作者确认');
  showToast('已豁免，可撤销');
  await renderSidebarPanel();
}

/** 点诊断跳到正文：选中依据句并按行高比例滚动过去。 */
async function jumpToEvidence(chapterId, startRaw, lenRaw) {
  if (!chapterId) return;
  await openChapterById(chapterId);
  const ta = document.getElementById('edt-content');
  if (!ta) return;
  // 书级/跨章诊断没有 offset；Number('')===0 会被误当成正文开头
  if (startRaw === '' || startRaw == null || !Number.isFinite(+startRaw)) { ta.focus(); return; }
  const start = +startRaw;
  const len = Number(lenRaw) || 0;
  ta.focus();
  ta.setSelectionRange(start, start + len);
  const linesBefore = ta.value.slice(0, start).split('\n').length - 1;
  const totalLines = ta.value.split('\n').length || 1;
  ta.scrollTop = Math.max(0, (linesBefore / totalLines) * ta.scrollHeight - ta.clientHeight / 3);
}

// ═══════════════════ AI 工具箱 ═══════════════════

function renderAIPanelTools() {
  const host = document.getElementById('ai-panel-tools');
  if (!host) return;
  const temp = NovelLLM.getConfig()?.temperature ?? 0.8;
  host.innerHTML = AI_TOOLS.map((t) =>
    `<button class="ai-tool-btn" data-action="run-ai" data-tool="${attr(t.id)}">${icon(t.icon)} ${esc(t.label)}</button>`
  ).join('') + `
    <label class="ai-temp">写作温度 <b id="ai-temp-val">${Number(temp).toFixed(1)}</b>
      <input type="range" id="ai-temp" min="0.2" max="1.4" step="0.1" value="${attr(temp)}">
    </label>`;
  host.querySelector('#ai-temp').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    host.querySelector('#ai-temp-val').textContent = v.toFixed(1);
    NovelLLM.setConfig({ ...(NovelLLM.getConfig() || {}), temperature: v });
  });
}

/** 上下文用量条。静默裁切是最坑人的失败方式：不报错，只是产出与前文脱节。 */
function renderUsageBar(el, usage) {
  if (!el || !usage) return;
  const bar = document.createElement('div');
  bar.className = 'ai-usage';
  bar.innerHTML = `<span class="usage-head">上下文 ${usage.bytes} / ${usage.budgetBytes} 字节</span>`
    + usage.sections.map((sec) => `<span class="usage-item${sec.present ? '' : ' off'}">${icon(sec.present ? 'check' : 'x', 'icon-sm')}${esc(sec.name)}${sec.included?.length ? `（${sec.included.map(esc).join('、')}）` : ''}</span>`).join('  ');
  if (usage.truncated || usage.loreDropped?.length) {
    const warn = document.createElement('div');
    warn.className = 'ai-usage-warn';
    warn.innerHTML = `${icon('warn', 'icon-sm')}<span>有内容被裁掉${usage.loreDropped?.length ? `：${usage.loreDropped.length} 条世界设定` : ''}。AI 没看到被裁的部分，产出可能与前文脱节。</span>`;
    bar.appendChild(warn);
  }
  el.prepend(bar);
}

async function runAIPanel(toolId) {
  if (!NovelLLM.hasConfig()) {
    closeAIPanel();
    showToast('请先配置 API');
    if (APP.novel) await switchTab('settings');
    else router.go('settings');
    return;
  }
  const spec = AI_TOOLS.find((t) => t.id === toolId);
  if (!spec) { showToast('未知工具：' + toolId); return; }

  const outputEl = document.getElementById('ai-output');
  document.getElementById('ai-panel').classList.remove('hidden');
  document.getElementById('ai-panel-overlay').classList.remove('hidden');
  outputEl.textContent = '正在处理…';
  await runAITool(toolId, outputEl);
}

function closeAIPanel() {
  if (APP.aiAbort) { APP.aiAbort.abort(); APP.aiAbort = null; }
  document.getElementById('ai-panel')?.classList.add('hidden');
  document.getElementById('ai-panel-overlay')?.classList.add('hidden');
}

function editorText() {
  return document.getElementById('edt-content')?.value ?? APP.chapter?.content ?? '';
}

async function runAITool(toolId, target) {
  const spec = AI_TOOLS.find((t) => t.id === toolId);
  if (!spec) { target.textContent = '未知工具：' + toolId; return; }

  if (spec.needsChapter && !APP.chapter) { target.textContent = '请先打开一个章节'; return; }
  const content = editorText();
  const need = typeof spec.needsContent === 'number' ? spec.needsContent : (spec.needsContent ? 1 : 0);
  if (need && countWords(content) < (need || 1)) {
    target.textContent = need > 1 ? `本章至少写满 ${need} 字再做检查（当前 ${countWords(content)} 字）` : '本章还没有内容';
    return;
  }

  const novelId = APP.novel.id;
  const [characters, world] = await Promise.all([
    NovelDB.characters.list(novelId),
    NovelDB.worldbuilding.list(novelId),
  ]);
  let messages = [];
  APP.lastAIUsage = null;
  let continueCtx = null; // 续写后自检用：机检要读到同一份装配 ctx

  if (toolId === 'continue') {
    // 走统一的 Story-Bible 装配：这样状态快照与未回收伏笔才会真的进 prompt
    let built;
    try {
      const storyCtx = await loadStoryCtx();
      const live = storyCtx.chapters.find((c) => c.id === APP.chapter.id);
      // 编辑器里未保存的正文必须覆盖进去，否则 AI 看到的是上次自动保存的旧内容
      if (live) live.body = content;
      continueCtx = storyCtx;
      // 语义检索(可选):配了 embeddings 就按语义召回相关旧章;失败降级词频
      let embedHits = null;
      if (await ensureEmbeddings()) {
        try {
          const q = [APP.chapter.summary, (content || '').slice(-800)].filter(Boolean).join('\n') || APP.chapter.title;
          const ecfg = getEmbedConfig() || {};
          const qc = await NWRetrieval.embedTexts([q], { baseURL: ecfg.baseURL, apiKey: (NovelLLM.getConfig() || {}).apiKey, model: ecfg.model });
          if (qc && qc[0]) embedHits = NWRetrieval.rankByVector(qc[0], APP.embedCache.chunks, { topK: 3 });
        } catch (_) {}
      }
      built = NovelLLM.buildContinueContext({ ctx: storyCtx, chapterId: APP.chapter.id, style: true, embedHits });
    } catch (e) {
      renderAIError(target, toolId, '组装上下文失败：' + e.message);
      return;
    }
    APP.lastAIUsage = built.usage;
    messages = [
      { role: 'system', content: '你是一名经验丰富的中文网文作家，负责在既有设定与前文之下续写。' },
      { role: 'user', content: built.prompt },
    ];
  } else if (toolId === 'consistency') {
    messages = [
      { role: 'system', content: '你是专业的网文编辑，只报告有原文依据的矛盾，不臆测。' },
      { role: 'user', content: NovelLLM.buildConsistencyCheckPrompt(content, characters, world, APP.novel) },
    ];
  } else if (toolId === 'summarize') {
    messages = [
      { role: 'system', content: '你是小说编辑，按指定格式做结构化摘要。' },
      { role: 'user', content: NovelLLM.buildSummarizePrompt(content, APP.chapter.title) },
    ];
  } else if (toolId === 'polish') {
    messages = [
      { role: 'system', content: '你是中文文字编辑，只改善表达，不改动情节事实。' },
      { role: 'user', content: NovelLLM.buildPolishPrompt(content) },
    ];
  } else if (toolId === 'refine') {
    messages = [
      { role: 'system', content: '你是中文文字编辑，只修语言问题，不改情节事实。' },
      { role: 'user', content: NovelLLM.buildRefinePrompt(content) },
    ];
  } else if (toolId === 'review') {
    const ic = APP.chapter?.info_control;
    const chapterInfo = ic
      ? `读者已知：${ic.readerKnows || '-'}｜主角已知：${ic.protagonistKnows || '-'}｜必须隐瞒：${ic.mustHide || '-'}｜只能暗示：${ic.onlyHint || '-'}`
      : null;
    messages = [
      { role: 'system', content: '你是资深网文编辑，只输出评审报告，不改写正文。' },
      { role: 'user', content: NovelLLM.buildReviewPrompt(content, chapterInfo) },
    ];
  } else if (toolId === 'outline') {
    const chapters = await NovelDB.chapters.list(novelId);
    messages = [
      { role: 'system', content: '你是资深网文策划编辑。' },
      { role: 'user', content: NovelLLM.buildOutlinePrompt(APP.novel, chapters, characters) },
    ];
  }

  target.textContent = '';
  APP.lastAIResult = '';
  APP.aiAbort = new AbortController();
  const temperature = NovelLLM.getConfig()?.temperature;
  let full = '';
  let aborted = false;

  for await (const msg of NovelLLM.streamChat(messages, {
      max_tokens: spec.maxTokens, signal: APP.aiAbort.signal, temperature,
  })) {
    if (msg.type === 'chunk') { full += msg.content; target.textContent = full; target.scrollTop = target.scrollHeight; }
    else if (msg.type === 'error') {
      APP.aiAbort = null;
      renderAIError(target, toolId, msg.content);
      return;
    }
    else if (msg.type === 'aborted') { aborted = true; break; }
  }
  APP.aiAbort = null;

  if (!full.trim()) {
    target.textContent = aborted ? '已中断，未产出内容' : '模型没有返回内容';
    return;
  }
  APP.lastAIResult = full;
  // 用量流水:按次记录(供设置页统计;失败不碍主流程)
  try { NovelDB.usage.record(APP.novelId, { tool: toolId, charsIn: messages.reduce((n, m) => n + (m.content || '').length, 0), charsOut: full.length, durationMs: 0 }); } catch (_) {}

  // 生成后自检：草稿先在内存里过一遍机器规则。有 error/warn 就把诊断转成
  // 修订指令，让模型自修一轮，然后把「修订稿 + 机检发现」一起交给作者。
  // 自检失败绝不吞掉草稿 —— 兜底永远是原始全文 + 一次连续性检查的建议。
  if (toolId === 'continue' && continueCtx && !aborted) {
    try {
      const sc = NWSelfCheck.runSelfCheck(continueCtx, { chapterId: APP.chapter.id, draft: full });
      if (sc.actionable.length) {
        const head = document.createElement('div');
        head.className = 'usage-bar';
        head.style.cssText = 'margin-top:10px;';
        head.textContent = `机检发现 ${sc.actionable.length} 处连续性问题，正在自修…`;
        target.appendChild(head);
        APP.aiAbort = new AbortController();
        const revised = await NovelLLM.requestChat([
          { role: 'system', content: '你是中文小说编辑，只消除连续性矛盾，不改其他内容。' },
          { role: 'user', content: NWSelfCheck.buildRevisePrompt(full, sc.actionable) },
        ], { maxTokens: spec.maxTokens, signal: APP.aiAbort.signal, temperature });
        APP.aiAbort = null;
        if (revised && revised.content && revised.content.trim()) {
          APP.lastAIResult = revised.content;
          renderAIResult(target, revised.content, { toolId, aborted: false, selfCheck: sc });
          return;
        }
        // 自修没产出就交原始稿，但机检发现必须如实跟着走
        renderAIResult(target, full, { toolId, aborted, selfCheck: sc });
        return;
      }
    } catch (_) { /* 自检通路任何异常都不影响草稿交付 */ }
  }

  renderAIResult(target, full, { toolId, aborted });
}

/** 失败要能一键重试：网络中断与限流大多再发一次就好，不该逼用户重新点一遍流程。 */
function renderAIError(el, toolId, message) {
  el.textContent = '';
  const head = document.createElement('div');
  head.innerHTML = `${icon('warn')}<span>${esc(message)}</span>`;
  el.appendChild(head);
  const bar = document.createElement('div');
  bar.className = 'ai-result-actions';
  const retry = document.createElement('button');
  retry.className = 'btn btn-secondary';
  retry.style.cssText = 'font-size:13px;padding:6px 14px;margin-top:10px;';
  retry.innerHTML = `${icon('retry')}<span>重试</span>`;
  retry.onclick = () => { el.textContent = '正在处理…'; runAITool(toolId, el); };
  bar.appendChild(retry);
  el.appendChild(bar);
}

/** 结果用 textContent 落文本、按钮用 DOM API 追加。
 *  旧版把模型输出 innerHTML 进面板（模型返回什么就执行什么），
 *  且 applyToEditor 从 textContent 回读，导致插入时多带一段按钮文字。 */
function renderAIResult(el, text, meta = {}) {
  el.textContent = text;
  renderUsageBar(el, APP.lastAIUsage);

  // 自检报告必须跟着稿件走：修过什么、还剩什么问题，作者有权一眼看到
  if (meta.selfCheck) {
    const sc = meta.selfCheck;
    const note = document.createElement('div');
    note.className = 'usage-bar';
    note.style.cssText = 'margin-top:8px;white-space:pre-wrap;';
    note.textContent = '[机检] 发现 ' + sc.actionable.length + ' 处连续性问题，已让模型自修一轮'
      + '（建议再跑一次「一致性检查」复核）：\n'
      + sc.actionable.map((d) => `· [${d.rule}] ${d.message}`).join('\n');
    el.appendChild(note);
  }

  const bar = document.createElement('div');
  bar.className = 'ai-result-actions';
  bar.style.cssText = 'margin-top:12px;border-top:1px solid var(--border);padding-top:12px;';

  const mk = (ico, label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'btn btn-secondary';
    b.style.cssText = 'font-size:13px;padding:6px 14px;margin-right:8px;';
    b.innerHTML = `${icon(ico, 'icon-sm')}<span>${esc(label)}</span>`;
    if (title) b.title = title;
    b.onclick = fn;
    bar.appendChild(b);
  };

  mk('copy', '复制', null, () => {
    navigator.clipboard.writeText(APP.lastAIResult).then(() => showToast('已复制'), () => showToast('复制失败'));
  });
  if (meta.toolId === 'continue' || meta.toolId === 'polish' || meta.toolId === 'summarize') {
    mk(meta.toolId === 'polish' ? 'replace' : 'insert', meta.toolId === 'polish' ? '替换正文' : '插入编辑器', null, () => applyToEditor(meta.toolId));
  }
  if (meta.toolId === 'summarize') {
    mk('check', '写回本章摘要', '存进 chapter.summary，后续续写会把它当前情注入', async () => {
      try {
        announceSummary(await saveSummary(APP.lastAIResult));
      } catch (e) { showToast('写回失败：' + e.message); }
    });
    mk('save', '存为笔记', null, async () => {
      await NovelDB.notes.save(APP.novel.id, { title: `${APP.chapter.title} · 摘要`, content: APP.lastAIResult });
      showToast('已存入笔记');
    });
  }
  el.appendChild(bar);
}

async function applyToEditor(mode) {
  const text = APP.lastAIResult;
  const ta = document.getElementById('edt-content');
  if (!ta || !text) { showToast('请先打开章节'); return; }
  if (mode === 'polish') {
    // 整章替换是不可逆覆盖，先把屏幕上的原文留成一版
    if (APP.chapter) await NovelDB.revisions.snapshot({ ...APP.chapter, content: ta.value }, 'pre-polish');
    ta.value = text;
  } else {
    const pos = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, pos) + (pos > 0 ? '\n\n' : '') + text + ta.value.slice(pos);
  }
  ta.dispatchEvent(new Event('input'));
  ta.focus();
  showToast(mode === 'polish' ? '已替换正文' : '已插入');
  closeAIPanel();
}

// ═══════════════════ 工作区内的 AI 设置 ═══════════════════

function renderWorkspaceSettings(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host) return;
  const cfg = NovelLLM.getConfig() || {};
  const ecfg = getEmbedConfig() || {};
  host.innerHTML = `<div style="padding:12px;">
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">配置 AI API（Key 只存在本机浏览器）</div>
    <div class="settings-field"><label class="settings-label">服务商</label>
      <select class="settings-input" id="ws-provider">
        ${Object.entries(NovelLLM.PRESETS).map(([k, p]) => `<option value="${attr(k)}" ${cfg.provider === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">Base URL</label>
      <input class="settings-input" id="ws-baseurl" value="${attr(cfg.baseURL || '')}"></div>
    <div class="settings-field"><label class="settings-label">API Key</label>
      <input class="settings-input" id="ws-apikey" type="password" value="${attr(cfg.apiKey || '')}" placeholder="sk-..."></div>
    <div class="settings-field"><label class="settings-label">模型</label>
      <input class="settings-input" id="ws-model" value="${attr(cfg.model || '')}"></div>
    <button class="btn btn-primary" style="width:100%;margin-top:8px;" data-action="ws-save">保存</button>
    <button class="btn btn-secondary" style="width:100%;margin-top:8px;" data-action="ws-test">测试连接</button>
    <div id="ws-result" style="margin-top:8px;font-size:12px;color:var(--text-secondary);"></div>
    <button class="btn btn-secondary" style="width:100%;margin-top:16px;" data-action="goto-global-settings">打开完整设置 →</button>
  </div>`;
}

Object.assign(ACTIONS, {
  'ws-save': () => {
    NovelLLM.setConfig({
      provider: val('ws-provider'), baseURL: val('ws-baseurl'),
      apiKey: val('ws-apikey'), model: val('ws-model'),
    });
    showToast('设置已保存');
  },
  'ws-test': async () => {
    const out = document.getElementById('ws-result');
    out.textContent = '测试中…';
    const r = await NovelLLM.testConnection({ baseURL: val('ws-baseurl'), apiKey: val('ws-apikey'), model: val('ws-model') });
    out.innerHTML = r.ok ? `${icon('check')}<span>连接成功</span>` : `${icon('x')}<span>连接失败：${esc(r.message)}</span>`;
  },
  'goto-global-settings': () => router.go('settings'),
});

// ═══════════════════ .novelweave/ 导出与导入 ═══════════════════

const fsAvailable = () => typeof window.showDirectoryPicker === 'function';

async function pickDirectory(mode) {
  try {
    const handle = await window.showDirectoryPicker(mode === 'readwrite'
      ? { mode: 'readwrite', id: 'nw-book' } : { id: 'nw-book' });
    // 权限要显式申请，否则 Chrome 会在下次调用时才弹，导致这里以为拿到了写权限
    if (mode === 'readwrite' && handle.queryPermission) {
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('没有获得目录写权限');
    }
    return handle;
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  }
}

async function writeTreeToDir(rootHandle, tree) {
  for (const [rel, text] of Object.entries(tree)) {
    const parts = rel.split('/');
    let dir = rootHandle;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(parts.at(-1), { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
}

async function readTreeFromDir(dirHandle, prefix = '') {
  const out = {};
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') out[prefix + name] = await (await handle.getFile()).text();
    else Object.assign(out, await readTreeFromDir(handle, `${prefix}${name}/`));
  }
  return out;
}

function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function exportNovelweave() {
  if (!APP.novel) { showToast('先进入一部作品再导出'); return; }
  const ctx = await loadStoryCtx();
  const tree = await NWProject.buildProjectTree(ctx);
  if (!fsAvailable()) {
    downloadText(`novelweave-${ctx.book.slug}-dir.json`, JSON.stringify({ app: 'novelweave-tree', tree }, null, 2));
    showToast('此浏览器不支持目录写入，已导出为单文件目录树');
    return;
  }
  const handle = await pickDirectory('readwrite');
  if (!handle) return;
  // 只写自己格式内的文件；不碰目录里的其他内容
  await writeTreeToDir(handle, tree);
  showToast(`已导出 ${Object.keys(tree).length} 个文件到 ${handle.name}`);
}

/**
 * 逐条比较：file = 目录里的现在值，local = 库里的现在值，base = 上次导出时 sync.json 记的值。
 * 库里没有这条 → new；只有一边动过 → 取那一边；两边都动过 → conflict，绝不自动选边。
 */
async function buildMergePlan(parsed, currentRows) {
  const base = parsed.sync?.records || {};
  const plan = [];
  const buckets = [
    ['chapters', 'chapter', parsed.chapters, currentRows.chapters],
    ['characters', 'character', parsed.characters, currentRows.characters],
    ['worldbuilding', 'world', parsed.world, currentRows.worldbuilding],
    ['promises', 'promise', parsed.promises, currentRows.promises],
    ['timeline', 'anchor', parsed.timeline, currentRows.timeline],
    ['states', 'state', parsed.states || [], currentRows.states || []],
  ];
  for (const [store, kind, fileRows, localRows] of buckets) {
    const localById = new Map(localRows.map((r) => [r.id, r]));
    for (const fr of fileRows) {
      const lr = localById.get(fr.id);
      const tag = NWProject.tagFor(kind, fr.id);
      const fileHash = await NWProject.hashRecord(kind, fr);
      if (!lr) { plan.push({ tag, kind, store, id: fr.id, action: 'new', fileRow: fr, localRow: null }); continue; }
      const localHash = await NWProject.hashRecord(kind, lr);
      plan.push({
        tag, kind, store, id: fr.id,
        action: NWProject.classify(base[tag]?.hash ?? null, fileHash, localHash),
        fileRow: fr, localRow: lr,
      });
    }
  }
  return plan;
}

async function importNovelweave() {
  let files;
  if (fsAvailable()) {
    const handle = await pickDirectory('read');
    if (!handle) return;
    files = await readTreeFromDir(handle);
  } else {
    showToast('此浏览器不支持目录读取，请用「导入备份 JSON」');
    return;
  }
  let parsed;
  try {
    parsed = NWProject.parseFileMap(files);
  } catch (e) {
    showToast(`不是合法的 .novelweave/ 目录：${e.message}`);
    return;
  }

  // 目标作品：库里已有同 id 就合并，没有就按文件原样建档
  let novel = await NovelDB.novels.get(parsed.book.id);
  if (!novel) {
    novel = await NovelDB.putRow('novels', {
      id: parsed.book.id, title: parsed.book.title, genre: parsed.book.genre,
      description: parsed.book.description || '', word_count: 0, chapter_count: 0,
      created_at: NWText.fromISO(parsed.book.created) || Date.now(), updated_at: Date.now(),
    });
  }
  const current = {
    chapters: await NovelDB.chapters.list(novel.id),
    characters: await NovelDB.characters.list(novel.id),
    worldbuilding: await NovelDB.worldbuilding.list(novel.id),
    promises: await NovelDB.promises.list(novel.id),
    timeline: await NovelDB.timeline.list(novel.id),
    states: await NovelDB.states.list(novel.id),
  };
  const plan = await buildMergePlan(parsed, current);
  const conflicts = plan.filter((p) => p.action === 'conflict');
  const apply = plan.filter((p) => ['new', 'take-file'].includes(p.action));

  for (const item of apply) {
    // take-file 会直接盖掉本地正文，留一版才谈得上回退
    if (item.store === 'chapters' && item.localRow) {
      await NovelDB.revisions.snapshot(item.localRow, 'pre-import');
    }
    await NovelDB.putRow(item.store, { ...item.fileRow, novel_id: novel.id });
  }
  await NovelDB.recountNovelStats(novel.id);
  for (const s of parsed.suppressions || []) {
    await NovelDB.putRow('suppressions', { id: 'sup_' + NWText.fnv1a(s.fingerprint), novel_id: novel.id, fingerprint: s.fingerprint, reason: s.reason || '作者确认', at: NWText.fromISO(s.at) || Date.now() });
  }

  if (conflicts.length) {
    const conflictTree = {};
    for (const c of conflicts) {
      conflictTree[`conflicts/${c.tag}-file.json`] = JSON.stringify({ ...c.fileRow, novel_id: novel.id }, null, 2) + '\n';
      conflictTree[`conflicts/${c.tag}-local.json`] = JSON.stringify({ ...c.localRow, novel_id: novel.id }, null, 2) + '\n';
    }
    if (fsAvailable()) {
      try {
        const dir = await pickDirectory('readwrite');
        if (dir) await writeTreeToDir(dir, conflictTree);
      } catch { /* 写不下就用下载兜底，下面一定给出一份 */ }
    }
    downloadText(`novelweave-conflicts-${Date.now()}.json`, JSON.stringify({ app: 'novelweave-conflicts', conflicts: conflicts.map(({ fileRow, localRow, ...m }) => ({ ...m, fileRow, localRow })) }, null, 2));
  }

  showToast(`导入完成：新增/更新 ${apply.length} 条` + (conflicts.length ? `，${conflicts.length} 条冲突未覆盖` : ''));
  await renderHomePage();
}

// ═══════════════════ 全局设置页 ═══════════════════

const EMBED_KEY = 'nw_embed_config';
function getEmbedConfig() {
  try { const c = JSON.parse(localStorage.getItem(EMBED_KEY) || 'null'); return (c && c.baseURL && c.model) ? c : null; } catch { return null; }
}
function setEmbedConfig(cfg) { try { localStorage.setItem(EMBED_KEY, JSON.stringify(cfg)); } catch (_) {} }

/** 把当前书的章节向量算好并缓存到 APP.embedCache。失败返回 false(词频降级)。 */
async function ensureEmbeddings() {
  if (APP.embedCache && APP.embedCache.novelId === APP.novelId) return true;
  const cfg = getEmbedConfig();
  if (!cfg || !NovelLLM.hasConfig()) return false;
  const chapters = await NovelDB.chapters.list(APP.novelId);
  const chunks = NWRetrieval.chunkChapters(chapters.map((c) => ({ id: c.id, title: c.title, body: c.content })));
  if (!chunks.length) return false;
  const vecs = await NWRetrieval.embedTexts(chunks.map((c) => c.text), { baseURL: cfg.baseURL, apiKey: (NovelLLM.getConfig() || {}).apiKey, model: cfg.model });
  if (!vecs) return false;
  chunks.forEach((c, i) => { c.vector = vecs[i]; });
  APP.embedCache = { novelId: APP.novelId, chunks };
  return true;
}

async function renderSettings() {
  const cfg = NovelLLM.getConfig() || {};
  const body = document.getElementById('settings-body');
  if (!body) return;
  body.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">AI API 配置</div>
      <div class="settings-hint" style="margin-bottom:12px;">选择服务商，填入 API Key。<br>Key 只保存在本机浏览器，不经过任何服务器。</div>
      <div class="settings-presets">
        ${Object.entries(NovelLLM.PRESETS).map(([k, p]) => `
          <button class="preset-btn ${cfg.provider === k ? 'active' : ''}" data-action="pick-provider" data-id="${attr(k)}">
            <div class="preset-btn-label">${esc(p.label)}</div><div class="preset-btn-note">${esc(p.note)}</div>
          </button>`).join('')}
      </div>
      <input type="hidden" id="s-provider" value="${attr(cfg.provider || 'openrouter')}">
      <div class="settings-field"><label class="settings-label">Base URL</label>
        <input class="settings-input" id="s-baseurl" value="${attr(cfg.baseURL || NovelLLM.PRESETS.openrouter.baseURL)}"></div>
      <div class="settings-field"><label class="settings-label">API Key</label>
        <input class="settings-input" id="s-apikey" type="password" value="${attr(cfg.apiKey || '')}" placeholder="sk-..."></div>
      <div class="settings-field"><label class="settings-label">模型</label>
        <input class="settings-input" id="s-model" value="${attr(cfg.model || NovelLLM.PRESETS.openrouter.defaultModel)}"></div>
      <div class="settings-actions">
        <button class="btn btn-secondary" data-action="s-test">测试连接</button>
        <button class="btn btn-primary" data-action="s-save">保存</button>
      </div>
      <div id="s-result" style="margin-top:12px;font-size:13px;min-height:1em;"></div>
    </div>
    <div class="settings-section" style="margin-top:20px;">
      <div class="settings-section-title">数据</div>
      <div class="settings-hint" style="margin-bottom:10px;">作品存在本机浏览器 IndexedDB 里。清浏览器数据会一起丢，请定期导出备份。</div>
      <div class="settings-field">
        <button class="btn btn-secondary" data-action="export-backup">导出全部作品备份（单文件快照）</button>
        <button class="btn btn-secondary" data-action="import-backup">导入备份 JSON</button>
      </div>
      <div class="settings-field">
        <button class="btn btn-primary" data-action="export-novelweave">导出当前作品为 .novelweave/</button>
        <button class="btn btn-secondary" data-action="export-epub">导出当前作品为 EPUB</button>
        <button class="btn btn-secondary" data-action="import-novelweave">从 .novelweave/ 目录导入</button>
        <div class="settings-hint" style="margin-top:8px;">
          目录是与命令行 agent 共享的工作副本：正文是 Markdown，状态是 JSON。
          导入时逐条三方比较，两侧都改过的记录不会被自动覆盖，会连本地版一起导出到 conflicts/ 让你选。
          ${fsAvailable() ? '' : '<br>此浏览器不支持目录读写，导出会退回单个 JSON 文件。'}
        </div>
      </div>
    </div>
    <div class="settings-section" style="margin-top:20px;">
      <div class="settings-section-title">关于织文</div>
      <div class="settings-hint">NovelWeave · 织文 — AI 网文作者辅助工具<br>纯前端 · 零服务器 · IndexedDB 本地存储</div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">AI 用量</div>
      <div id="usage-panel" class="settings-hint">加载中…</div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">语义检索（可选）</div>
      <div class="settings-hint" style="margin-bottom:12px;">配置 OpenAI 兼容 /embeddings 端点后，相关旧章按语义召回（硅基流动的 bge 系列免费）。不配置则用词频召回。</div>
      <div class="settings-field"><label class="settings-label">Embeddings Base URL</label>
        <input class="settings-input" id="s-embed-url" value="${attr(ecfg.baseURL || '')}" placeholder="https://api.siliconflow.cn/v1"></div>
      <div class=settings-field><label class=settings-label>Embeddings 模型</label>
        <input class=settings-input id=s-embed-model placeholder=BAAI/bge-m3></div>
      <div class=settings-hint>API Key 复用上方聊天配置的 Key，只存本机。</div>
    </div>`;
}

Object.assign(ACTIONS, {
  'pick-provider': (key, el) => {
    const pr = NovelLLM.PRESETS[key];
    if (!pr) return;
    document.getElementById('s-provider').value = key;
    if (pr.baseURL) document.getElementById('s-baseurl').value = pr.baseURL;
    if (pr.defaultModel) document.getElementById('s-model').value = pr.defaultModel;
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    el.classList.add('active');
  },
  's-save': () => {
    NovelLLM.setConfig({
      provider: val('s-provider'), baseURL: val('s-baseurl'),
      apiKey: val('s-apikey'), model: val('s-model'),
    });
    setEmbedConfig({ baseURL: document.getElementById('s-embed-url')?.value.trim() || '', model: document.getElementById('s-embed-model')?.value.trim() || '' });
    APP.embedCache = null; // 配置变了,向量缓存作废
    showToast('已保存');
    if (!APP.novelId) renderHomePage();
  },
  's-test': async () => {
    const el = document.getElementById('s-result');
    el.textContent = '测试中…';
    const r = await NovelLLM.testConnection({ baseURL: val('s-baseurl'), apiKey: val('s-apikey'), model: val('s-model') });
    el.innerHTML = r.ok ? `${icon('check')}<span>连接成功</span>` : `${icon('x')}<span>连接失败：${esc(r.message)}</span>`;
  },
  'export-novelweave': () => exportNovelweave(),
  'import-novelweave': () => importNovelweave(),
  'import-backup': () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const dump = JSON.parse(await file.text());
        if (!dump?.data?.novels) { showToast('不是织文的备份文件'); return; }
        if (!confirm('导入会按 id 覆盖库里同名记录（正文覆盖前会各留一版，可在该章「正文历史」回退；'
          + '其余记录不会留底）。建议先点上面的「导出全部作品备份」存一份。继续吗？')) return;
        let n = 0;
        for (const [store, rows] of Object.entries(dump.data)) {
          for (const row of rows || []) {
            if (store === 'chapters') {
              const local = await NovelDB.chapters.get(row.id);
              if (local) await NovelDB.revisions.snapshot(local, 'pre-import');
            }
            await NovelDB.putRow(store, row); n++;
          }
        }
        await NovelDB.recountAll();
        showToast(`已导入 ${n} 条记录`);
        await renderHomePage();
      } catch (e) {
        showToast(`导入失败：${e.message}`);
      }
    };
    input.click();
  },
  'export-epub':   () => exportEpub(),
  'export-backup': async () => {
    const dump = { app: 'novelweave', schemaVersion: 1, exportedAt: new Date().toISOString(), data: {} };
    // 从数据层推导，不再手写表名 —— 手写清单在加表时会静默漏备份
    for (const store of ['novels', ...NovelDB.CASCADE_STORES]) {
      dump.data[store] = await NovelDB.dump(store);
    }
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `novelweave-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    showToast('备份已导出');
  },
});

  renderUsagePanel();

/** AI 用量面板:按工具聚合次数与字数。 */
async function renderUsagePanel() {
  const host = document.getElementById('usage-panel');
  if (!host || !APP.novelId) { if (host) host.textContent = '进入一本书后开始记录'; return; }
  try {
    const rows = await NovelDB.usage.list(APP.novelId, 500);
    if (!rows.length) { host.textContent = '暂无调用记录'; return; }
    const byTool = new Map();
    for (const r of rows) {
      const t = byTool.get(r.tool) || { n: 0, out: 0 };
      t.n++; t.out += r.chars_out || 0;
      byTool.set(r.tool, t);
    }
    const total = rows.length;
    host.innerHTML = '近 ' + total + ' 次调用：' + [...byTool.entries()].map(([t, v]) => t + ' ' + v.n + ' 次 / ' + formatWordCount(v.out)).join(' · ');
  } catch (_) { host.textContent = '读取失败'; }
}

// ═══════════════════ 决策记录(Decision) ═══════════════════
// 学 neuro-book:创作决策当场记档(为什么让主角黑化),风险必填,推翻留痕。
// 决策不进上下文 —— 它是给作者回头看的,不是给模型喂的。

async function showDecisionList(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  const list = await NovelDB.decisions.list(APP.novel.id);
  if (!list.length) { host.innerHTML = emptyHint('点击 + 记一条创作决策'); return; }
  host.innerHTML = '<div class="char-list">'
    + list.map((d) => `
      <div class="char-card" data-action="edit-decision" data-id="${attr(d.id)}">
        <div class="char-card-name">${esc(d.title)}${d.supersededBy ? ' <span class="novel-card-upgrade">已推翻</span>' : ''}</div>
        <div class="char-card-desc">${esc((d.reason || '').slice(0, 60))}${d.risk ? '<br>风险：' + esc(d.risk.slice(0, 40)) : ''}</div>
      </div>`).join('')
    + '</div>';
}

function showCreateDecision(existing) {
  const isEdit = !!existing;
  showModal(isEdit ? '编辑决策' : '记一条创作决策', `
    <div class="settings-field"><label class="settings-label">决策 *</label>
      <input class="settings-input" id="inp-dec-title" value="${attr(existing?.title || '')}" maxlength="60" placeholder="例：让主角在第 12 章黑化"></div>
    <div class="settings-field"><label class="settings-label">理由（为什么）*</label>
      <textarea class="settings-input" id="inp-dec-reason" rows="3" placeholder="三个月后回看,这里的理由就是你的依据">${esc(existing?.reason || '')}</textarea></div>
    <div class="settings-field"><label class="settings-label">风险（这一步赌了什么）</label>
      <input class="settings-input" id="inp-dec-risk" value="${attr(existing?.risk || '')}" placeholder="例：读者可能不接受主角伤人"></div>
  `, async () => {
    const title = val('inp-dec-title');
    if (!title) { showToast('决策不能为空'); return; }
    const row = { title, reason: val('inp-dec-reason'), risk: val('inp-dec-risk') };
    if (isEdit) await NovelDB.decisions.update(existing.id, row);
    else await NovelDB.decisions.save(APP.novel.id, row);
    closeModal();
    showToast(isEdit ? '决策已更新' : '决策已记档');
    await renderSidebarPanel();
  });
  if (isEdit) {
    const del = document.getElementById('modal-del-btn');
    if (del) del.onclick = async () => {
      if (!confirm('删除这条决策？')) return;
      await NovelDB.decisions.delete(existing.id);
      closeModal();
      await renderSidebarPanel();
    };
  }
  setTimeout(() => document.getElementById('inp-dec-title')?.focus(), 60);
}

function editDecision(id) {
  NovelDB.decisions.list(APP.novel.id).then((list) => {
    const d = list.find((x) => x.id === id);
    if (d) showCreateDecision(d);
  });
}

// ═══════════════════ 关系图谱(Relations) ═══════════════════
// 作者登记的结构化关系事实:from→to 的 kind(关系类型)与 address(称谓)。
// R19 据此查称谓越界与双向矛盾;编辑评审携带关系作为依据。

async function showRelationList(host) {
  host = host || document.getElementById('sidebar-content');
  if (!host || !APP.novel) return;
  const edges = await NovelDB.relations.list(APP.novel.id);
  const chars = await NovelDB.characters.list(APP.novel.id);
  const nameOf = (id) => (chars.find((c) => c.id === id) || {}).name || id;
  if (!edges.length) { host.innerHTML = emptyHint('点击 + 登记一条关系'); return; }
  host.innerHTML = '<div class="char-list">'
    + edges.map((e) => `
      <div class="char-card" data-action="edit-relation" data-id="${attr(e.id)}">
        <div class="char-card-name">${esc(nameOf(e.from))} → ${esc(nameOf(e.to))}${e.until ? ' <span class="novel-card-upgrade">已结束</span>' : ''}</div>
        <div class="char-card-desc">${esc(e.kind)}${e.address ? '（称谓：' + esc(e.address) + '）' : ''}${e.since ? '<br>自 ' + esc(e.since) : ''}${e.until ? ' 至 ' + esc(e.until) : ''}</div>
      </div>`).join('')
    + '</div>';
}

function showCreateRelation(existing) {
  if (!APP.novel) { showToast('先进入一本书'); return; }
  const isEdit = !!existing;
  NovelDB.characters.list(APP.novel.id).then((chars) => {
    const opts = (sel) => chars.map((c) => `<option value="${attr(c.id)}" ${sel === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    showModal(isEdit ? '编辑关系' : '登记一条关系', `
      <div class="settings-field"><label class="settings-label">主体 *</label>
        <select class="settings-select" id="inp-rel-from">${opts(existing?.from)}</select></div>
      <div class="settings-field"><label class="settings-label">客体 *</label>
        <select class="settings-select" id="inp-rel-to">${opts(existing?.to)}</select></div>
      <div class="settings-field"><label class="settings-label">关系类型 *</label>
        <input class="settings-input" id="inp-rel-kind" value="${attr(existing?.kind || '')}" placeholder="例：师徒 / 父女 / 敌对 / 同门" maxlength="20"></div>
      <div class="settings-field"><label class="settings-label">称谓（主体对客体的称呼，可选）</label>
        <input class="settings-input" id="inp-rel-address" value="${attr(existing?.address || '')}" placeholder="例：师父 / 老爷"></div>
      <div class="settings-field"><label class="settings-label">自哪章生效（可选）</label>
        <input class="settings-input" id="inp-rel-since" value="${attr(existing?.since || '')}" placeholder="例：ch-001"></div>
      <div class="settings-field"><label class="settings-label">到哪章失效（可选，死亡/决裂）</label>
        <input class="settings-input" id="inp-rel-until" value="${attr(existing?.until || '')}" placeholder="例：ch-020"></div>
    `, async () => {
      const kind = val('inp-rel-kind');
      if (!kind) { showToast('关系类型不能为空'); return; }
      const edge = {
        from: val('inp-rel-from'), to: val('inp-rel-to'), kind,
        address: val('inp-rel-address'), since: val('inp-rel-since') || null, until: val('inp-rel-until') || null,
      };
      if (edge.from === edge.to) { showToast('主体和客体不能相同'); return; }
      if (isEdit) await NovelDB.relations.save(APP.novel.id, { ...existing, ...edge });
      else await NovelDB.relations.save(APP.novel.id, edge);
      closeModal();
      showToast(isEdit ? '关系已更新' : '关系已登记');
      await renderSidebarPanel();
    });
    if (isEdit) {
      const del = document.getElementById('modal-del-btn');
      if (del) del.onclick = async () => {
        if (!confirm('删除这条关系？')) return;
        await NovelDB.relations.delete(existing.id);
        closeModal();
        await renderSidebarPanel();
      };
    }
  });
}

function editRelation(id) {
  NovelDB.relations.list(APP.novel.id).then((list) => {
    const e = list.find((x) => x.id === id);
    if (e) showCreateRelation(e);
  });
}

/** EPUB 导出:整本书 → 合法 EPUB 3 容器下载。 */
async function exportEpub() {
  if (!APP.novel) { showToast('先进入一本书'); return; }
  const chapters = await NovelDB.chapters.list(APP.novel.id);
  if (!chapters.length) { showToast('这本书还没有章节'); return; }
  const bytes = NWEpub.buildEpub(
    { title: APP.novel.title, author: 'yu.ai 织文' },
    chapters.map((c) => ({ title: c.title, body: c.content || '' })),
  );
  const blob = new Blob([bytes], { type: 'application/epub+zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (APP.novel.title || 'book') + '.epub';
  a.click(); URL.revokeObjectURL(url);
  showToast('EPUB 已导出（' + chapters.length + ' 章）');
}