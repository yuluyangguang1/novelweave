import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NWStory, NWProject, NWRules, NWText, NWBible, NWContext, repoRoot } from './_load.mjs';

/**
 * 阶段三的契约核心：Web 导出的 .novelweave/ 目录，CLI 必须原样读得懂。
 * 两边各写一套文件布局迟早会变成「网页导出的书 agent 打不开」，所以这条不能只靠人肉检查。
 */
const run = (script, args) => {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [path.join(repoRoot, 'scripts', script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
};

function rowsFixture() {
  const ch = (id, order, title, content) => ({ id, order, title, content, word_count: NWText.countWords(content) });
  const chapters = [
    ch('ch_a1', 1, '山门', '明长老笑道：“不可下山。”当夜他在山门口战死。'),
    ch('ch_a2', 2, '夜袭', '明长老推开门，径直走进内堂。\n他挥了挥断臂。'),
  ];
  const characters = [
    { id: 'char_ming', name: '明长老', role: '导师', status: 'deceased', 'died-in': 'ch_a1', personality: '持重', appearance: '灰袍', appearance_tokens: [{ key: '断臂', since: 'ch_a1', until: 'ch_a1' }] },
    { id: 'char_lin', name: '林烟火', role: '主角', status: 'alive' },
  ];
  const totalWords = chapters.reduce((s, c) => s + c.word_count, 0);
  return {
    novel: { id: 'novel_bridge', title: '桥接测试', genre: '仙侠', description: '验证导出契约', word_count: totalWords, chapter_count: 2, created_at: 1700000000000, updated_at: 1700000001000 },
    chapters, characters,
    world: [{ id: 'wb_qing', name: '青雾山', type: 'location', description: '终年大雾，山门三千阶。' },
            { id: 'wb_rule', name: '灵气九境', type: 'rule', description: '不可逾越。' }],
    promises: [{ id: 'p_001', type: 'promise', title: '半枚铜印', status: 'planted', weight: 'major',
      setup: { chapter: 'ch_a1', evidence: '师父塞给我' }, payoff: { chapter: null, due: 'ch_a1' } }],
    timeline: [{ id: 'ev_001', chapter: 'ch_a1', label: '山门夜火', day: 1, clock: '夜', thread: '甲线', confidence: 'author' }],
    states: [
      { id: 'ch_a1|char_ming', novel_id: 'novel_bridge', chapter: 'ch_a1', entity: 'char_ming',
        loc: '青雾山山门', alive: 'deceased', injury: [], items: ['半枚铜印'], knows: ['铜印来历'], goal: '' },
    ],
    suppressions: [{ id: 'sup_1', fingerprint: 'appearance-token-violation:ch_a2:char_ming', reason: '闪回', at: 1 }],
  };
}

test('Web 导出的目录能被 CLI 通过结构校验（0 error）', async () => {
  const ctx = NWStory.buildCtx(rowsFixture());
  const tree = await NWProject.buildProjectTree(ctx);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-bridge-'));
  try {
    for (const [rel, text] of Object.entries(tree)) {
      const f = path.join(tmp, '.novelweave', rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text, 'utf8');
    }
    const bookDir = path.join(tmp, '.novelweave', '桥接测试');
    assert.ok(fs.existsSync(path.join(bookDir, 'book.json')), 'slug 目录名应与 project.json 声明一致');

    const v = run('nw-validate.mjs', [bookDir, '--json', '--no-write']);
    const diags = JSON.parse(v.stdout).diagnostics;
    const bad = diags.filter((d) => d.severity === 'error');
    assert.deepEqual(bad, [], 'CLI 读 Web 导出应有 0 error：' + JSON.stringify(bad, null, 1));
    assert.equal(v.code, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('同一条矛盾，Web 与 CLI 报出的 fingerprint 完全一致', async () => {
  const rows = rowsFixture();
  const ctx = NWStory.buildCtx(rows);
  const webFps = NWRules.runRules(ctx).map((d) => d.fingerprint).sort();
  assert.ok(webFps.some((f) => f.startsWith('dead-character-on-stage:')), 'Web 端应命中死人出场');

  const tree = await NWProject.buildProjectTree(ctx);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-bridge2-'));
  try {
    for (const [rel, text] of Object.entries(tree)) {
      const f = path.join(tmp, '.novelweave', rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text, 'utf8');
    }
    const bookDir = path.join(tmp, '.novelweave', '桥接测试');
    const r = run('nw-continuity.mjs', [bookDir, '--json']);
    const cliFps = JSON.parse(r.stdout).diagnostics.map((d) => d.fingerprint).sort();
    // CLI 会额外检查 Web 端不跑的东西（如 mentions 里的未登记引用由 CLI 的声明式 characters 触发），
    // 因此要求「Web 命中的每一条 CLI 都必须也命中」，而不是简单相等。
    for (const fp of webFps) assert.ok(cliFps.includes(fp), `CLI 没报出 Web 报过的诊断：${fp}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('导出是幂等的：导出→解析→再导出，文件内容逐字节相同', async () => {
  const ctx = NWStory.buildCtx(rowsFixture());
  const first = await NWProject.buildProjectTree(ctx);
  const parsed = NWProject.parseFileMap(first);

  assert.equal(parsed.book.title, '桥接测试');
  assert.equal(parsed.chapters.length, 2);
  assert.equal(parsed.characters.length, 2);
  assert.equal(parsed.world.length, 2);
  assert.equal(parsed.promises.length, 1);
  assert.equal(parsed.suppressions[0].fingerprint, 'appearance-token-violation:ch_a2:char_ming');

  // parseFileMap 统一返回库行，所以这里直接喂 buildCtx —— 与 Web 端导入走同一条路
  const ctx2 = NWStory.buildCtx({
    novel: { ...parsed.book, created_at: Date.now(), updated_at: Date.now() },
    chapters: parsed.chapters.map((c) => ({ ...c, created_at: 1 })),
    characters: parsed.characters, world: parsed.world,
    promises: parsed.promises,
    states: parsed.states,
    timeline: parsed.timeline, suppressions: parsed.suppressions,
  });
  // 时间锚点的 day / clock 必须在往返后仍然在（这次就是在这里丢的）
  assert.equal(parsed.timeline[0].day, 1, '导入丢了中国时间锚点的 day');
  assert.equal(parsed.timeline[0].clock, '夜', '导入丢了 clock');
  assert.equal(parsed.characters[0].role, '导师', '导入应还原中文定位供界面显示');
  const second = await NWProject.buildProjectTree(ctx2);

  for (const key of Object.keys(first)) {
    if (key === 'project.json' || key.endsWith('meta/sync.json') || key.endsWith('_index.md')) continue; // 含时间戳
    if (key.endsWith('book.json')) {
      // book.json 只有 updated/_derived 会带时间，其余必须一致
      const strip = (s) => s.replace(/"(updated|created)": "[^"]*",?\n?/g, '').replace(/\s+/g, '');
      assert.equal(strip(second[key]), strip(first[key]), `${key} 内容漂移`);
      continue;
    }
    assert.equal(second[key], first[key], `${key} 第二次导出不一致`);
  }
});

test('冲突判定不许静默丢任何一侧的修改', () => {
  assert.equal(NWProject.classify('h', 'h', 'h'), 'same');
  assert.equal(NWProject.classify('h', 'h2', 'h'), 'take-file', '只有 agent 改过 → 取文件');
  assert.equal(NWProject.classify('h', 'h', 'h3'), 'take-local', '只有 Web 改过 → 取本地');
  assert.equal(NWProject.classify('h', 'h2', 'h3'), 'conflict', '两边都改过必须报冲突，不能自动选边');
});

test('同一份内容的「库行」与「文件记录」必须算出同一个哈希（三方合并的根基）', async () => {
  const ctx = NWStory.buildCtx(rowsFixture());
  const tree = await NWProject.buildProjectTree(ctx);
  const parsed = NWProject.parseFileMap(tree);
  const H = NWProject.hashRecord;

  // 每类取一条，比较「文件记录」与「库行」两种形状
  const pairs = [
    ['chapter', ctx.chapters[0], parsed.chapters.find((r) => r.id === ctx.chapters[0].id)],
    ['character', ctx.characters[0], parsed.characters.find((r) => r.id === ctx.characters[0].id)],
    ['world', ctx.world[0], parsed.world.find((r) => r.id === ctx.world[0].id)],
    ['promise', ctx.promises.items[0], parsed.promises.find((r) => r.id === ctx.promises.items[0].id)],
    ['anchor', ctx.timeline.anchors[0], parsed.timeline.find((r) => r.id === ctx.timeline.anchors[0].id)],
  ];
  for (const [kind, fileRec, dbRow] of pairs) {
    assert.ok(dbRow, `${kind} 没能从文件解析回库行`);
    assert.equal(await H(kind, fileRec), await H(kind, dbRow), `${kind}：同一内容两种形状哈希不同，会把未改动记录全判成冲突`);
  }

  // 内容变了哈希必须变（否则真正的冲突会被漏掉）
  const sameChapter = parsed.chapters.find((r) => r.id === ctx.chapters[0].id);
  assert.notEqual(await H('chapter', ctx.chapters[0]), await H('chapter', { ...sameChapter, content: sameChapter.content + '又改了一句' }));

  // 派生字段不参与
  assert.equal(await H('chapter', ctx.chapters[0]), await H('chapter', { ...sameChapter, word_count: 99999, updated_at: 1, xWords: 7 }));
});

test('sync.json 给每一类记录都留了基线哈希，否则导入时无从判断谁改过', async () => {
  const ctx = NWStory.buildCtx(rowsFixture());
  const tree = await NWProject.buildProjectTree(ctx);
  const parsed = NWProject.parseFileMap(tree);
  const base = parsed.sync.records;
  for (const [kind, id] of [['chapter', 'ch_a1'], ['chapter', 'ch_a2'], ['character', 'char_ming'],
    ['character', 'char_lin'], ['world', 'wb_qing'], ['promise', 'p_001'], ['anchor', 'ev_001']]) {
    assert.ok(base[`${kind}:${id}`]?.hash, `sync.json 缺 ${kind}:${id} 的基线哈希`);
  }
});

test('导入按正文重算字数，不照抄文件里过期的 x-words', () => {
  const tree = {
    'project.json': JSON.stringify({ schemaVersion: '1', books: [{ slug: 'x', id: 'novel_x', path: 'x' }] }),
    'x/book.json': JSON.stringify({ schemaVersion: '1', id: 'novel_x', slug: 'x', title: '测试', genre: '玄幻' }),
    'x/manuscript/chapters/ch-001-a.md': '---\nid: ch_1\nnumber: 1\nslug: a\ntitle: 甲\nstatus: draft\nx-words: 999\n---\n她推开门，看见雪。',
  };
  const parsed = NWProject.parseFileMap(tree);
  assert.equal(parsed.chapters[0].word_count, NWText.countWords('她推开门，看见雪。'),
    '导入应重算字数；照抄 999 会让章节列表永久显示错数字');
});

test('状态快照能完整走过「导出 → CLI 校验 → 摊回库行」这条链', async () => {
  const ctx = NWStory.buildCtx(rowsFixture());
  const tree = await NWProject.buildProjectTree(ctx);
  const states = JSON.parse(tree['桥接测试/bible/states.json']);
  assert.deepEqual(states.byChapter.ch_a1.char_ming,
    { loc: '青雾山山门', alive: 'deceased', items: ['半枚铜印'], knows: ['铜印来历'] },
    '空维度（injury/goal）不该被写进文件');
  const sync = JSON.parse(tree['桥接测试/meta/sync.json']);
  assert.ok(sync.records['state:ch_a1|char_ming']?.hash, 'sync.json 没给状态快照留基线哈希，导入会全表假冲突');

  const parsed = NWProject.parseFileMap(tree);
  assert.equal(parsed.states.length, 1);
  assert.equal(parsed.states[0].id, 'ch_a1|char_ming');
  assert.deepEqual(parsed.states[0].injury, []);
});

test('thread 必须在导出往返中存活（R6 靠它区分并行叙事线）', async () => {
  const ctx = NWStory.buildCtx(rowsFixture());
  const tree = await NWProject.buildProjectTree(ctx);
  const tl = JSON.parse(tree['桥接测试/bible/timeline.json']);
  assert.equal(tl.anchors[0].thread, '甲线', '导出的 timeline.json 丢了 thread');
  const parsed = NWProject.parseFileMap(tree);
  assert.equal(parsed.timeline[0].thread, '甲线', '解析回库行时丢了 thread');
  // 再导出一次仍然要在（往返幂等）
  const ctx2 = NWStory.buildCtx({ ...rowsFixture(), timeline: parsed.timeline });
  const tree2 = await NWProject.buildProjectTree(ctx2);
  assert.equal(JSON.parse(tree2['桥接测试/bible/timeline.json']).anchors[0].thread, '甲线');
});

test('导出不把脚本推导的 mentions 写成作者声明（否则谁都没碰的章节会幻影冲突）', async () => {
  const ctx = NWStory.buildCtx(rowsFixture());
  const tree = await NWProject.buildProjectTree(ctx);
  const md = tree['桥接测试/manuscript/chapters/ch-001-山门.md'];
  const { data } = NWBible.parseFrontmatter(md);
  // ch_a1 正文里出现了「明长老」，那是推导结果，不是作者声明
  assert.ok(ctx.chapters[0].mentions.includes('char_ming'), '规则用的 mentions 应含推导值');
  assert.deepEqual(data.mentions, [], '推导值不得写进 frontmatter');
  assert.deepEqual(ctx.chapters[0].declaredMentions, []);

  // 关键：浏览器里 list() 出来的原始库行没有 mentions 字段，
  // 它与 ctx 章节的哈希必须相等 —— 否则本地永远显示「被改过」
  const rawDbRow = { id: 'ch_a1', order: 1, title: '山门', content: '明长老笑道：“不可下山。”当夜他在山门口战死。' };
  assert.equal(await NWProject.hashRecord('chapter', ctx.chapters[0]),
    await NWProject.hashRecord('chapter', rawDbRow),
    '未改动的原生库行不该与导出基线不一致');
});

test('sync.json 里的哈希与 CLI 的 authorHash 用同一套算法', async () => {
  const ctx = NWStory.buildCtx(rowsFixture());
  const tree = await NWProject.buildProjectTree(ctx);
  const sync = JSON.parse(tree['桥接测试/meta/sync.json']);
  assert.match(sync.records['character:char_ming'].hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(sync.novelId, 'novel_bridge');

  // 派生字段变化不该改变作者内容哈希（否则每次导出都会被误判成冲突）
  const rec = { id: 'char_ming', name: '明长老', status: 'deceased' };
  const a = await NWProject.hashOf({ ...rec, _derived: { hits: 1 } });
  const b = await NWProject.hashOf({ ...rec, _derived: { hits: 999 }, 'x-words': 12 });
  assert.equal(a, b, '派生字段必须不参与哈希');
});

test('创作决策一路走通：Web 库行 → 导出文件（毫秒转 ISO）→ CLI 上下文带出这节', async () => {
  const rows = { ...rowsFixture(), decisions: [
    { id: 'dec_1', title: '不让主角换城', reason: '保持主线紧凑', risk: '中', supersededBy: null, created_at: 1700000000000 },
    { id: 'dec_2', title: '第二人称试验', reason: '已放弃', supersededBy: 'dec_1', created_at: 1700000000000 },
  ] };
  const ctx = NWStory.buildCtx(rows);
  const webSec = NWContext.buildSections(ctx, { chapterId: 'ch_a2' }).sections.find((s) => s.name === '创作决策');
  assert.ok(webSec, 'Web 侧没有「创作决策」节，说明 buildCtx 把 decisions 丢了');
  assert.equal(webSec.text, '- 不让主角换城：保持主线紧凑（风险：中）', '已推翻的不该进 prompt');

  const tree = await NWProject.buildProjectTree(ctx);
  const items = JSON.parse(tree[Object.keys(tree).find((k) => k.endsWith('continuity/decisions.json'))]).items;
  assert.equal(items[0].created, '2023-11-14T22:13:20.000Z', '库里是毫秒 created_at，文件里必须是 ISO');
  assert.equal(items[0].created_at, undefined, '毫秒字段不该漏进文件');
  assert.equal(NWProject.parseFileMap(tree).decisions[0].title, '不让主角换城');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-decision-'));
  try {
    for (const [rel, text] of Object.entries(tree)) {
      const f = path.join(tmp, '.novelweave', rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text, 'utf8');
    }
    const c = run('nw-context.mjs', [path.join(tmp, '.novelweave', '桥接测试'), '--chapter', 'ch_a2', '--json']);
    assert.equal(c.code, 0, c.stderr);
    const built = JSON.parse(c.stdout);
    assert.ok(built.sections.map((s) => s.name).includes('创作决策'), 'CLI 上下文要有这节：' + built.sections.map((s) => s.name).join(','));
    assert.ok(built.document.includes('不让主角换城'), 'document 里应看到决策内容');
    assert.ok(!built.document.includes('第二人称试验'), 'CLI 侧同样不该看到已推翻的');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Web 写的多行摘要，CLI 读得懂、上下文也带得动（一条链断在哪都算没做）', async () => {
  const rows = rowsFixture();
  rows.chapters[0] = { ...rows.chapters[0], summary: '核心事件：明长老夜谈下山，当战死于山门口\n出场角色：明长老、林烟火\n状态变化：山门半焚\n新埋或回收的伏笔：半枚铜印' };
  const tree = await NWProject.buildProjectTree(NWStory.buildCtx(rows));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-recap-'));
  try {
    for (const [rel, text] of Object.entries(tree)) {
      const f = path.join(tmp, '.novelweave', rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text, 'utf8');
    }
    const bookDir = path.join(tmp, '.novelweave', '桥接测试');
    const v = run('nw-validate.mjs', [bookDir, '--json', '--no-write']);
    assert.equal(v.code, 0, '含换行的摘要写进文件后必须仍然合法：' + v.stdout.slice(0, 400));

    const c = run('nw-context.mjs', [bookDir, '--chapter', 'ch_a2', '--json']);
    assert.equal(c.code, 0, c.stderr);
    const built = JSON.parse(c.stdout);
    const recap = built.sections.map((s) => s.name);
    assert.ok(recap.includes('前情摘要'), 'CLI 上下文要有这一节：' + recap.join(','));
    assert.ok(built.document.includes('明长老夜谈下山'), 'document 里应看到摘要的核心事件内容');
    assert.ok(!built.document.includes('状态变化：山门半焚'), '四行结构里其余行不该进 recap');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * 关系边与决策的三方比较。这一整块此前是不可达的：planMerge 一遇到非空的
 * relations.json 就抛「未知投影类型 relation」，而它跑在派发器里，于是点导入什么都不发生。
 */
async function mergedFixture() {
  const edges = [{ id: 'rel_1', from: 'char_ming', to: 'char_lin', kind: '师徒', address: '师父', created_at: 1700000000000 }];
  const decisions = [{ id: 'dec_1', title: '不让主角换城', reason: '保持主线紧凑', risk: '', supersededBy: null, created_at: 1700000000000 }];
  const secrets = [{ id: 'sec_1', term: '玄冰令', truth: '掌门害死林父的信物', first_chapter: null,
    reveal_chapter: 'ch_a2', revealed_at: null, informed: ['char_lin'], promise_id: null, notes: '',
    enabled: true, created_at: 1700000000000 }];
  const ctx = NWStory.buildCtx({ ...rowsFixture(), relations: { edges }, decisions, secrets });
  const tree = await NWProject.buildProjectTree(ctx);
  // local 就是 Web 导入时交给比较器的那份「库里的现在值」，键名与 app.js 一致
  const local = {
    ...rowsFixture(), worldbuilding: rowsFixture().world, relations: edges.map((e) => ({ ...e })),
    decisions, secrets: secrets.map((s) => ({ ...s })),
  };
  return { parsed: NWProject.parseFileMap(tree), local, tree };
}

test('导出的关系边与决策能被比较器吃下：未改动的一条也不判 new', async () => {
  const { parsed, local } = await mergedFixture();
  // parseFileMap 的契约是「交出去的就是库行」：时间戳必须是毫秒，不能留 ISO
  assert.equal(typeof parsed.decisions[0].created_at, 'number', '决策落回库行时丢了 created_at');
  assert.equal(parsed.decisions[0].created, undefined, 'ISO 字段不该混进库行');
  assert.equal(parsed.relations[0].id, 'rel_1');
  assert.equal(typeof parsed.secrets[0].created_at, 'number', '信息差落回库行时丢了 created_at');
  assert.deepEqual(parsed.secrets[0].informed, ['char_lin']);

  const acts = (await NWProject.planMerge(parsed, local))
    .filter((p) => ['relation', 'decision', 'secret'].includes(p.kind))
    .map((p) => `${p.kind}:${p.action}`);
  assert.deepEqual(acts.sort(), ['decision:same', 'relation:same', 'secret:same'],
    '判成 new 就意味着导入会用文件版静默盖掉本地记录');
});

test('关系边只有一边动过取那一边，两边都动过算冲突', async () => {
  const { parsed, local } = await mergedFixture();
  const of = (plan, kind) => plan.find((p) => p.kind === kind).action;

  // 只有文件被改（agent 在目录里编辑过）→ 取文件版
  const fileOnly = structuredClone(parsed);
  fileOnly.relations[0].kind = '父子';
  assert.equal(of(await NWProject.planMerge(fileOnly, local), 'relation'), 'take-file');

  // 只有本地被改 → 取本地版，不许被覆盖
  const localChanged = { ...local, relations: [{ ...local.relations[0], kind: '叔侄' }] };
  assert.equal(of(await NWProject.planMerge(parsed, localChanged), 'relation'), 'take-local');

  // 两边都改 → 谁都不许被静默盖掉
  const both = structuredClone(parsed);
  both.relations[0].kind = '父子';
  assert.equal(of(await NWProject.planMerge(both, localChanged), 'relation'), 'conflict');
});

test('信息差的三方比较：本地回填 revealed_at 不被文件版盖掉', async () => {
  const { parsed, local } = await mergedFixture();
  const of = (plan) => plan.find((p) => p.kind === 'secret').action;

  const fileChanged = structuredClone(parsed);
  fileChanged.secrets[0].notes = 'agent 在目录里补的注';
  assert.equal(of(await NWProject.planMerge(fileChanged, local)), 'take-file');

  // 作者在网页上把揭示章回填了 —— 这是导入时最常见的本地改动
  const localChanged = { ...local, secrets: [{ ...local.secrets[0], revealed_at: 'ch_a2' }] };
  assert.equal(of(await NWProject.planMerge(parsed, localChanged)), 'take-local');

  const localAlso = { ...local, secrets: [{ ...local.secrets[0], revealed_at: 'ch_a2', notes: '本地也改了注' }] };
  assert.equal(of(await NWProject.planMerge(fileChanged, localAlso)), 'conflict');
});

test('Web 导出的信息差，CLI 侧的 R20 读得到（agent 那条路不是断的）', async () => {
  const base = rowsFixture();
  const ctx = NWStory.buildCtx({
    ...base,
    chapters: base.chapters.map((c, i) => ({ ...c, content: i === 0 ? c.content + '他袖口露出半枚玄冰令。' : c.content })),
    secrets: [{ id: 'sec_1', term: '玄冰令', truth: '掌门害死林父的信物', first_chapter: null,
      reveal_chapter: 'ch_a2', revealed_at: null, informed: [], enabled: true, created_at: 1700000000000 }],
  });
  const tree = await NWProject.buildProjectTree(ctx);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-secret-'));
  try {
    for (const [rel, text] of Object.entries(tree)) {
      const f = path.join(tmp, '.novelweave', rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text, 'utf8');
    }
    const bookDir = path.join(tmp, '.novelweave', '桥接测试');
    const r = run('nw-continuity.mjs', [bookDir, '--rules', 'premature-reveal', '--json']);
    const diags = JSON.parse(r.stdout).diagnostics;
    assert.equal(diags.length, 1, `CLI 应当抓到这一条剧透，实际：${r.stdout || r.stderr}`);
    assert.equal(diags[0].chapter, 'ch_a1');
    assert.equal(diags[0].entity, 'sec_1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
