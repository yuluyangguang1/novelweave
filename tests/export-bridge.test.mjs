import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NWStory, NWProject, NWRules, NWText, NWBible, repoRoot } from './_load.mjs';

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
    timeline: [{ id: 'ev_001', chapter: 'ch_a1', label: '山门夜火', day: 1, clock: '夜', confidence: 'author' }],
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
