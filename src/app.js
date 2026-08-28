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
};

const { esc, attr, countWords } = NWText;

const AUTOSAVE_MS = 15000;

/** AI 工具箱的唯一权威表：面板按钮和 runAITool 的分支由它保证一致。
 *  旧版 index.html 里写死了四个 onclick 调用根本不存在的函数，面板整块是死的。 */
const AI_TOOLS = [
  { id: 'continue',    icon: '✍️', label: '续写',     needsChapter: true,  maxTokens: 8000 },
  { id: 'polish',      icon: '✨', label: '润色',     needsChapter: true,  maxTokens: 4000, needsContent: true },
  { id: 'consistency', icon: '🔍', label: '一致性检查', needsChapter: true,  maxTokens: 4000, needsContent: 100 },
  { id: 'summarize',   icon: '📋', label: '总结本章',  needsChapter: true,  maxTokens: 1000, needsContent: true },
  { id: 'outline',     icon: '📖', label: '生成大纲',  needsChapter: true,  maxTokens: 4000 },
];

const TABS = [
  { id: 'chapters',   icon: '📝', label: '章节',     hasAdd: true,  addTitle: '添加章节' },
  { id: 'characters', icon: '👥', label: '角色',     hasAdd: true,  addTitle: '添加角色' },
  { id: 'world',      icon: '🌍', label: '世界设定', hasAdd: true,  addTitle: '添加设定' },
  { id: 'notes',      icon: '📒', label: '写作笔记', hasAdd: true,  addTitle: '添加笔记' },
  { id: 'settings',   icon: '⚙️', label: 'AI 设置',  hasAdd: false, addTitle: '' },
];

// ═══════════════════ 初始化 ═══════════════════

async function initApp() {
  wireDelegation();
  renderAIPanelTools();
  bindEditorShortcuts();

  // 旧版增量记账已经把历史作品的字数弄错了（单改一次标题就扣掉一整章），启动时校正一次。
  try { await NovelDB.recountAll(); } catch (e) { console.warn('统计校正失败', e); }

  router.onPage = onPageEntered;
  router.start();

  if (!NovelLLM.hasConfig()) {
    showToast('请先配置 API Key');
    router.go('settings');
  }
}

async function onPageEntered(page, params) {
  if (page === 'home') { await renderHomePage(); return; }
  if (page === 'settings') { renderSettings(); return; }
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
  'open-chapter':  (id) => openChapterById(id),
  'del-chapter':   (id) => deleteCh(id),
  'add-chapter':   () => addChapter(),
  'edit-char':     (id) => editCharacter(id),
  'edit-world':    (id) => editWorldbuilding(id),
  'edit-note':     (id) => editNote(id),
  'save-chapter':  () => saveChapter(),
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
      <button class="btn btn-secondary" id="modal-cancel">取消</button>
      <button class="btn btn-primary" id="modal-save">保存</button>
    </div></div>`;
  // 标题可能是书名等用户数据，用 textContent 而不是拼进 HTML
  o.querySelector('.modal-title').textContent = title;
  document.body.appendChild(o);
  o.querySelector('#modal-cancel').onclick = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
  if (onDelete) o.querySelector('#modal-del-btn').onclick = onDelete;
  o.querySelector('#modal-save').onclick = onSave;
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

async function renderHomePage() {
  const novels = await NovelDB.novels.list();
  const listEl = document.getElementById('novel-list');
  const emptyEl = document.getElementById('home-empty');
  if (!listEl) return;

  if (!novels.length) {
    if (emptyEl) emptyEl.style.display = '';
    listEl.innerHTML = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // static HTML 骨架，所有动态值经 esc
  listEl.innerHTML = novels.map((n) => {
    const d = n.updated_at ? new Date(n.updated_at).toLocaleDateString('zh-CN') : '';
    return `<div class="novel-card" data-action="open-novel" data-id="${attr(n.id)}">
      <div class="novel-card-actions">
        <button class="del-btn" data-action="del-novel" data-id="${attr(n.id)}" title="删除作品">🗑️</button>
      </div>
      <div class="novel-card-title">${esc(n.title)}</div>
      <div class="novel-card-meta">
        <span>${esc(n.genre)}</span>
        <span>${n.chapter_count || 0} 章</span>
        <span>${formatWordCount(n.word_count)}</span>
        <span>${esc(d)}</span>
      </div>
    </div>`;
  }).join('');
}

function showCreateNovel() {
  const genres = ['玄幻','都市','仙侠','科幻','历史','武侠','奇幻','现实','悬疑','轻小说','同人','游戏'];
  showModal('创建新作品', `
    <div class="settings-field"><label class="settings-label">作品名称</label>
      <input class="settings-input" id="inp-novel-title" placeholder="输入小说名字" maxlength="50"></div>
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
    });
    closeModal();
    showToast(`「${title}」已创建`);
    await renderHomePage();
    router.go('workspace', { novelId: novel.id });
  });
  setTimeout(() => document.getElementById('inp-novel-title')?.focus(), 60);
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
    notes: (await NovelDB.notes.list(novel.id)).length,
  };

  document.getElementById('sidebar-nav').innerHTML = `
    <div style="padding:12px; border-bottom:1px solid var(--border);">
      <button class="sidebar-back" data-action="go-home">← 返回</button>
      <div style="margin-top:6px; font-size:14px; color:var(--text-primary); font-family:Georgia,serif; font-weight:600;">${esc(novel.title)}</div>
      <div style="margin-top:2px; font-size:12px; color:var(--text-secondary);">${counts.chapters} 章 · ${formatWordCount(novel.word_count)}</div>
    </div>
    <div style="padding:8px;">
      ${TABS.map((t) => `
        <div class="sidebar-nav-item ${APP.activeTab === t.id ? 'active' : ''}" data-action="switch-tab" data-tab="${attr(t.id)}">
          <span class="sidebar-nav-icon">${t.icon}</span><span class="sidebar-nav-label">${esc(t.label)}</span>
          ${counts[t.id] != null ? `<span class="sidebar-nav-count">${counts[t.id]}</span>` : ''}
          ${t.hasAdd ? `<span class="sidebar-nav-add" data-action="${attr('nav-add-' + t.id)}" title="${attr(t.addTitle)}">+</span>` : ''}
        </div>`).join('')}
    </div>`;
}

const ADD_ACTIONS = {
  'nav-add-chapters': () => addChapter(),
  'nav-add-characters': () => showCreateCharacter(),
  'nav-add-world': () => showCreateWorldbuilding(),
  'nav-add-notes': () => showCreateNote(),
};
Object.assign(ACTIONS, ADD_ACTIONS);

/** 侧栏面板分派表。旧版定义了四个列表函数却从不调用，导致四个 tab 永远空白。 */
const SIDEBAR_VIEWS = {
  chapters: renderChapterList,
  characters: showCharacterList,
  world: showWorldList,
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
  host.innerHTML = `<div class="chapter-list" style="max-height:calc(100vh - 200px);overflow-y:auto;">
    ${chapters.map((ch) => `
      <div class="chapter-item ${APP.chapter?.id === ch.id ? 'active' : ''}" data-action="open-chapter" data-id="${attr(ch.id)}">
        <span class="chapter-item-number">${ch.order ?? '-'}</span>
        <span class="chapter-item-title">${esc(ch.title)}</span>
        <span class="chapter-item-words">${formatWordCount(ch.word_count)}</span>
        <button class="chapter-item-del" data-action="del-chapter" data-id="${attr(ch.id)}" title="删除本章">×</button>
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
    <input class="editor-title" id="edt-title" value="${attr(fresh.title)}" data-chapter-id="${attr(fresh.id)}">
    <div class="editor-toolbar">
      <button data-action="toggle-sidebar" title="展开/收起侧栏">☰</button>
      <span class="word-count" id="wc-label">${formatWordCount(fresh.word_count)}</span>
      ${AI_TOOLS.filter((t) => t.id !== 'outline').map((t) => `
        <button data-action="run-ai" data-tool="${attr(t.id)}" title="${attr(t.label)}">${t.icon}</button>`).join('')}
      <button data-action="save-chapter" title="保存 (Ctrl+S)">💾</button>
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

async function saveChapter(idOrSkip, silent) {
  const ta = document.getElementById('edt-content');
  const titleEl = document.getElementById('edt-title');
  const id = (typeof idOrSkip === 'string' ? idOrSkip : null) || titleEl?.dataset?.chapterId || APP.chapter?.id;

  if (!id) { if (!silent) showToast('没有打开中的章节'); return; }
  if (!ta) { if (!silent) showToast('编辑器未打开'); return; }

  try {
    const saved = await NovelDB.chapters.update(id, { title: titleEl?.value ?? APP.chapter?.title, content: ta.value });
    APP.chapter = { ...APP.chapter, ...saved };
    APP.dirty = false;
    const wc = document.getElementById('wc-label');
    if (wc) wc.textContent = formatWordCount(saved.word_count);
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

// ═══════════════════ 角色 ═══════════════════

function characterFields(prefix, c = {}) {
  return `
    <div class="settings-field"><label class="settings-label">角色名称</label>
      <input class="settings-input" id="${prefix}-name" value="${attr(c.name || '')}" placeholder="角色名字"></div>
    <div class="settings-field"><label class="settings-label">定位</label>
      <select class="settings-select" id="${prefix}-role">
        ${NovelDB.CHARACTER_ROLES.map((r) => `<option value="${attr(r)}" ${c.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
      </select></div>
    <div class="settings-field"><label class="settings-label">性格特点</label>
      <textarea class="settings-input" id="${prefix}-personality" rows="2" placeholder="简短描述性格">${esc(c.personality || '')}</textarea></div>
    <div class="settings-field"><label class="settings-label">外观描述</label>
      <textarea class="settings-input" id="${prefix}-appearance" rows="2" placeholder="外貌、穿着等">${esc(c.appearance || '')}</textarea></div>
    <div class="settings-field"><label class="settings-label">背景故事</label>
      <textarea class="settings-input" id="${prefix}-background" rows="3" placeholder="角色的背景经历">${esc(c.background || '')}</textarea></div>
    <div class="settings-field"><label class="settings-label">备注</label>
      <textarea class="settings-input" id="${prefix}-notes" rows="2">${esc(c.notes || '')}</textarea></div>`;
}

function readCharacterForm(prefix) {
  return {
    name: val(`${prefix}-name`),
    role: val(`${prefix}-role`),
    personality: val(`${prefix}-personality`),
    appearance: val(`${prefix}-appearance`),
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
  host.innerHTML = `<div class="char-list" style="max-height:calc(100vh - 200px);overflow-y:auto;">
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
  const icons = { location: '📍', faction: '🏛', rule: '📜', system: '⚡' };
  if (!items.length) { host.innerHTML = emptyHint('点击 + 添加设定'); return; }
  host.innerHTML = `<div class="char-list" style="max-height:calc(100vh - 200px);overflow-y:auto;">
    ${items.map((w) => `
      <div class="char-card" data-action="edit-world" data-id="${attr(w.id)}">
        <div class="char-card-name">${icons[w.type] || '📌'} ${esc(w.name)}</div>
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
  host.innerHTML = `<div class="char-list" style="max-height:calc(100vh - 200px);overflow-y:auto;">
    ${notes.map((n) => `
      <div class="char-card" data-action="edit-note" data-id="${attr(n.id)}">
        <div class="char-card-name">${esc(n.title)}</div>
        <div class="char-card-desc">${esc((n.content || '').slice(0, 60))}</div>
      </div>`).join('')}
  </div>`;
}

// ═══════════════════ AI 工具箱 ═══════════════════

function renderAIPanelTools() {
  const host = document.getElementById('ai-panel-tools');
  if (!host) return;
  host.innerHTML = AI_TOOLS.map((t) =>
    `<button class="ai-tool-btn" data-action="run-ai" data-tool="${attr(t.id)}">${t.icon} ${esc(t.label)}</button>`
  ).join('');
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

  if (toolId === 'continue') {
    const ctx = await NovelDB.chapters.getWithPrev(novelId, APP.chapter.id);
    messages = [
      { role: 'system', content: '你是一名经验丰富的中文网文作家，负责在既有设定与前文之下续写。' },
      { role: 'user', content: NovelLLM.buildContinuePrompt({
          novel: APP.novel,
          characters,
          worldEntries: world,
          currentChapter: ctx?.chapter ? { ...ctx.chapter, content } : { title: APP.chapter.title, content },
          prevChapter: ctx?.prevChapter || null,
      }) },
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
  let full = '';
  let aborted = false;

  for await (const msg of NovelLLM.streamChat(messages, { max_tokens: spec.maxTokens, signal: APP.aiAbort.signal })) {
    if (msg.type === 'chunk') { full += msg.content; target.textContent = full; target.scrollTop = target.scrollHeight; }
    else if (msg.type === 'error') { target.textContent = `⚠️ ${msg.content}`; APP.aiAbort = null; return; }
    else if (msg.type === 'aborted') { aborted = true; break; }
  }
  APP.aiAbort = null;

  if (!full.trim()) {
    target.textContent = aborted ? '已中断，未产出内容' : '模型没有返回内容';
    return;
  }
  APP.lastAIResult = full;
  renderAIResult(target, full, { toolId, aborted });
}

/** 结果用 textContent 落文本、按钮用 DOM API 追加。
 *  旧版把模型输出 innerHTML 进面板（模型返回什么就执行什么），
 *  且 applyToEditor 从 textContent 回读，导致插入时多带一段按钮文字。 */
function renderAIResult(el, text, meta = {}) {
  el.textContent = text;

  const bar = document.createElement('div');
  bar.className = 'ai-result-actions';
  bar.style.cssText = 'margin-top:12px;border-top:1px solid var(--border);padding-top:12px;';

  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'btn btn-secondary';
    b.style.cssText = 'font-size:13px;padding:6px 14px;margin-right:8px;';
    b.textContent = label;
    if (title) b.title = title;
    b.onclick = fn;
    bar.appendChild(b);
  };

  mk('📋 复制', null, () => {
    navigator.clipboard.writeText(APP.lastAIResult).then(() => showToast('已复制'), () => showToast('复制失败'));
  });
  if (meta.toolId === 'continue' || meta.toolId === 'polish' || meta.toolId === 'summarize') {
    mk(meta.toolId === 'polish' ? '♻️ 替换正文' : '✍️ 插入编辑器', null, () => applyToEditor(meta.toolId));
  }
  if (meta.toolId === 'summarize') {
    mk('💾 存为笔记', null, async () => {
      await NovelDB.notes.save(APP.novel.id, { title: `${APP.chapter.title} · 摘要`, content: APP.lastAIResult });
      showToast('已存入笔记');
    });
  }
  el.appendChild(bar);
}

function applyToEditor(mode) {
  const text = APP.lastAIResult;
  const ta = document.getElementById('edt-content');
  if (!ta || !text) { showToast('请先打开章节'); return; }
  if (mode === 'polish') {
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
    out.textContent = r.ok ? '✅ 连接成功' : `❌ ${r.message}`;
  },
  'goto-global-settings': () => router.go('settings'),
});

// ═══════════════════ 全局设置页 ═══════════════════

function renderSettings() {
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
      <button class="btn btn-secondary" data-action="export-backup">导出全部作品备份</button>
    </div>
    <div class="settings-section" style="margin-top:20px;">
      <div class="settings-section-title">关于织文</div>
      <div class="settings-hint">NovelWeave · 织文 — AI 网文作者辅助工具<br>纯前端 · 零服务器 · IndexedDB 本地存储</div>
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
    showToast('已保存');
    if (!APP.novelId) renderHomePage();
  },
  's-test': async () => {
    const el = document.getElementById('s-result');
    el.textContent = '测试中…';
    const r = await NovelLLM.testConnection({ baseURL: val('s-baseurl'), apiKey: val('s-apikey'), model: val('s-model') });
    el.textContent = r.ok ? '✅ 连接成功' : `❌ ${r.message}`;
  },
  'export-backup': async () => {
    const dump = { app: 'novelweave', schemaVersion: 1, exportedAt: new Date().toISOString(), data: {} };
    for (const store of ['novels', 'chapters', 'characters', 'worldbuilding', 'notes']) {
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
