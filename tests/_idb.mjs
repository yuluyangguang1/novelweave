/**
 * 内存版 IndexedDB —— 只实现 src/core/db.js 真正用到的那一小块 API。
 *
 * 为什么要有它：db.js 是这个项目的地基，但测试进程里从来没有执行过它的一行函数体
 * （_load.mjs 只是 require 一次让 window.NovelDB 挂出来给守卫看）。
 * 「表建了没」「级联删没删干净」「主键会不会撞」这类问题全靠人肉判断，
 * 而本项目最大的病恰恰是声称做了和实际做了之间的差距。
 *
 * 实现是同步的：db.js 只依赖 request.result 与 transaction.oncomplete，
 * 不依赖事件时序，所以这里用微任务补一次 oncomplete 就足够以真库的方式被 await。
 */

const databases = new Map();   // name → { version, stores }

class FakeRequest {
  constructor(result) {
    this.result = result;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

function clone(v) { return v === undefined ? v : structuredClone(v); }

class FakeIndex {
  constructor(store, name, keyPath) { this.store = store; this.name = name; this.keyPath = keyPath; }
  getAll(query) {
    const rows = [...this.store.data.values()].filter((r) => compare(r[this.keyPath], query));
    return new FakeRequest(rows.map(clone));
  }
}

/** 只支持 db.js 用得到的两种：undefined（全部）与精确键值。 */
function compare(value, query) {
  if (query === undefined) return true;
  return value === query;
}

class FakeStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this.data = new Map();
    this.indexes = new Map();
  }
  createIndex(name, keyPath) { this.indexes.set(name, new FakeIndex(this, name, keyPath)); }
  index(name) {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error(`索引不存在：${this.name}.${name}`);
    return idx;
  }
  put(value, key) {
    const k = key !== undefined ? key : value[this.keyPath];
    if (k === undefined) throw new Error(`${this.name}：既没有 keyPath「${this.keyPath}」也没有显式键`);
    this.data.set(k, clone(value));
    return new FakeRequest(k);
  }
  get(key) { return new FakeRequest(clone(this.data.get(key))); }
  getAll(query) {
    const rows = [...this.data.values()].filter((r) => compare(r[this.keyPath], query));
    return new FakeRequest(rows.map(clone));
  }
  delete(key) { this.data.delete(key); return new FakeRequest(undefined); }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db;
    this.mode = mode;
    this.objectStoreNames = names;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
    this._stores = names.map((n) => {
      const s = db._stores.get(n);
      if (!s) throw new Error(`没有这张表：${n}`);
      return s;
    });
    queueMicrotask(() => { if (this.oncomplete) this.oncomplete(); });
  }
  objectStore(name) {
    const s = this._stores.find((x) => x.name === name);
    if (!s) throw new Error(`事务没开这张表：${name}`);
    return s;
  }
}

class FakeDB {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this._stores = databases.get(name)?.stores || new Map();
    databases.set(name, { version, stores: this._stores });
    this.objectStoreNames = { contains: (n) => this._stores.has(n) };
  }
  createObjectStore(name, { keyPath } = {}) {
    const s = new FakeStore(name, keyPath || 'id');
    this._stores.set(name, s);
    return s;
  }
  transaction(names, mode = 'readonly') {
    const list = Array.isArray(names) ? names : [names];
    return new FakeTransaction(this, list, mode);
  }
}

export function installFakeIndexedDB() {
  globalThis.indexedDB = {
    open(name, version) {
      const req = new FakeRequest();
      const needUpgrade = !databases.has(name) || databases.get(name).version < version;
      req.result = new FakeDB(name, version);
      // db.js 是「open() 之后才挂 onupgradeneeded/onsuccess」的写法，
      // 所以这两个回调必须留到微任务里再判，否则建表逻辑永远不会跑。
      queueMicrotask(() => {
        if (needUpgrade && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    deleteDatabase(name) { databases.delete(name); return new FakeRequest(undefined); },
  };
  return globalThis.indexedDB;
}

/** 把库清空：每个测试文件一个进程，跨用例复用同一份 db.js 单例，所以要能重置。 */
export function resetFakeIndexedDB() { databases.clear(); }
