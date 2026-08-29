/**
 * NovelWeave · 织文 — Story Bible v1（UMD：浏览器与 Node 共用）
 *
 * 这是 Web 端与 agent 脚本共用的**唯一**格式实现：解析/序列化章节 frontmatter、
 * 作者字段与派生字段的切分、以及 schema 校验。两边产出必须逐字节一致，
 * 否则 sync.json 里的哈希无法互通，导入导出就会互相踩。
 *
 * frontmatter 只用 YAML 的一个极小子集（标量、flow 序列、块序列），
 * 不支持嵌套映射 —— 章节头不需要它，加了只会让双端解析器各写一套。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWBible = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = '1';

  const CHAPTER_STATUS = ['outline', 'draft', 'revised', 'final', 'complete'];
  const CHARACTER_ROLES = ['protagonist', 'antagonist', 'deuteragonist', 'supporting', 'minor', 'narrator'];
  const CHARACTER_STATUS = ['alive', 'deceased', 'unknown', 'missing'];
  const PROMISE_STATUS = ['planned', 'planted', 'paid-off', 'dropped'];
  const QUESTION_STATUS = ['open', 'answered', 'resolved', 'dropped'];
  const CHAPTER_FLAGS = ['flashback', 'dream', 'quoted', 'offscreen', 'montage'];
  /** v1 只做这 6 个状态维度。字段可加，但每章每实体的体积有硬上限。 */
  const STATE_DIMS = ['loc', 'alive', 'injury', 'items', 'knows', 'goal'];

  /** 现库里的中文定位 → story-skills 的英文枚举。未知值不猜，交给上层记 pending。 */
  const ROLE_MAP = { 主角: 'protagonist', 反派: 'antagonist', 配角: 'supporting', 导师: 'deuteragonist', 龙套: 'minor' };

  const MAX_STATE_BYTES_PER_CHAPTER = 3072;
  const MAX_CONTEXT_BYTES = 12288;

  // ═══════════ frontmatter ═══════════

  function coerce(raw) {
    const s = raw.trim();
    if (s === '') return '';
    // 双引号一律按 JSON 解码：序列化侧用 JSON.stringify，换行等转义才能原样读回
    if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
    if (/^'.*'$/s.test(s)) return s.slice(1, -1);
    if (s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  }

  function parseFlowSeq(inner) {
    const out = [];
    let depth = 0, cur = '';
    let quote = null;
    for (const ch of inner) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { cur += ch; quote = ch; continue; }
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim() !== '') out.push(cur);
    return out.map((v) => coerce(v)).filter((v) => v !== '' && v != null);
  }

  /** 返回 { data, body }。解析失败抛错，绝不静默丢字段。 */
  function parseFrontmatter(text) {
    const src = String(text ?? '').replace(/^/, '');
    const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
    if (!m) return { data: {}, body: src };

    const data = {};
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      if (/^\s/.test(line)) throw new Error(`frontmatter 第 ${i + 1} 行有缩进，本格式不支持嵌套结构：${line}`);
      const kv = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
      if (!kv) throw new Error(`frontmatter 第 ${i + 1} 行无法解析：${line}`);
      const key = kv[1];
      let val = kv[2];
      if (val.startsWith('[')) {
        let buf = val;
        while (!buf.includes(']')) {
          i++;
          if (i >= lines.length) throw new Error(`frontmatter ${key} 的序列没有闭合`);
          buf += '\n' + lines[i];
        }
        data[key] = parseFlowSeq(buf.slice(1, buf.lastIndexOf(']')));
        continue;
      }
      if (val === '') {
        const block = [];
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
          i++;
          block.push(coerce(lines[i].replace(/^\s*-\s+/, '')));
        }
        data[key] = block;
        continue;
      }
      data[key] = coerce(val);
    }
    return { data, body: m[2] };
  }

  function emitScalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    // 含换行的值必须转义成单行，否则下一行会被 frontmatter 解析器当成非法键，
    // 整本书的导出文件直接不可读（AI 摘要天然是多行结构，最容易踩到这里）。
    if (/[\r\n]/.test(s)) return JSON.stringify(s);
    // 需要引号的场景：前后空白、特殊起始字符、像数字/布尔、含冒号+空格
    if (/^[\s]|[\s]$/.test(s) || /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) || /: /.test(s)
      || /^(true|false|null|~)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s) || s === '') {
      return JSON.stringify(s);
    }
    return s;
  }

  function serializeFrontmatter(data, body = '') {
    const lines = ['---'];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        if (!v.length) { lines.push(`${k}: []`); continue; }
        lines.push(`${k}: [${v.map(emitScalar).join(', ')}]`);
        continue;
      }
      lines.push(`${k}: ${emitScalar(v)}`);
    }
    lines.push('---', '');
    return lines.join('\n') + String(body ?? '').replace(/^\n/, '');
  }

  // ═══════════ 章节 ═══════════

  function chapterFileName(chapter) {
    const n = String(chapter.number ?? 0).padStart(3, '0');
    return `ch-${n}-${chapter.slug || 'x'}.md`;
  }

  /**
   * 章节的统一标签。number 0 是前置章（楔子/序），写成「第0章」会被模型读成
   * 编号出错，也会让作者以为是哪一步排错了序 —— 直接用它自己的名字。
   */
  function chapterLabel(chapter) {
    if (!chapter) return '';
    const title = chapter.title || '无题';
    return Number(chapter.number) === 0 ? title : `第${chapter.number}章《${title}》`;
  }

  function newChapter(opts) {
    return Object.assign({
      schemaVersion: SCHEMA_VERSION,
      id: null, number: 1, slug: 'untitled', title: '未命名',
      status: 'outline', pov: null, time_anchor: null,
      locations: [], characters: [], mentions: [], flags: [], summary: '',
    }, opts);
  }

  /** 作者字段：参与哈希与合并。x-* 前缀一律是派生值。 */
  function isDerivedKey(k) {
    return k === 'schemaVersion' || k === '_derived' || k === 'x-updated' || k.startsWith('x-');
  }

  function authorFields(obj) {
    if (Array.isArray(obj)) return obj.map(authorFields);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) if (!isDerivedKey(k)) out[k] = authorFields(v);
      return out;
    }
    return obj;
  }

  function parseChapterFile(text) {
    const { data, body } = parseFrontmatter(text);
    return { meta: data, body };
  }

  function serializeChapterFile(meta, body) {
    return serializeFrontmatter(meta, body);
  }

  // ═══════════ 默认记录（旧库迁移与新文件模板共用） ═══════════

  function defaultCharacter(partial = {}) {
    const role = ROLE_MAP[partial.role] || partial.role || 'supporting';
    return Object.assign({
      schemaVersion: SCHEMA_VERSION,
      id: null, slug: null, name: '',
      role, status: 'alive', 'died-in': null, first: null,
      aliases: [],
      appearance: { summary: '', tokens: [] },
      personality: '', background: '', goals: '', notes: '',
      voice: {}, gender: null, age: null, enabled: true,
    }, partial, { role });
  }

  function defaultWorldEntry(partial = {}, index = 0) {
    return Object.assign({
      schemaVersion: SCHEMA_VERSION,
      id: null, slug: null, comment: '', name: '', type: 'custom',
      keys: [], secondary_keys: [],
      selective: false, constant: false,
      position: 'before_character_definition',
      insertion_order: 100 + index * 10,
      priority: 0, enabled: true, case_sensitive: false,
      content: '', details: {},
      lifecycle: { 'destroyed-in': null, 'revealed-in': null },
    }, partial);
  }

  function defaultBook(partial = {}) {
    return Object.assign({
      schemaVersion: SCHEMA_VERSION,
      id: null, slug: null, title: '', genre: '玄幻', language: 'zh-CN',
      description: '', audience: '',
      target: { chapters: 0, wordsPerChapter: 3000 },
      voice: { person: '', tense: '', povDefault: null, notes: '' },
    }, partial);
  }

  function emptyPromises() { return { schemaVersion: SCHEMA_VERSION, items: [] }; }
  function emptyStates() { return { schemaVersion: SCHEMA_VERSION, budgetPerChapter: MAX_STATE_BYTES_PER_CHAPTER, byChapter: {} }; }
  function emptyTimeline() { return { schemaVersion: SCHEMA_VERSION, unit: 'day', anchors: [], backstory: [] }; }
  function emptyLexicon() { return { schemaVersion: SCHEMA_VERSION, names: {}, terms: {}, forbidden: {}, allowlist: [] }; }

  // ═══════════ 校验（JSON Schema 的一个手写子集） ═══════════

  const SUPPORTED_KEYWORDS = new Set([
    '$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'properties',
    'required', 'additionalProperties', 'enum', 'const', 'pattern', 'minLength',
    'maxLength', 'minimum', 'maximum', 'items', 'minItems', 'uniqueItems', 'nullable', 'x-standard-origin',
  ]);

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (Number.isInteger(v)) return 'integer';
    return typeof v;
  }

  function typeOk(v, t) {
    const actual = typeOf(v);
    if (t === 'number') return actual === 'number' || actual === 'integer';
    if (t === 'integer') return actual === 'integer';
    return actual === t;
  }

  function lookupRef(rootSchema, ref) {
    if (!ref.startsWith('#/')) throw new Error(`只支持本地 $ref，收到 ${ref}`);
    let node = rootSchema;
    for (const seg of ref.slice(2).split('/')) {
      node = node[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (node === undefined) return undefined;
    }
    return node;
  }

  /**
   * @returns 违规数组 [{path, keyword, message}]。
   * 遇到未实现的关键字会作为违规报出来 —— 静默放过等于让 schema 撒谎。
   */
  function validate(schema, value, root, path = '$') {
    root = root || schema;
    const errs = [];
    if (!schema || typeof schema !== 'object') return errs;

    for (const k of Object.keys(schema)) {
      if (!SUPPORTED_KEYWORDS.has(k) && !k.startsWith('x-')) {
        errs.push({ path, keyword: k, message: `校验器未实现该关键字：${k}` });
      }
    }

    if (schema.$ref) {
      const target = lookupRef(root, schema.$ref);
      if (!target) { errs.push({ path, keyword: '$ref', message: `引用不到 ${schema.$ref}` }); return errs; }
      return validate(target, value, root, path);
    }
    if (schema.nullable && value === null) return errs;

    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => typeOk(value, t))) {
        errs.push({ path, keyword: 'type', message: `期望 ${types.join('|')}，实际 ${typeOf(value)}` });
        return errs;
      }
    }
    if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      errs.push({ path, keyword: 'enum', message: `${JSON.stringify(value)} 不在允许值 [${schema.enum.join(', ')}] 内` });
    }
    if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
      errs.push({ path, keyword: 'const', message: `必须等于 ${JSON.stringify(schema.const)}` });
    }
    if (typeof value === 'string') {
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errs.push({ path, keyword: 'pattern', message: `不匹配 ${schema.pattern}` });
      }
      if (schema.minLength != null && value.length < schema.minLength) {
        errs.push({ path, keyword: 'minLength', message: `长度 < ${schema.minLength}` });
      }
      if (schema.maxLength != null && value.length > schema.maxLength) {
        errs.push({ path, keyword: 'maxLength', message: `长度 > ${schema.maxLength}` });
      }
    }
    if (typeof value === 'number') {
      if (schema.minimum != null && value < schema.minimum) errs.push({ path, keyword: 'minimum', message: `< ${schema.minimum}` });
      if (schema.maximum != null && value > schema.maximum) errs.push({ path, keyword: 'maximum', message: `> ${schema.maximum}` });
    }
    if (Array.isArray(value)) {
      if (schema.minItems != null && value.length < schema.minItems) errs.push({ path, keyword: 'minItems', message: `条目数 < ${schema.minItems}` });
      if (schema.uniqueItems) {
        const seen = new Set();
        for (const item of value) {
          const key = JSON.stringify(item);
          if (seen.has(key)) { errs.push({ path, keyword: 'uniqueItems', message: `存在重复项 ${key}` }); break; }
          seen.add(key);
        }
      }
      if (schema.items) value.forEach((item, i) => errs.push(...validate(schema.items, item, root, `${path}[${i}]`)));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const req of schema.required || []) {
        if (!(req in value)) errs.push({ path: `${path}.${req}`, keyword: 'required', message: '缺少必填字段' });
      }
      if (schema.properties) {
        for (const [k, v] of Object.entries(value)) {
          if (schema.properties[k]) errs.push(...validate(schema.properties[k], v, root, `${path}.${k}`));
          else if (schema.additionalProperties === false) {
            errs.push({ path: `${path}.${k}`, keyword: 'additionalProperties', message: '未在 schema 中声明的字段' });
          } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
            errs.push(...validate(schema.additionalProperties, v, root, `${path}.${k}`));
          }
        }
      } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
        // 纯映射表（如 lexicon.names / byChapter）：所有键都按值 schema 校验
        for (const [k, v] of Object.entries(value)) {
          errs.push(...validate(schema.additionalProperties, v, root, `${path}.${k}`));
        }
      }
    }
    return errs;
  }

  return {
    SCHEMA_VERSION,
    CHAPTER_STATUS, CHARACTER_ROLES, CHARACTER_STATUS, PROMISE_STATUS, QUESTION_STATUS,
    CHAPTER_FLAGS, STATE_DIMS, ROLE_MAP,
    MAX_STATE_BYTES_PER_CHAPTER, MAX_CONTEXT_BYTES,
    parseFrontmatter, serializeFrontmatter, emitScalar, coerce,
    chapterFileName, chapterLabel, newChapter, isDerivedKey, authorFields,
    parseChapterFile, serializeChapterFile,
    defaultCharacter, defaultWorldEntry, defaultBook,
    emptyPromises, emptyStates, emptyTimeline, emptyLexicon,
    validate, SUPPORTED_KEYWORDS,
  };
});
