/**
 * NovelWeave · 织文 — 主应用入口
 */

const APP = {
  currentNovel: null,
  currentChapter: null,
  activeTab: 'chapters',
  autoSaveTimer: null,
};

function escapeHtml(t) {
  const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML;
}

function formatWordCount(n) {
  if (!n) return '0 字';
  if (n < 10000) return `${n} 字`;
  return `${(n / 10000).toFixed(1)} 万字`;
}

function showToast(msg, dur = 2000) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div'); t.id = 'toast'; t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg; t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), dur);
}

// ═══════════════════ 初始化 ═══════════════════
async function initApp() {
  router.onPage = onPageEntered;
  // 首次使用：先配置 API Key
  if (!NovelLLM.hasConfig()) {
    router.go('settings');
    return;
  }
  renderHomePage();
}

async function onPageEntered(page, params) {
  if (page === 'home') await renderHomePage();
  if (page === 'workspace') await enterWorkspace(params);
  if (page === 'settings') renderSettings();
}

// ═══════════════════ 首页 ═══════════════════
async function renderHomePage() {
  const novels = await NovelDB.novels.list();
  const listEl = document.getElementById('novel-list');
  const emptyEl = document.getElementById('home-empty');
  
  if (!novels.length) {
    emptyEl.style.display = '';
    listEl.innerHTML = '';
    return;
  }
  
  emptyEl.style.display = 'none';
  listEl.innerHTML = novels.map(n => {
    const d = n.updated_at ? new Date(n.updated_at).toLocaleDateString('zh-CN') : '';
    return `<div class="novel-card" onclick="openWorkspace('${n.id}')">
      <div class="novel-card-actions">
        <button class="del-btn" onclick="event.stopPropagation(); confirmDeleteNovel('${n.id}', '${escapeHtml(n.title)}')">🗑️</button>
      </div>
      <div class="novel-card-title">${escapeHtml(n.title)}</div>
      <div class="novel-card-meta">
        <span>${escapeHtml(n.genre)}</span>
        <span>${n.chapter_count || 0} 章</span>
        <span>${formatWordCount(n.word_count)}</span>
        <span>${d}</span>
      </div>
    </div>`;
  }).join('');
}

function showCreateNovel() {
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  o.innerHTML = `<div class="modal">
    <div class="modal-title">创建新作品</div>
    <div class="settings-field">
      <label class="settings-label">作品名称</label>
      <input class="settings-input" id="inp-novel-title" placeholder="输入小说名字" maxlength="50">
    </div>
    <div class="settings-field">
      <label class="settings-label">类型</label>
      <select class="settings-select" id="inp-novel-genre">
        ${['玄幻','都市','仙侠','科幻','历史','武侠','奇幻','现实','悬疑','轻小说','同人','游戏'].map(g => `<option value="${g}">${g}</option>`).join('')}
      </select>
    </div>
    <div class="settings-field">
      <label class="settings-label">概述（可选）</label>
      <textarea class="settings-input" id="inp-novel-desc" rows="2" placeholder="一句话简介"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
      <button class="btn btn-primary" onclick="doCreateNovel()">创建</button>
    </div>
  </div>`;
  document.body.appendChild(o);
  setTimeout(() => document.getElementById('inp-novel-title')?.focus(), 100);
}

async function doCreateNovel() {
  const title = document.getElementById('inp-novel-title').value.trim();
  if (!title) { showToast('请输入作品名称'); return; }
  await NovelDB.novels.create({
    title,
    genre: document.getElementById('inp-novel-genre').value,
    description: document.getElementById('inp-novel-desc').value.trim(),
  });
  o.remove();
  showToast(`"${title}" 已创建`);
  renderHomePage();
}

async function confirmDeleteNovel(id, title) {
  if (!confirm(`确定删除「${title}」？所有章节、角色、设定将永久丢失。`)) return;
  if (!confirm('最后确认：真的要删除吗？')) return;
  await NovelDB.novels.delete(id);
  showToast(`"${title}" 已删除`);
  renderHomePage();
}

async function openWorkspace(novelId) {
  const novel = await NovelDB.novels.get(novelId);
  if (!novel) { showToast('小说不存在'); return; }
  APP.currentNovel = novel;
  router.go('workspace', { novelId });
}

// ═══════════════════ 工作区 ═══════════════════
async function enterWorkspace(params) {
  await renderSidebar(APP.currentNovel);
  APP.activeTab = 'chapters';
  await renderSidebarContent();
  
  const chapters = await NovelDB.chapters.list(APP.currentNovel.id);
  if (chapters.length && !APP.currentChapter) openChapter(chapters[0]);
  else if (!chapters.length) showEditorEmpty();
}

async function renderSidebar(novel) {
  const chars = await NovelDB.characters.list(novel.id);
  document.getElementById('sidebar-nav').innerHTML = `
    <div style="padding:12px; border-bottom:1px solid var(--border);">
      <button class="sidebar-back" onclick="router.go('home')">← 返回</button>
      <div style="margin-top:6px; font-size:14px; color:var(--text-primary); font-family:Georgia,serif; font-weight:600;">${escapeHtml(novel.title)}</div>
    </div>
    <div style="padding:8px;">
      <div class="sidebar-nav-item ${APP.activeTab==='chapters'?'active':''}" onclick="switchTab('chapters')">
        <span class="sidebar-nav-icon">📝</span><span class="sidebar-nav-label">章节</span>
        <span class="sidebar-nav-add" onclick="event.stopPropagation();addChapter()" title="添加章节">+</span>
      </div>
      <div class="sidebar-nav-item ${APP.activeTab==='characters'?'active':''}" onclick="switchTab('characters')">
        <span class="sidebar-nav-icon">👥</span><span class="sidebar-nav-label">角色</span>
        <span class="sidebar-nav-count">${chars.length}</span>
        <span class="sidebar-nav-add" onclick="event.stopPropagation();showCreateCharacter()" title="添加角色">+</span>
      </div>
      <div class="sidebar-nav-item ${APP.activeTab==='world'?'active':''}" onclick="switchTab('world')">
        <span class="sidebar-nav-icon">🌍</span><span class="sidebar-nav-label">世界设定</span>
        <span class="sidebar-nav-add" onclick="event.stopPropagation();showCreateWorldbuilding()" title="添加设定">+</span>
      </div>
      <div class="sidebar-nav-item ${APP.activeTab==='notes'?'active':''}" onclick="switchTab('notes')">
        <span class="sidebar-nav-icon">📒</span><span class="sidebar-nav-label">写作笔记</span>
        <span class="sidebar-nav-add" onclick="event.stopPropagation();showCreateNote()" title="添加笔记">+</span>
      </div>
      <div class="sidebar-nav-item ${APP.activeTab==='settings'?'active':''}" onclick="switchTab('settings')">
        <span class="sidebar-nav-icon">⚙️</span><span class="sidebar-nav-label">AI 设置</span>
      </div>
    </div>`;
}

function switchTab(tab) {
  APP.activeTab = tab;
  renderSidebar(APP.currentNovel);
  renderSidebarContent();
}

async function renderSidebarContent() {
  // The sidebar content replaces itself - the main area is the editor
  // The sidebar already has the nav, we just need to ensure the chapter list shows
  // Actually, let me simplify: sidebar = nav + chapter list (or other content)
  // The sidebar should show nav items AND the list below it
  // Let me re-render the whole sidebar when switching tabs
  await renderSidebar(APP.currentNovel);
  // Update active state
  document.querySelectorAll('.sidebar-nav-item').forEach(el => {
    el.classList.toggle('active', el.textContent.trim().includes(
      {chapters:'章节',characters:'角色',world:'世界',notes:'笔记',settings:'设置'}[APP.activeTab] || ''
    ));
  });
}

// ═══════════════════ 编辑器 ═══════════════════
function openChapter(chapter) {
  APP.currentChapter = chapter;
  const hdr = document.getElementById('editor-header');
  const area = document.getElementById('editor-area');
  
  hdr.innerHTML = `
    <input class="editor-title" id="edt-title" value="${escapeHtml(chapter.title)}" onchange="updateChapterTitle('${chapter.id}',this.value)">
    <div class="editor-toolbar">
      <span class="word-count" id="wc-label">${formatWordCount(chapter.word_count)}</span>
      <button class="ai-btn" onclick="openAIPanel('continue')">✍️</button>
      <button onclick="openAIPanel('consistency')">🔍</button>
      <button onclick="openAIPanel('summarize')">📋</button>
      <button onclick="saveChapter()">💾</button>
    </div>`;
  
  area.innerHTML = `<textarea class="editor-textarea" id="edt-content" placeholder="开始写作吧..." oninput="onEditorInput()">${escapeHtml(chapter.content||'')}</textarea>`;
  startAutoSave(chapter.id);
  
  // Highlight active chapter in sidebar
  document.querySelectorAll('.chapter-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-ch-id') === chapter.id);
  });
  
  renderChapterList();
}

function showEditorEmpty() {
  document.getElementById('editor-header').innerHTML = '';
  document.getElementById('editor-area').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);">选择或创建章节</div>';
  renderChapterList();
}

function onEditorInput() {
  const ta = document.getElementById('edt-content');
  const wc = document.getElementById('wc-label');
  if (wc) wc.textContent = formatWordCount(ta.value.length);
}

function startAutoSave(chapterId) {
  stopAutoSave();
  APP.autoSaveTimer = setInterval(() => saveChapter(chapterId, true), 15000);
}

function stopAutoSave() {
  if (APP.autoSaveTimer) { clearInterval(APP.autoSaveTimer); APP.autoSaveTimer = null; }
}

async function saveChapter(idOrSkip, silent) {
  const id = idOrSkip || APP.currentChapter?.id;
  if (!id) return;
  const ta = document.getElementById('edt-content');
  const title = document.getElementById('edt-title')?.value;
  if (!ta && !silent) { showToast('编辑器未打开'); return; }
  if (ta) {
    await NovelDB.chapters.update(id, { title: title, content: ta.value });
  }
  if (!silent) showToast('💾 已保存');
}

async function updateChapterTitle(id, title) {
  await NovelDB.chapters.update(id, { title });
  showToast('标题已更新');
}

async function addChapter() {
  const chapters = await NovelDB.chapters.list(APP.currentNovel.id);
  const next = chapters.length + 1;
  const titles = ['','第一章','第二章','第三章','第四章','第五章','第六章','第七章','第八章','第九章','第十章'];
  const title = titles[next] || `第${next}章`;
  
  const ch = await NovelDB.chapters.create(APP.currentNovel.id, { title, order: next });
  showToast(`"${title}" 已创建`);
  renderSidebar(APP.currentNovel);
  openChapter(ch);
}

// Show chapters in sidebar
async function renderChapterList() {
  const chapters = await NovelDB.chapters.list(APP.currentNovel.id);
  const contentEl = document.getElementById('sidebar-content');
  if (!contentEl) return;
  
  if (chapters.length) {
    contentEl.innerHTML = `<div class="chapter-list" style="max-height:calc(100vh - 160px);overflow-y:auto;">
      ${chapters.map(ch => `
        <div class="chapter-item ${APP.currentChapter?.id===ch.id?'active':''}" data-ch-id="${ch.id}" onclick="openChapter({id:'${ch.id}',title:'${escapeHtml(ch.title)}',content:${JSON.stringify(ch.content||'')},word_count:${ch.word_count||0}})">
          <span class="chapter-item-number">${ch.order||'-'}</span>
          <span class="chapter-item-title">${escapeHtml(ch.title)}</span>
          <span class="chapter-item-words">${formatWordCount(ch.word_count)}</span>
          <button class="chapter-item-del" onclick="event.stopPropagation();deleteCh('${ch.id}')">×</button>
        </div>`).join('')}
    </div>`;
  } else {
    contentEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:14px;">点击 <b>+</b> 创建第一章</div>';
  }
}

async function deleteCh(id) {
  if (!confirm('删除此章节？')) return;
  await NovelDB.chapters.delete(id);
  if (APP.currentChapter?.id === id) showEditorEmpty();
  showToast('🗑️ 已删除');
  renderSidebar(APP.currentNovel);
  renderChapterList();
}

// ═══════════════════ 角色管理 ═══════════════════
function showCreateCharacter() {
  showModal('添加角色', `
    <div class="settings-field"><label class="settings-label">角色名称</label><input class="settings-input" id="m-char-name" placeholder="角色名字"></div>
    <div class="settings-field"><label class="settings-label">定位</label><select class="settings-select" id="m-char-role"><option>主角</option><option>配角</option><option>反派</option><option>导师</option><option>龙套</option></select></div>
    <div class="settings-field"><label class="settings-label">性格特点</label><textarea class="settings-input" id="m-char-personality" rows="2" placeholder="简短描述性格"></textarea></div>
    <div class="settings-field"><label class="settings-label">外观描述</label><textarea class="settings-input" id="m-char-appearance" rows="2" placeholder="外貌、穿着等"></textarea></div>
    <div class="settings-field"><label class="settings-label">背景故事</label><textarea class="settings-input" id="m-char-background" rows="3" placeholder="角色的背景经历"></textarea></div>
  `, async () => {
    const name = document.getElementById('m-char-name').value.trim();
    if (!name) { showToast('请输入角色名称'); return; }
    await NovelDB.characters.create(APP.currentNovel.id, {
      name, role: document.getElementById('m-char-role').value,
      personality: document.getElementById('m-char-personality').value.trim(),
      appearance: document.getElementById('m-char-appearance').value.trim(),
      background: document.getElementById('m-char-background').value.trim(),
    });
    showToast(`"${name}" 已添加`);
    switchTab('characters');
  });
}

async function editCharacter(id) {
  const ch = await NovelDB.characters.get(id);
  showModal('编辑角色', `
    <div class="settings-field"><label class="settings-label">角色名称</label><input class="settings-input" id="e-char-name" value="${escapeHtml(ch.name)}"></div>
    <div class="settings-field"><label class="settings-label">定位</label><select class="settings-select" id="e-char-role">${['主角','配角','反派','导师','龙套'].map(r => `<option value="${r}" ${ch.role===r?'selected':''}>${r}</option>`).join('')}</select></div>
    <div class="settings-field"><label class="settings-label">性格特点</label><textarea class="settings-input" id="e-char-personality" rows="2">${escapeHtml(ch.personality||'')}</textarea></div>
    <div class="settings-field"><label class="settings-label">外观描述</label><textarea class="settings-input" id="e-char-appearance" rows="2">${escapeHtml(ch.appearance||'')}</textarea></div>
    <div class="settings-field"><label class="settings-label">背景故事</label><textarea class="settings-input" id="e-char-background" rows="4">${escapeHtml(ch.background||'')}</textarea></div>
    <div class="settings-field"><label class="settings-label">备注</label><textarea class="settings-input" id="e-char-notes" rows="2">${escapeHtml(ch.notes||'')}</textarea></div>
  `, async () => {
    await NovelDB.characters.update(id, {
      name: document.getElementById('e-char-name').value.trim(),
      role: document.getElementById('e-char-role').value,
      personality: document.getElementById('e-char-personality').value.trim(),
      appearance: document.getElementById('e-char-appearance').value.trim(),
      background: document.getElementById('e-char-background').value.trim(),
      notes: document.getElementById('e-char-notes').value.trim(),
    });
    showToast('✅ 角色已更新'); switchTab('characters');
  }, async () => {
    if (confirm('删除此角色？')) { await NovelDB.characters.delete(id); showToast('🗑️ 已删除'); switchTab('characters'); }
  });
}

async function showCharacterList() {
  const chars = await NovelDB.characters.list(APP.currentNovel.id);
  const el = document.getElementById('sidebar-content');
  if (!chars.length) {
    el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:14px;">点击 <b>+</b> 创建角色</div>';
    return;
  }
  el.innerHTML = `<div class="char-list" style="max-height:calc(100vh - 160px);overflow-y:auto;">
    ${chars.map(ch => `
    <div class="char-card" onclick="editCharacter('${ch.id}')">
      <div class="char-card-name">${escapeHtml(ch.name)}</div>
      <div class="char-card-role">${ch.role||'角色'}</div>
      <div class="char-card-desc">${escapeHtml(ch.personality?.slice(0,50)||'')}</div>
    </div>`).join('')}
  </div>`;
}

// ═══════════════════ 世界设定 ═══════════════════
function showCreateWorldbuilding() {
  showModal('添加世界设定', `
    <div class="settings-field"><label class="settings-label">类型</label><select class="settings-select" id="m-wb-type"><option value="location">📍 地点</option><option value="faction">🏛 势力/组织</option><option value="rule">📜 规则/法则</option><option value="system">⚡ 力量体系</option></select></div>
    <div class="settings-field"><label class="settings-label">名称</label><input class="settings-input" id="m-wb-name" placeholder="名称"></div>
    <div class="settings-field"><label class="settings-label">详细描述</label><textarea class="settings-input" id="m-wb-desc" rows="5" placeholder="详细描述..."></textarea></div>
  `, async () => {
    const name = document.getElementById('m-wb-name').value.trim();
    if (!name) { showToast('请输入名称'); return; }
    await NovelDB.worldbuilding.create(APP.currentNovel.id, {
      type: document.getElementById('m-wb-type').value, name,
      description: document.getElementById('m-wb-desc').value.trim(),
    });
    showToast(`"${name}" 已添加`); switchTab('world');
  });
}

async function editWorldbuilding(id) {
  const w = await NovelDB.worldbuilding.get(id);
  const typeLabel = {location:'📍 地点',faction:'🏛 势力',rule:'📜 规则',system:'⚡ 体系'}[w.type]||w.type;
  showModal('编辑设定', `
    <div class="settings-field"><label class="settings-label">名称</label><input class="settings-input" id="e-wb-name" value="${escapeHtml(w.name)}"></div>
    <div class="settings-field"><label class="settings-label">描述</label><textarea class="settings-input" id="e-wb-desc" rows="8">${escapeHtml(w.description||'')}</textarea></div>
  `, async () => {
    await NovelDB.worldbuilding.update(id, {
      name: document.getElementById('e-wb-name').value.trim(),
      description: document.getElementById('e-wb-desc').value.trim(),
    });
    showToast('✅ 已更新'); switchTab('world');
  }, async () => {
    if (confirm('删除？')) { await NovelDB.worldbuilding.delete(id); showToast('🗑️ 已删除'); switchTab('world'); }
  });
}

async function showWorldList() {
  const items = await NovelDB.worldbuilding.list(APP.currentNovel.id);
  const el = document.getElementById('sidebar-content');
  const types = {location:'📍',faction:'🏛',rule:'📜',system:'⚡'};
  if (!items.length) {
    el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:14px;">点击 <b>+</b> 添加设定</div>';
    return;
  }
  el.innerHTML = `<div class="char-list" style="max-height:calc(100vh - 160px);overflow-y:auto;">
    ${items.map(w => `
    <div class="char-card" onclick="editWorldbuilding('${w.id}')">
      <div class="char-card-name">${types[w.type]||''} ${escapeHtml(w.name)}</div>
      <div class="char-card-desc">${escapeHtml(w.description?.slice(0,80)||'')}</div>
    </div>`).join('')}
  </div>`;
}

// ═══════════════════ 写作笔记 ═══════════════════
function showCreateNote() {
  showModal('添加笔记', `
    <div class="settings-field"><label class="settings-label">标题</label><input class="settings-input" id="m-note-title" placeholder="笔记标题"></div>
    <div class="settings-field"><label class="settings-label">内容</label><textarea class="settings-input" id="m-note-content" rows="6" placeholder="写作备忘、灵感、伏笔记录..."></textarea></div>
  `, async () => {
    const title = document.getElementById('m-note-title').value.trim() || '无标题';
    await NovelDB.notes.save(APP.currentNovel.id, {
      title, content: document.getElementById('m-note-content').value.trim(),
    });
    showToast('📒 笔记已保存'); switchTab('notes');
  });
}

async function showNotesList() {
  const notes = await NovelDB.notes.list(APP.currentNovel.id);
  const el = document.getElementById('sidebar-content');
  if (!notes.length) {
    el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:14px;">点击 <b>+</b> 添加笔记</div>';
    return;
  }
  el.innerHTML = `<div class="char-list" style="max-height:calc(100vh - 160px);overflow-y:auto;">
    ${notes.map(n => `
    <div class="char-card" onclick="showToast('${escapeHtml(n.title)}: ${escapeHtml((n.content||'').slice(0,30))}')">
      <div class="char-card-name">${escapeHtml(n.title)}</div>
      <div class="char-card-desc">${escapeHtml((n.content||'').slice(0,60))}</div>
    </div>`).join('')}
  </div>`;
}

// ═══════════════════ 设置 (工作区内) ═══════════════════
function renderWorkspaceSettings() {
  const el = document.getElementById('sidebar-content');
  const cfg = NovelLLM.getConfig();
  el.innerHTML = `<div style="padding:12px;">
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">配置 AI API（Key 保存在本机浏览器）</div>
    <div class="settings-field"><label class="settings-label">服务商</label>
      <select class="settings-input" id="ws-provider" onchange="onWSProviderChange(this.value)">
        ${Object.entries(NovelLLM.PRESETS).map(([k,p]) => `<option value="${k}" ${cfg?.provider===k?'selected':''}>${p.label}</option>`).join('')}
      </select>
    </div>
    <div class="settings-field"><label class="settings-label">Base URL</label><input class="settings-input" id="ws-baseurl" value="${escapeHtml(cfg?.baseURL||'')}"></div>
    <div class="settings-field"><label class="settings-label">API Key</label><input class="settings-input" id="ws-apikey" type="password" value="${escapeHtml(cfg?.apiKey||'')}" placeholder="sk-..."></div>
    <div class="settings-field"><label class="settings-label">模型</label><input class="settings-input" id="ws-model" value="${escapeHtml(cfg?.model||'')}"></div>
    <button class="btn btn-primary" style="width:100%;margin-top:8px;" onclick="saveWSSettings()">保存</button>
    <button class="btn btn-secondary" style="width:100%;margin-top:8px;" onclick="testWSSettings()">测试连接</button>
    <div id="ws-result" style="margin-top:8px;font-size:12px;color:var(--text-secondary);"></div>
  </div>`;
}

function onWSProviderChange(provider) {
  const p = NovelLLM.PRESETS[provider];
  if (p) { 
    document.getElementById('ws-baseurl').value = p.baseURL;
    document.getElementById('ws-model').value = p.defaultModel;
  }
}

function saveWSSettings() {
  NovelLLM.setConfig({
    provider: document.getElementById('ws-provider').value,
    baseURL: document.getElementById('ws-baseurl').value.trim(),
    apiKey: document.getElementById('ws-apikey').value.trim(),
    model: document.getElementById('ws-model').value.trim(),
  });
  showToast('✅ 设置已保存');
}

async function testWSSettings() {
  const result = document.getElementById('ws-result');
  result.textContent = '🔄 测试中...';
  const cfg = {
    baseURL: document.getElementById('ws-baseurl').value.trim(),
    apiKey: document.getElementById('ws-apikey').value.trim(),
    model: document.getElementById('ws-model').value.trim(),
  };
  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/$/,'')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{role:'user',content:'ping'}], max_tokens: 5, stream: false }),
    });
    result.textContent = res.ok ? '✅ 连接成功' : `❌ HTTP ${res.status}: ${(await res.text()).slice(0,100)}`;
    result.style.color = res.ok ? 'var(--success)' : 'var(--danger)';
  } catch (e) {
    result.textContent = `❌ ${e.message}`;
    result.style.color = 'var(--danger)';
  }
}

// ═══════════════════ Modal ═══════════════════
function showModal(title, bodyHTML, onSave, onDelete) {
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  o.innerHTML = `<div class="modal"><div class="modal-title">${title}</div>${bodyHTML}
    <div class="modal-actions">
      ${onDelete ? '<button class="btn btn-danger" id="modal-del-btn">删除</button>' : ''}
      <div style="flex:1"></div>
      <button class="btn btn-secondary" id="modal-cancel">取消</button>
      <button class="btn btn-primary" id="modal-save">保存</button>
    </div></div>`;
  document.body.appendChild(o);
  document.getElementById('modal-cancel').onclick = () => o.remove();
  o.addEventListener('click', e => { if (e.target === o) o.remove(); });
  if (onDelete) document.getElementById('modal-del-btn').onclick = onDelete;
  document.getElementById('modal-save').onclick = onSave;
}

// ═══════════════════ AI 面板包装 ═══════════════════
function openAIPanel(tool) {
  if (!NovelLLM.hasConfig()) { showToast('请先配置 API'); switchTab('settings'); return; }
  document.getElementById('ai-panel').classList.remove('hidden');
  document.getElementById('ai-panel-overlay').classList.remove('hidden');
  const outputEl = document.getElementById('ai-output');
  outputEl.innerHTML = '<span style="color:var(--text-secondary)">🤖 正在处理...</span>';
  
  runAITool(tool, outputEl);
}

function closeAIPanel() {
  document.getElementById('ai-panel').classList.add('hidden');
  document.getElementById('ai-panel-overlay').classList.add('hidden');
}

async function runAITool(tool, target) {
  target.innerHTML = '';
  let full = '';
  let messages = [];
  
  if (tool === 'continue') {
    const chars = await NovelDB.characters.list(APP.currentNovel.id);
    messages = [{role:'system',content:'你是一个经验丰富的网文作家，根据设定续写下一章。'},{role:'user',content:NovelLLM.buildContinuePrompt(APP.currentChapter, null, APP.currentNovel, chars)}];
  } else if (tool === 'consistency') {
    const content = document.getElementById('edt-content')?.value;
    if (!content || content.length < 100) { target.innerHTML = '<span style="color:var(--text-secondary)">请先写至少 100 字</span>'; return; }
    const chars = await NovelDB.characters.list(APP.currentNovel.id);
    messages = [{role:'system',content:'你是专业的网文编辑，检查角色人设是否前后一致。'},{role:'user',content:NovelLLM.buildConsistencyCheckPrompt(content, chars)}];
  } else if (tool === 'summarize') {
    const content = document.getElementById('edt-content')?.value;
    if (!content) { target.innerHTML = '<span style="color:var(--text-secondary)">请先打开一个章节</span>'; return; }
    messages = [{role:'system',content:'总结下面章节。200 字以内，包括核心事件、出场角色、剧情推进。'},{role:'user',content:content.slice(0,8000)}];
  } else if (tool === 'outline') {
    const chars = await NovelDB.chapters.list(APP.currentNovel.id);
    messages = [{role:'system',content:'你是资深网文策划编辑。'},{role:'user',content:NovelLLM.buildOutlinePrompt(APP.currentNovel, chars)}];
  } else if (tool === 'polish') {
    const content = document.getElementById('edt-content')?.value;
    if (!content) { target.innerHTML = '<span style="color:var(--text-secondary)">请打开一个章节</span>'; return; }
    messages = [{role:'system',content:'润色下面文字，保持原意和风格，使表达更流畅、有画面感。只输出润色结果。'},{role:'user',content:content.slice(0,3000)}];
  }
  
  for await (const msg of NovelLLM.streamChat(messages, {max_tokens: tool==='consistency'||tool==='outline'||tool==='summarize'?4000:8000})) {
    if (msg.type === 'chunk') { full += msg.content; target.textContent = full; target.scrollTop = target.scrollHeight; }
    else if (msg.type === 'error') { target.textContent = `⚠️ ${msg.content}`; return; }
  }
  
  // Add action buttons after streaming
  target.innerHTML = full + `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
    <button class="btn btn-secondary" onclick="navigator.clipboard.writeText(document.getElementById('ai-output').textContent);showToast('已复制')" style="font-size:13px;padding:6px 14px;margin-right:8px;">📋 复制</button>
    <button class="btn btn-secondary" onclick="applyToEditor()" style="font-size:13px;padding:6px 14px;">✍️ 插入编辑器</button>
  </div>`;
}

function applyToEditor() {
  const text = document.getElementById('ai-output').textContent;
  const ta = document.getElementById('edt-content');
  if (!ta) { showToast('请先打开章节'); return; }
  const pos = ta.selectionStart;
  ta.value = ta.value.slice(0,pos) + text + ta.value.slice(pos);
  ta.focus(); ta.selectionStart = ta.selectionEnd = pos + text.length;
  ta.dispatchEvent(new Event('input'));
  showToast('✅ 已插入'); closeAIPanel();
}

// ═══════════════════ 全局设置页 ═══════════════════
function renderSettings() {
  const cfg = NovelLLM.getConfig();
  document.getElementById('settings-body').innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">AI API 配置</div>
      <div class="settings-hint" style="margin-bottom:12px;">选择服务商，填入 API Key。<br>Key 只保存在本机浏览器。</div>
      <div class="settings-presets">
        ${Object.entries(NovelLLM.PRESETS).map(([k,p]) => `<button class="preset-btn ${cfg?.provider===k?'active':''}" onclick="selectProvider('${k}')"><div class="preset-btn-label">${p.label}</div><div class="preset-btn-note">${p.note}</div></button>`).join('')}
      </div>
      <input type="hidden" id="s-provider" value="${cfg?.provider||'openrouter'}">
      <div class="settings-field"><label class="settings-label">Base URL</label><input class="settings-input" id="s-baseurl" value="${escapeHtml(cfg?.baseURL||NovelLLM.PRESETS.openrouter.baseURL)}"></div>
      <div class="settings-field"><label class="settings-label">API Key</label><input class="settings-input" id="s-apikey" type="password" value="${escapeHtml(cfg?.apiKey||'')}" placeholder="sk-..."></div>
      <div class="settings-field"><label class="settings-label">模型</label><input class="settings-input" id="s-model" value="${escapeHtml(cfg?.model||NovelLLM.PRESETS.openrouter.defaultModel)}"></div>
      <div class="settings-actions"><button class="btn btn-secondary" onclick="testSettings()">测试连接</button><button class="btn btn-primary" onclick="saveSettings()">保存</button></div>
      <div id="s-result" style="margin-top:12px;font-size:13px;min-height:1em;"></div>
    </div>
    <div class="settings-section" style="margin-top:20px;">
      <div class="settings-section-title">关于织文</div>
      <div class="settings-hint">NovelWeave · 织文 — AI 网文作者辅助工具<br>纯前端 · 零服务器 · IndexedDB 本地存储<br>建议定期备份你的作品</div>
    </div>`;
}

function selectProvider(p) {
  const pr = NovelLLM.PRESETS[p];
  if (!pr) return;
  document.getElementById('s-provider').value = p;
  document.getElementById('s-baseurl').value = pr.baseURL;
  document.getElementById('s-model').value = pr.defaultModel;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  event.target.closest('.preset-btn').classList.add('active');
}

function saveSettings() {
  NovelLLM.setConfig({
    provider: document.getElementById('s-provider').value,
    baseURL: document.getElementById('s-baseurl').value.trim(),
    apiKey: document.getElementById('s-apikey').value.trim(),
    model: document.getElementById('s-model').value.trim(),
  });
  showToast('✅ 已保存');
}

async function testSettings() {
  const el = document.getElementById('s-result');
  el.textContent = '🔄 测试中...'; el.style.color = 'var(--text-secondary)';
  const cfg = { baseURL: document.getElementById('s-baseurl').value.trim(), apiKey: document.getElementById('s-apikey').value.trim(), model: document.getElementById('s-model').value.trim() };
  try {
    const res = await fetch(`${cfg.baseURL.replace(/\/$/,'')}/chat/completions`, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${cfg.apiKey}`},
      body:JSON.stringify({model:cfg.model,messages:[{role:'user',content:'ping'}],max_tokens:5,stream:false}),
    });
    el.textContent = res.ok ? '✅ 连接成功' : `❌ HTTP ${res.status}: ${(await res.text()).slice(0,150)}`;
    el.style.color = res.ok ? 'var(--success)' : 'var(--danger)';
  } catch(e) { el.textContent = `❌ ${e.message}`; el.style.color = 'var(--danger)'; }
}
