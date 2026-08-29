import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWBible, readSchema, schemaDef } from './_load.mjs';

test('frontmatter 往返：含冒号、引号、看似数字的字符串都不被吃掉', () => {
  const meta = {
    id: 'ch-001', number: 1, slug: 'yan-huo', title: '第一章：烟火',
    status: 'draft', pov: null, time_anchor: null,
    locations: ['loc-qingwu-shan'], characters: ['char-a', 'char-b'],
    mentions: [], flags: ['flashback'], summary: '他说「就是今夜」',
    'x-words': 4210,
  };
  const file = NWBible.serializeChapterFile(meta, '正文第一行。\n\n正文第二段。');
  const back = NWBible.parseChapterFile(file);
  assert.equal(back.meta.title, '第一章：烟火');
  assert.equal(back.meta.summary, '他说「就是今夜」');
  assert.deepEqual(back.meta.characters, ['char-a', 'char-b']);
  assert.deepEqual(back.meta.mentions, []);
  assert.equal(back.meta.number, 1);
  assert.equal(back.meta.pov, null);
  assert.equal(back.meta['x-words'], 4210);
  assert.equal(back.body, '正文第一行。\n\n正文第二段。');
});

test('正文里出现 --- 与半角引号不会截断 frontmatter（旧版把它拼进 onclick 属性正是这类事故）', () => {
  const body = '他说："带走。"\n\n---\n\n后面还有一段。';
  const file = NWBible.serializeChapterFile({ id: 'ch-002', number: 2, title: 't', status: 'draft' }, body);
  const back = NWBible.parseChapterFile(file);
  assert.equal(back.body, body);
});

test('块序列写法（- 项）也能解析', () => {
  const { data } = NWBible.parseFrontmatter('---\ntitle: x\ncharacters:\n  - char-a\n  - char-b\n---\n正文');
  assert.deepEqual(data.characters, ['char-a', 'char-b']);
});

test('无 frontmatter 时整段当正文，不报错', () => {
  const { data, body } = NWBible.parseFrontmatter('只有正文。');
  assert.deepEqual(data, {});
  assert.equal(body, '只有正文。');
});

test('格式坏的 frontmatter 抛错而不是静默丢字段', () => {
  assert.throws(() => NWBible.parseFrontmatter('---\n  indented: 1\n---\nx'), /不支持嵌套/);
  assert.throws(() => NWBible.parseFrontmatter('---\nbroken line\n---\nx'), /无法解析/);
});

test('authorFields 剥掉全部派生字段，同步哈希只比作者写的内容', () => {
  const rec = { id: 'ch-001', title: 'x', 'x-words': 99, 'x-updated': '2026-01-01T00:00:00Z', _derived: { hits: 3 }, schemaVersion: '1' };
  assert.deepEqual(NWBible.authorFields(rec), { id: 'ch-001', title: 'x' });
  assert.equal(NWBible.isDerivedKey('_derived'), true);
  assert.equal(NWBible.isDerivedKey('title'), false);
});

test('中文定位映射到 story-skills 的英文枚举', () => {
  assert.equal(NWBible.defaultCharacter({ role: '主角' }).role, 'protagonist');
  assert.equal(NWBible.defaultCharacter({ role: '导师' }).role, 'deuteragonist');
  assert.equal(NWBible.defaultCharacter({ role: '反派' }).status, 'alive', '新角色默认存活，否则 R1 全线静默');
});

test('chapterFileName 用三位补零，字典序即章节序', () => {
  assert.equal(NWBible.chapterFileName({ number: 1, slug: 'a' }), 'ch-001-a.md');
  assert.equal(NWBible.chapterFileName({ number: 42, slug: 'yan-huo' }), 'ch-042-yan-huo.md');
});

// ── schema 校验器 ──

test('校验器报出未实现的关键字，而不是静默放过（否则 schema 会撒谎）', () => {
  const errs = NWBible.validate({ type: 'object', oneOf: [] }, {});
  assert.ok(errs.some((e) => e.keyword === 'oneOf'), 'oneOf 未实现，必须被报出来');
});

test('chapter schema 拒绝：缺必填、枚举外值、id 不合 pattern、多余字段', () => {
  const { root, def } = schemaDef('chapter');
  const check = (v) => NWBible.validate(def, v, root);

  assert.ok(check({}).some((e) => e.keyword === 'required'));
  assert.ok(check({ id: 'ch-001', number: 1, title: 't', status: 'wip' }).some((e) => e.keyword === 'enum'));
  assert.ok(check({ id: 'CH-001', number: 1, title: 't', status: 'draft' }).some((e) => e.keyword === 'pattern'));
  // 0 = 前置章（楔子/序）：让散稿建档不必平移作者已有的章号
  assert.deepEqual(check({ id: 'ch-000', number: 0, title: '楔子', status: 'draft' }), []);
  assert.ok(check({ id: 'ch-001', number: -1, title: 't', status: 'draft' }).some((e) => e.keyword === 'minimum'));
  assert.ok(check({ id: 'ch-001', number: 1, title: 't', status: 'draft', extra: 1 }).some((e) => e.keyword === 'additionalProperties'));
  assert.deepEqual(check({ id: 'ch-001', number: 1, title: '烟火', status: 'draft', characters: ['char-a'] }), []);
});

test('schema 文件里每个 $ref 都能解析到 $defs（防断链）', () => {
  const root = readSchema();
  const refs = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.$ref === 'string') refs.push(node.$ref);
      Object.values(node).forEach(walk);
    }
  })(root);
  assert.ok(refs.length > 10, 'schema 里应当有若干 $ref');
  for (const ref of refs) {
    const segs = ref.replace(/^#\//, '').split('/');
    let n = root;
    for (const s of segs) n = n?.[s];
    assert.notEqual(n, undefined, `$ref 断链：${ref}`);
  }
});

test('worldEntry 字段名保持 Character Card V2 原样，导出 lorebook 才能纯搬运', () => {
  const { root, def } = schemaDef('worldEntry');
  const entry = NWBible.defaultWorldEntry({ id: 'wb-qingwu', name: '青雾山', content: '终年大雾' }, 0);
  assert.deepEqual(NWBible.validate(def, entry, root), []);
  for (const k of ['keys', 'secondary_keys', 'selective', 'constant', 'position', 'insertion_order', 'priority', 'enabled', 'case_sensitive']) {
    assert.ok(k in entry, `缺少与 V2 对齐的字段 ${k}`);
  }
});

test('states 的映射表形式（byChapter）也按值 schema 校验', () => {
  const { root, def } = schemaDef('states');
  const good = { schemaVersion: '1', byChapter: { 'ch-004': { 'char-a': { loc: 'loc-x', knows: ['密道'] } } } };
  assert.deepEqual(NWBible.validate(def, good, root), []);
  const bad = { schemaVersion: '1', byChapter: { 'ch-004': { 'char-a': { loc: 'ok', 未知维度: 1 } } } };
  assert.ok(NWBible.validate(def, bad, root).some((e) => e.keyword === 'additionalProperties'));
});

test('v1 状态维度只留 6 个，体积上限写死在常量里', () => {
  assert.deepEqual(NWBible.STATE_DIMS, ['loc', 'alive', 'injury', 'items', 'knows', 'goal']);
  assert.equal(NWBible.MAX_STATE_BYTES_PER_CHAPTER, 3072);
  assert.equal(NWBible.MAX_CONTEXT_BYTES, 12288);
});

test('含换行的值写成转义单行：原样拼行会让 frontmatter 解析器把第二行当成非法键', () => {
  const meta = { id: 'ch-009', number: 9, title: '夜火', status: 'draft',
    summary: '核心事件：明长老战死\n出场角色：明长老、林烟火' };
  const file = NWBible.serializeChapterFile(meta, '正文。');
  const fmLines = file.split('---')[1].split(/\r?\n/);
  assert.ok(fmLines.some((l) => /^summary: "/.test(l)), 'summary 必须落在带引号的单行上');
  assert.equal(fmLines.filter((l) => /^(核心事件|出场角色)/.test(l)).length, 0, '不能有裸的第二行漏到 frontmatter 里');
  // 抛错的解析器至少是诚实的；静默丢字段才是灾难
  const back = NWBible.parseChapterFile(file);
  assert.equal(back.meta.summary, meta.summary, '换行必须原样读回');
});
