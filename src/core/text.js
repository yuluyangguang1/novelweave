/**
 * NovelWeave · 织文 — 文本工具（UMD：浏览器与 Node 共用同一份实现）
 *
 * 这里放的是「一次写定、两端不能各说各话」的东西：转义、中文计数、
 * canonical JSON（同步三方合并的哈希基础）。所以浏览器面板和 agent 脚本
 * 必须 require 同一份文件，不允许出现第二套实现。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWText = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ESC_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
  };

  /** 文本与带引号属性双用。旧版 escapeHtml 不转义引号，是属性注入的根因。 */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }

  /** 用于 value="…" 等属性上下文，语义化别名。 */
  const attr = esc;

  /** 仅当确实必须把数据传进内联脚本时使用；正常路径应改用 data-id + 事件委托。 */
  function escJs(s) {
    return JSON.stringify(String(s ?? '')).replace(/[&<>'\u2028\u2029]/g, (c) => {
      return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
    });
  }

  // CJK 逐字；拉丁词与数字串整体计一份，'3.5' / don't 不被拆开。标点和空白不计。
  const WORD_RE =
    /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]|[A-Za-z0-9À-˿ΐ-ώЀ-ӿ][A-Za-zÀ-˿ΐ-ώЀ-ӿ0-9]*(?:['’.-][A-Za-z0-9À-˿ΐ-ώЀ-ӿ]+)*/g;

  /**
   * 中文网文口径的「字数」：汉字算字，英文与数字算词，标点空白不算。
   * countWords('你好，世界。\n\nHello world 42') === 7
   */
  function countWords(text) {
    if (text == null) return 0;
    const hits = String(text).match(WORD_RE);
    return hits ? hits.length : 0;
  }

  /** UTF-8 字节数，用于上下文预算（prompt 体积按字节而非字符控制）。 */
  function bytesOf(str) {
    return new TextEncoder().encode(String(str ?? '')).length;
  }

  /**
   * canonical JSON：键按码点排序、无空白、确定性输出。
   * Web 与 Node 必须产出完全相同的字节，否则 sync.json 的哈希无法互通。
   */
  function canonicalJson(value) {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'undefined') return 'null';
    if (t === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    }
    if (t === 'string') return JSON.stringify(value);
    if (t === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
      return '[' + value.map((v) => canonicalJson(v === undefined ? null : v)).join(',') + ']';
    }
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }

  /** FNV-1a，仅用于 slug 兜底与指纹，不用于安全场景。 */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /**
   * kebab-case slug。ASCII 走转写；含 CJK 时保留原字（可读性优先），
   * 只剥掉文件系统不安全字符。结果为空则用哈希兜底。
   */
  function slugify(input) {
    const s = String(input ?? '')
      .trim()
      .toLowerCase()
      .replace(/[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g, (c) => c)
      .replace(/[^a-z0-9㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return s || 'x' + fnv1a(input).slice(0, 6);
  }

  /** 毫秒时间戳 → ISO-8601 UTC。旧库全是 Date.now() 整数。 */
  function toISO(ms) {
    if (ms == null || ms === '') return null;
    const n = typeof ms === 'number' ? ms : Date.parse(ms);
    if (!Number.isFinite(n)) return null;
    return new Date(n).toISOString();
  }

  function fromISO(iso) {
    if (iso == null || iso === '') return null;
    const n = typeof iso === 'number' ? iso : Date.parse(iso);
    return Number.isFinite(n) ? n : null;
  }

  /** 去重且保持原顺序；用于 id 列表与别名表。 */
  function uniq(list) {
    return [...new Set(list)];
  }

  function escapeRegExp(str) {
    return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  return { esc, attr, escJs, countWords, bytesOf, canonicalJson, fnv1a, slugify, toISO, fromISO, uniq, escapeRegExp };
});
