/**
 * NovelWeave · 织文 — IndexedDB 数据层
 * 小说文本量大，localStorage 不够用。用 IndexedDB 存储全书。
 *
 * 两条纪律：
 * 1. 统计量（word_count / chapter_count）永远是派生值，由 recount 全量重算，
 *    不做增量加减。旧版用 wordDelta 增量记账，只在「同时传 content」时才正确，
 *    单改标题会把一整章字数从总数里扣掉。
 * 2. 主键不用 Date.now()。同毫秒连点两次「+」会让后一条静默覆盖前一条。
 */

const DB_NAME = 'novelweave_db';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('novels')) db.createObjectStore('novels', { keyPath: 'id' });
      for (const name of ['chapters', 'characters', 'worldbuilding', 'notes']) {
        if (!db.objectStoreNames.contains(name)) {
          const s = db.createObjectStore(name, { keyPath: 'id' });
          s.createIndex('novel_id', 'novel_id', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _dbPromise = null; reject(req.error); };
    req.onblocked = () => { _dbPromise = null; reject(new Error('IndexedDB 被其他标签页占用，请关闭后重试')); };
  });
  return _dbPromise;
}

/** 通用事务包装：一次操作一次连接开销，但绝不在回调里再开连接。 */
async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    try { out = fn(t.objectStore(store)); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务被中止'));
  });
}

async function put(store, data) {
  await tx(store, 'readwrite', (s) => s.put(data));
  return data;
}
async function get(store, id) {
  const r = await tx(store, 'readonly', (s) => s.get(id));
  return r || null;
}
async function getAll(store) {
  return (await tx(store, 'readonly', (s) => s.getAll())) || [];
}
async function getByIndex(store, field, value) {
  return (await tx(store, 'readonly', (s) => s.index(field).getAll(value))) || [];
}
async function del(store, id) {
  await tx(store, 'readwrite', (s) => s.delete(id));
}

function newId(prefix) {
  const rnd = (self.crypto?.randomUUID)
    ? self.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  return `${prefix}_${rnd}`;
}

function words(text) {
  return NWText.countWords(text || '');
}

/** 列表稳定排序：先按显式 order（章节），再按创建时间，最后按 id。不能依赖键序。 */
function stableSort(list, { byOrder = false } = {}) {
  return [...list].sort((a, b) => {
    if (byOrder) {
      const ao = a.order ?? 0, bo = b.order ?? 0;
      if (ao !== bo) return ao - bo;
    }
    const at = a.created_at ?? 0, bt = b.created_at ?? 0;
    if (at !== bt) return at - bt;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

// ═══════════ 派生统计 ═══════════

/** 全量重算一本书的字数与章数。所有写操作之后调它，别做增量加减。 */
async function recountNovelStats(novelId) {
  const novel = await get('novels', novelId);
  if (!novel) return null;
  const chapters = await getByIndex('chapters', 'novel_id', novelId);
  const word_count = chapters.reduce((sum, c) => sum + words(c.content), 0);
  const stats = { word_count, chapter_count: chapters.length };
  const changed = novel.word_count !== word_count || novel.chapter_count !== chapters.length;
  if (changed) return put('novels', { ...novel, ...stats });
  return novel;
}

/** 修历史数据：旧版增量记账已经把这些数字弄错了。启动时跑一次。 */
async function recountAll() {
  const novels = await getAll('novels');
  for (const n of novels) await recountNovelStats(n.id);
  return novels.length;
}

/** 章节号去重补洞，保持现有相对顺序。 */
async function resequenceChapters(novelId) {
  const chapters = stableSort(await getByIndex('chapters', 'novel_id', novelId), { byOrder: true });
  let i = 1;
  for (const ch of chapters) {
    if (ch.order !== i) await put('chapters', { ...ch, order: i });
    i++;
  }
}

// ═══════════ 小说 ═══════════

async function createNovel({ title, genre = '玄幻', description = '' }) {
  return put('novels', {
    id: newId('novel'), title, genre, description,
    word_count: 0, chapter_count: 0, created_at: Date.now(), updated_at: Date.now(),
  });
}

async function listNovels() {
  const all = await getAll('novels');
  const sorted = [...all].sort((a, b) => {
    const at = a.updated_at ?? a.created_at ?? 0;
    const bt = b.updated_at ?? b.created_at ?? 0;
    if (at !== bt) return bt - at;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
  return sorted.map((n) => ({
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
  for (const store of ['chapters', 'characters', 'worldbuilding', 'notes']) {
    const rows = await getByIndex(store, 'novel_id', id);
    for (const r of rows) await del(store, r.id);
  }
  await del('novels', id);
}

// ═══════════ 章节 ═══════════

async function listChapters(novelId) {
  return stableSort(await getByIndex('chapters', 'novel_id', novelId), { byOrder: true });
}

/** 下一个可用章节号：取现有最大 order + 1，不能用 length + 1（删过首章就会撞号）。 */
async function nextChapterOrder(novelId) {
  const chapters = await listChapters(novelId);
  return chapters.reduce((max, c) => Math.max(max, c.order || 0), 0) + 1;
}

async function createChapter(novelId, { title, content = '', order }) {
  const finalOrder = order ?? (await nextChapterOrder(novelId));
  const ch = {
    id: newId('ch'), novel_id: novelId, title, content,
    word_count: words(content), order: finalOrder,
    created_at: Date.now(), updated_at: Date.now(),
  };
  await put('chapters', ch);
  await recountNovelStats(novelId);
  return ch;
}

async function updateChapter(id, updates) {
  const ch = await get('chapters', id);
  if (!ch) throw new Error('章节不存在');
  const next = { ...ch, ...updates, updated_at: Date.now() };
  if ('content' in updates) next.word_count = words(updates.content);
  await put('chapters', next);
  await recountNovelStats(ch.novel_id);
  return next;
}

async function getChapterWithPrev(novelId, chapterId) {
  const chapters = await listChapters(novelId);
  const idx = chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) return null;
  return { chapter: chapters[idx], prevChapter: idx > 0 ? chapters[idx - 1] : null };
}

async function deleteChapter(id) {
  const ch = await get('chapters', id);
  if (!ch) return;
  await del('chapters', id);
  await resequenceChapters(ch.novel_id);
  await recountNovelStats(ch.novel_id);
}

// ═══════════ 角色 ═══════════

const CHARACTER_ROLES = ['主角', '配角', '反派', '导师', '龙套'];

async function listCharacters(novelId) {
  return stableSort(await getByIndex('characters', 'novel_id', novelId));
}

async function createCharacter(novelId, data) {
  const ch = await put('characters', {
    id: newId('char'), novel_id: novelId,
    name: data.name, role: data.role || '配角',
    personality: data.personality || '', appearance: data.appearance || '',
    background: data.background || '', notes: data.notes || '',
    created_at: Date.now(),
  });
  return ch;
}

async function updateCharacter(id, updates) {
  const ch = await get('characters', id);
  if (!ch) throw new Error('角色不存在');
  return put('characters', { ...ch, ...updates });
}

// ═══════════ 世界设定 ═══════════

const WORLD_TYPES = { location: '地点', faction: '势力/组织', rule: '规则/法则', system: '力量体系' };

async function listWorldbuilding(novelId) {
  return stableSort(await getByIndex('worldbuilding', 'novel_id', novelId));
}

async function createWorldbuilding(novelId, data) {
  return put('worldbuilding', {
    id: newId('wb'), novel_id: novelId,
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

async function listNotes(novelId) {
  return stableSort(await getByIndex('notes', 'novel_id', novelId));
}

async function saveNote(novelId, { title = '', content = '', tags = [] }) {
  return put('notes', {
    id: newId('note'), novel_id: novelId,
    title, content, tags, created_at: Date.now(), updated_at: Date.now(),
  });
}

async function updateNote(id, updates) {
  const n = await get('notes', id);
  if (!n) throw new Error('笔记不存在');
  return put('notes', { ...n, ...updates, updated_at: Date.now() });
}

async function deleteNote(id) {
  await del('notes', id);
}

// ── 全局暴露 ──
window.NovelDB = {
  CHARACTER_ROLES,
  WORLD_TYPES,
  dump: getAll,
  recountNovelStats,
  recountAll,
  resequenceChapters,
  novels:       { list: listNovels, get: (id) => get('novels', id), create: createNovel, update: updateNovel, delete: deleteNovel },
  chapters:     { list: listChapters, get: (id) => get('chapters', id), create: createChapter, update: updateChapter, delete: deleteChapter, nextOrder: nextChapterOrder, getWithPrev: getChapterWithPrev },
  characters:   { list: listCharacters, get: (id) => get('characters', id), create: createCharacter, update: updateCharacter, delete: (id) => del('characters', id) },
  worldbuilding:{ list: listWorldbuilding, get: (id) => get('worldbuilding', id), create: createWorldbuilding, update: updateWorldbuilding, delete: (id) => del('worldbuilding', id) },
  notes:        { list: listNotes, save: saveNote, get: (id) => get('notes', id), update: updateNote, delete: deleteNote },
};
