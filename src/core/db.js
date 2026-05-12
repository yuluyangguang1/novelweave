/**
 * NovelWeave · 织文 — IndexedDB 数据层
 * 小说文本量大，localStorage 不够用。用 IndexedDB 存储全书。
 */

const DB_NAME = 'novelweave_db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('novels')) db.createObjectStore('novels', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chapters')) {
        const s = db.createObjectStore('chapters', { keyPath: 'id' });
        s.createIndex('novel_id', 'novel_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('characters')) {
        const s = db.createObjectStore('characters', { keyPath: 'id' });
        s.createIndex('novel_id', 'novel_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('worldbuilding')) {
        const s = db.createObjectStore('worldbuilding', { keyPath: 'id' });
        s.createIndex('novel_id', 'novel_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('novel_id', 'novel_id', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(store, data) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(data);
    tx.oncomplete = () => res(data);
    tx.onerror = () => rej(tx.error);
  });
}

async function get(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}

async function getAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function getByIndex(store, field, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).index(field).getAll(value);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function del(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ═══════════ 小说 ═══════════

async function createNovel({ title, genre = '玄幻', description = '' }) {
  return put('novels', {
    id: 'novel_' + Date.now(), title, genre, description,
    word_count: 0, chapter_count: 0, created_at: Date.now(), updated_at: Date.now(),
  });
}

async function listNovels() {
  return (await getAll('novels')).map(n => ({
    id: n.id, title: n.title, genre: n.genre, description: n.description,
    word_count: n.word_count || 0, chapter_count: n.chapter_count || 0, updated_at: n.updated_at,
  }));
}

async function updateNovel(id, updates) {
  const n = await get('novels', id);
  if (!n) throw new Error('小说不存在');
  return put('novels', { ...n, ...updates, updated_at: Date.now() });
}

async function deleteNovel(id) {
  // 级联删除
  const chs = await getByIndex('chapters', 'novel_id', id);
  for (const c of chs) await del('chapters', c.id);
  const cs = await getByIndex('characters', 'novel_id', id);
  for (const c of cs) await del('characters', c.id);
  const ws = await getByIndex('worldbuilding', 'novel_id', id);
  for (const w of ws) await del('worldbuilding', w.id);
  const ns = await getByIndex('notes', 'novel_id', id);
  for (const n of ns) await del('notes', n.id);
  await del('novels', id);
}

// ═══════════ 章节 ═══════════

async function listChapters(novelId) {
  const all = await getByIndex('chapters', 'novel_id', novelId);
  return all.sort((a, b) => (a.order || 0) - (b.order || 0));
}

async function createChapter(novelId, { title, content = '', order = 0 }) {
  const ch = {
    id: 'ch_' + Date.now(), novel_id: novelId, title, content,
    word_count: content.length, order, created_at: Date.now(), updated_at: Date.now(),
  };
  await put('chapters', ch);
  // 更新小说统计
  const novel = await get('novels', novelId);
  if (novel) await put('novels', {
    ...novel,
    word_count: (novel.word_count || 0) + ch.word_count,
    chapter_count: (novel.chapter_count || 0) + 1,
  });
  return ch;
}

async function updateChapter(id, updates) {
  const ch = await get('chapters', id);
  if (!ch) throw new Error('章节不存在');
  const wordDelta = (updates.content?.length || 0) - (ch.content?.length || 0);
  const updated = { ...ch, ...updates, word_count: updates.content?.length ?? ch.word_count, updated_at: Date.now() };
  await put('chapters', updated);
  if (wordDelta !== 0) {
    const novel = await get('novels', ch.novel_id);
    if (novel) await put('novels', {
      ...novel,
      word_count: Math.max(0, (novel.word_count || 0) + wordDelta),
      updated_at: Date.now(),
    });
  }
  return updated;
}

async function deleteChapter(id) {
  const ch = await get('chapters', id);
  if (!ch) return;
  // 更新小说统计
  const novel = await get('novels', ch.novel_id);
  if (novel) await put('novels', {
    ...novel,
    word_count: Math.max(0, (novel.word_count || 0) - (ch.word_count || 0)),
    chapter_count: Math.max(0, (novel.chapter_count || 0) - 1),
  });
  await del('chapters', id);
}

// ═══════════ 角色 ═══════════

async function listCharacters(novelId) {
  return getByIndex('characters', 'novel_id', novelId);
}

async function createCharacter(novelId, data) {
  return put('characters', {
    id: 'char_' + Date.now(), novel_id: novelId,
    name: data.name, role: data.role || '配角',
    personality: data.personality || '', appearance: data.appearance || '',
    background: data.background || '', notes: data.notes || '',
    created_at: Date.now(),
  });
}

async function updateCharacter(id, updates) {
  const ch = await get('characters', id);
  if (!ch) throw new Error('角色不存在');
  return put('characters', { ...ch, ...updates });
}

// ═══════════ 世界设定 ═══════════

async function listWorldbuilding(novelId) { return getByIndex('worldbuilding', 'novel_id', novelId); }

async function createWorldbuilding(novelId, data) {
  return put('worldbuilding', {
    id: 'wb_' + Date.now(), novel_id: novelId,
    type: data.type || 'location', name: data.name,
    description: data.description || '', details: data.details || {},
    created_at: Date.now(),
  });
}

async function updateWorldbuilding(id, updates) {
  const w = await get('worldbuilding', id);
  if (!w) throw new Error('设定不存在');
  return put('worldbuilding', { ...w, ...updates });
}

// ═══════════ 笔记 ═══════════

async function listNotes(novelId) { return getByIndex('notes', 'novel_id', novelId); }

async function saveNote(novelId, { title = '', content = '', tags = [] }) {
  return put('notes', {
    id: 'note_' + Date.now(), novel_id: novelId,
    title, content, tags, created_at: Date.now(),
  });
}

// ── 全局暴露 ──
window.NovelDB = {
  novels:       { list: listNovels, get: (id) => get('novels', id), create: createNovel, update: updateNovel, delete: deleteNovel },
  chapters:     { list: listChapters, get: (id) => get('chapters', id), create: createChapter, update: updateChapter, delete: deleteChapter },
  characters:   { list: listCharacters, get: (id) => get('characters', id), create: createCharacter, update: updateCharacter, delete: (id) => del('characters', id) },
  worldbuilding:{ list: listWorldbuilding, get: (id) => get('worldbuilding', id), create: createWorldbuilding, update: updateWorldbuilding, delete: (id) => del('worldbuilding', id) },
  notes:        { list: listNotes, save: saveNote, get: (id) => get('notes', id) },
};
