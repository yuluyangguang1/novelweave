import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NWBible, NWText, repoRoot,
  scaffoldBook, upsertProject, writeJsonAtomic, writeFileAtomic,
} from './_load-cli.mjs';

const script = (name) => path.join(repoRoot, 'scripts', name);
let tmp, root, bookDir;

function run(name, args = [], expectCode = null) {
  let res;
  try {
    const out = execFileSync(process.execPath, [script(name), ...args], { encoding: 'utf8', cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    res = { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    res = { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
  if (expectCode !== null) assert.equal(res.code, expectCode, `${name} ${args.join(' ')} 退出码应为 ${expectCode}\n${res.stdout}${res.stderr}`);
  return res;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-cli-'));
  root = path.join(tmp, '.novelweave');
  bookDir = scaffoldBook(root, { slug: 'yan-huo', id: 'novel_test', title: '烟火纪', genre: '仙侠' });
  upsertProject(root, { slug: 'yan-huo', id: 'novel_test', title: '烟火纪', path: 'yan-huo' });

  // 故意埋问题：死人出场 / 外貌区间违规 / 伏笔逾期 / payoff 早于 setup /
  // 断链 / 章号重复 / x-words 被手改
  const chapters = [
    { id: 'ch-001', number: 1, slug: 'ch1', title: '山门', body: '明长老笑道："不可下山。"' },
    { id: 'ch-002', number: 2, slug: 'ch2', title: '夜袭', body: '明长老推开门，径直走到林烟火面前。\n她抬起左臂挡下那一击。' },
    { id: 'ch-003', number: 3, slug: 'ch3', title: '下山', body: '林烟火独自下山，左臂已经好利索了。' },
  ];
  for (const c of chapters) {
    const meta = NWBible.newChapter({ id: c.id, number: c.number, slug: c.slug, title: c.title, status: 'draft', 'x-words': c.id === 'ch-003' ? 999 : NWText.countWords(c.body) });
    meta.schemaVersion = NWBible.SCHEMA_VERSION;
    writeFileAtomic(path.join(bookDir, 'manuscript', 'chapters', NWBible.chapterFileName(meta)), NWBible.serializeChapterFile(meta, c.body));
  }
  // 章号 3 与 ch-003 重复：结构问题的来源
  writeFileAtomic(path.join(bookDir, 'manuscript', 'chapters', 'ch-004-ghost.md'), '---\nid: ch-004\nnumber: 3\ntitle: 不存在的引用\nstatus: draft\ncharacters: [char-nope, char-lin]\nlocations: [wb-nope]\n---\n正文。');

  writeJsonAtomic(path.join(bookDir, 'bible', 'characters', 'char-ming.json'),
    NWBible.defaultCharacter({ schemaVersion: NWBible.SCHEMA_VERSION, id: 'char-ming', name: '明长老', role: 'supporting', status: 'deceased', 'died-in': 'ch-001' }));
  writeJsonAtomic(path.join(bookDir, 'bible', 'characters', 'char-lin.json'),
    NWBible.defaultCharacter({ schemaVersion: NWBible.SCHEMA_VERSION, id: 'char-lin', name: '林烟火', role: 'protagonist',
      appearance: { summary: '灰袍', tokens: [{ key: '左臂', since: 'ch-001', until: 'ch-002' }] } }));
  writeJsonAtomic(path.join(bookDir, 'bible', 'characters', '_index.json'), { schemaVersion: '1', ids: ['char-lin', 'char-ming'], order: [0, 1] });
  writeJsonAtomic(path.join(bookDir, 'bible', 'world', 'wb-qingwu.json'),
    NWBible.defaultWorldEntry({ schemaVersion: NWBible.SCHEMA_VERSION, id: 'wb-qingwu', name: '青雾山', type: 'location', keys: ['青雾山'], content: '终年大雾，山门三千阶。' }));
  writeJsonAtomic(path.join(bookDir, 'bible', 'promises.json'), {
    schemaVersion: '1',
    items: [
      { id: 'p-001', type: 'promise', title: '半枚铜印', status: 'planted', weight: 'major', setup: { chapter: 'ch-001', evidence: '师父塞给他的' }, payoff: { chapter: 'ch-001', due: 'ch-002' } },
      { id: 'p-002', type: 'promise', title: '倒着埋', status: 'paid-off', weight: 'minor', setup: { chapter: 'ch-003' }, payoff: { chapter: 'ch-002' } },
    ],
  });
  writeJsonAtomic(path.join(bookDir, 'bible', 'lexicon.json'), { schemaVersion: '1', names: { 明长老: 'char-ming', 林烟火: 'char-lin' }, allowlist: [] });
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('locate 从子目录向上找到项目', () => {
  const r = JSON.parse(run('nw-io.mjs', ['locate', '--dir', path.join(bookDir, 'manuscript'), '--json']).stdout);
  assert.equal(r.found, true);
  assert.equal(r.books[0].slug, 'yan-huo');
  assert.equal(r.books[0].exists, true);
});

test('init 是幂等的：重复执行不覆盖已有书，退出码 6 提示已存在', () => {
  const first = fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8');
  run('nw-io.mjs', ['init', '--title', '烟火纪', '--slug', 'yan-huo', '--dir', tmp], 6);
  assert.equal(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'), first, '幂等要求不触碰既有文件');
});

test('validate 拦下结构问题：章号重复、断链、派生字段被手改', () => {
  const r = run('nw-validate.mjs', [bookDir, '--json', '--no-write']);
  const diags = JSON.parse(r.stdout).diagnostics;
  const rules = diags.map((d) => d.rule);
  assert.ok(rules.includes('structure-invalid'), '章号 2 重复必须报');
  assert.ok(rules.includes('dangling-reference'), 'char-nope / wb-nope 必须报');
  assert.ok(rules.includes('derived-field-touched'), 'x-words=999 与重算不符必须报');
  assert.ok(diags.some((d) => d.rule === 'dangling-reference' && d.message.includes('char-nope')));
});

test('recount 修好派生字段（校验器的建议承诺了这条出口，必须真能跑）', () => {
  const r = run('nw-io.mjs', ['recount', bookDir, '--json'], 0);
  const res = JSON.parse(r.stdout);
  assert.equal(res.chaptersRewritten >= 1, true, '应至少修正 ch-003 的 x-words=999');
  assert.ok(res.words > 0 && res.characters === 2);

  const after = JSON.parse(run('nw-validate.mjs', [bookDir, '--json', '--no-write']).stdout);
  assert.deepEqual(after.diagnostics.filter((d) => d.rule === 'derived-field-touched'), [],
    '重算之后不该再有派生字段告警');
});

test('continuity 命中埋进去的每一个问题', () => {
  const r = JSON.parse(run('nw-continuity.mjs', [bookDir, '--json'], 1).stdout);
  const byRule = {};
  for (const d of r.diagnostics) (byRule[d.rule] ||= []).push(d);

  assert.ok(byRule['dead-character-on-stage']?.some((d) => d.chapter === 'ch-002' && d.severity === 'error'), '死人行动未报');
  assert.ok(byRule['appearance-token-violation']?.some((d) => d.chapter === 'ch-003' && d.severity === 'error'), '"断臂复活"未报');
  assert.ok(byRule['promise-overdue']?.some((d) => d.entity === 'p-001'), '逾期伏笔未报');
  assert.ok(byRule['payoff-before-setup']?.some((d) => d.entity === 'p-002'), '倒着埋的伏笔未报');
  assert.ok(byRule['structure-invalid']?.length, '结构问题未报');
  assert.equal(r.summary.error > 0, true);
  // 每条诊断都要能被作者定位
  for (const d of r.diagnostics.filter((x) => x.rule === 'dead-character-on-stage')) {
    assert.ok(d.evidence.quote, '缺少原文引用');
    assert.ok(d.suggestion, '缺少可执行建议');
    assert.match(d.fingerprint, /dead-character-on-stage:ch-00[234]:char-ming/);
  }
});

test('continuity 退出码非零当且仅当存在 machine error（--fail-on never 永远 0）', () => {
  run('nw-continuity.mjs', [bookDir, '--fail-on', 'never'], 0);
  assert.ok(run('nw-continuity.mjs', [bookDir, '--json']).stdout);
  const clean = run('nw-continuity.mjs', [bookDir, '--rules', 'unregistered-entity', '--json'], 0);
  assert.equal(JSON.parse(clean.stdout).summary.error, 0);
});

test('--from / --to 只扫指定范围', () => {
  const onlyCh1 = JSON.parse(run('nw-continuity.mjs', [bookDir, '--from', 'ch-001', '--to', 'ch-001', '--json'], 1).stdout);
  assert.ok(onlyCh1.diagnostics.length, '范围内应有诊断');
  assert.deepEqual(onlyCh1.diagnostics.filter((d) => ['ch-002', 'ch-003', 'ch-004'].includes(d.chapter)), [], '范围外章节不该出现');
});

test('explain 给出规则规格，供 agent 引用而不是自己编规则', () => {
  const r = JSON.parse(run('nw-continuity.mjs', ['explain', '--rule', 'R1', '--json']).stdout);
  assert.equal(r.name, 'dead-character-on-stage');
  assert.ok(r.summary.length > 5);
  assert.ok(r.detail.includes('误报') || r.detail.includes('flashback'), '必须说明误报控制');
});

test('--write 落报告并把检查结果如实回写 book._derived', () => {
  run('nw-continuity.mjs', [bookDir, '--write', '--json'], 1);
  const reports = fs.readdirSync(path.join(bookDir, 'continuity', 'reports'));
  assert.equal(reports.length >= 1, true, '报告未落盘');
  const book = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
  assert.ok(book._derived.lastChecked, '跑过了就该留下 lastChecked');
  assert.ok(book._derived.errors >= 1, 'error 计数应回写，实际 ' + book._derived.errors);
});

test('新书未跑过校验时，_derived 里不该有 errors:0（会被误读成检查过没问题）', () => {
  const fresh = path.join(tmp, 'fresh');
  run('nw-io.mjs', ['init', '--title', '空白书', '--slug', 'fresh', '--dir', fresh], 0);
  const book = JSON.parse(fs.readFileSync(path.join(fresh, '.novelweave', 'fresh', 'book.json'), 'utf8'));
  assert.equal('errors' in book._derived, false, JSON.stringify(book._derived));
  assert.equal(book._derived.lastChecked, null);
});

test('context 产出 ≤ 预算的上下文文档，并如实报告裁掉了什么', () => {
  const r = JSON.parse(run('nw-context.mjs', [bookDir, '--chapter', 'ch-003', '--budget', '400', '--json']).stdout);
  assert.ok(r.bytes <= 400, `超出预算：${r.bytes}`);
  assert.ok(r.document.includes('明长老'), '角色卡应在文档里');
  assert.ok(r.document.includes('已死亡'), '死亡警示应随角色一起注入，否则模型不知道不能让他行动');
  assert.ok(r.truncated && r.droppedSections.length, '小预算下应当报告被裁掉的节');
  const roomy = JSON.parse(run('nw-context.mjs', [bookDir, '--chapter', 'next', '--json']).stdout);
  assert.equal(roomy.truncated, false, '正常预算下不该有裁切');
});

test('changes：未过门禁的声明绝不落地，过了门禁的要作者 apply 才写库', () => {
  const draft = path.join(bookDir, 'manuscript', 'chapters', 'ch-005-next.md');
  const meta = { ...NWBible.newChapter({ id: 'ch-005', number: 5, slug: 'next', title: '第五章', status: 'draft' }), schemaVersion: '1' };
  const body = NWBible.serializeChapterFile(meta, '新的正文。\n\n---CHANGES---\n' + JSON.stringify({
    chapter: 'ch-005',
    changes: [
      { op: 'character.status', id: 'char-lin', to: 'missing', evidence: '她跌入涧中再未出现' },
      { op: 'character.status', id: 'char-ghost', to: 'deceased', evidence: '凭空造了个没建档的人' },
      { op: 'promise.plant', title: '涧底的钟声', setup: 'ch-005', weight: 'major', evidence: '钟声只响了一次' },
    ],
  }) + '\n');
  writeFileAtomic(draft, body);

  const staged = run('nw-changes.mjs', ['stage', '--file', draft, '--book', bookDir, '--json']);
  const summary = JSON.parse(staged.stdout);
  assert.equal(summary.accepted.length, 2, '两条合法变更应通过');
  assert.equal(summary.rejected.length, 1);
  assert.match(summary.rejected[0].reason, /未登记/, '引用未建档角色必须被拒');
  assert.equal(staged.code, 1, '存在被拒项时以 1 报错（全部通过且仅有待确认项才是 6）');

  // stage 之后状态文件不该有任何变化
  const linBefore = fs.readFileSync(path.join(bookDir, 'bible', 'characters', 'char-lin.json'), 'utf8');
  run('nw-changes.mjs', ['list', '--book', bookDir, '--json'], 6);
  assert.equal(fs.readFileSync(path.join(bookDir, 'bible', 'characters', 'char-lin.json'), 'utf8'), linBefore,
    '未经作者确认就改状态，等于让 AI 替作者做决定');

  run('nw-changes.mjs', ['apply', '--all', '--book', bookDir], 0);
  const lin = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible', 'characters', 'char-lin.json'), 'utf8'));
  assert.equal(lin.status, 'missing');
  const promises = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible', 'promises.json'), 'utf8'));
  assert.ok(promises.items.some((i) => i.title === '涧底的钟声' && i.status === 'planted'));
  assert.ok(fs.existsSync(path.join(bookDir, 'meta', 'changelog.jsonl')), '落地必须留痕');
});

test('被拒的变更不会污染登记表', () => {
  const promises = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible', 'promises.json'), 'utf8'));
  assert.equal(promises.items.some((i) => (i.characters || []).includes('char-ghost')), false);
  const pending = JSON.parse(fs.readFileSync(path.join(bookDir, 'continuity', 'pending.json'), 'utf8'));
  assert.ok(pending.items.some((i) => i.status === 'rejected' && i.rejectedBy));
});

test('import 把织文备份转成合法 Story Bible', () => {
  const dump = {
    app: 'novelweave', schemaVersion: 1, exportedAt: new Date().toISOString(),
    data: {
      novels: [{ id: 'novel_bk', title: '旧备份', genre: '都市', description: '一句话', word_count: 99999, chapter_count: 9, created_at: 1700000000000, updated_at: 1700000001000 }],
      chapters: [
        { id: 'ch_1', novel_id: 'novel_bk', title: '第一章', content: '她说："走吧。"', order: 2, word_count: 6, created_at: 1, updated_at: 2 },
        { id: 'ch_2', novel_id: 'novel_bk', title: '第二章', content: '然后就没有了。', order: 1, word_count: 7, created_at: 3, updated_at: 4 },
      ],
      characters: [{ id: 'char_a', novel_id: 'novel_bk', name: '张三', role: '主角', personality: '寡言', appearance: '', background: '', notes: '' }],
      worldbuilding: [{ id: 'wb_a', novel_id: 'novel_bk', type: 'rule', name: '灵潮', description: '每十年一次。' }],
      notes: [{ id: 'note_a', novel_id: 'novel_bk', title: '伏笔：钥匙', content: '第二把钥匙', tags: ['伏笔'] }],
    },
  };
  const file = path.join(tmp, 'backup.json');
  fs.writeFileSync(file, JSON.stringify(dump));
  const outDir = path.join(tmp, 'imported');
  run('nw-io.mjs', ['import', '--web', '--file', file, '--dir', outDir], 0);

  const dir = path.join(outDir, '.novelweave', '旧备份');
  const ctx = JSON.parse(run('nw-validate.mjs', [dir, '--json', '--no-write'], 0).stdout);
  assert.equal(ctx.diagnostics.filter((d) => d.severity === 'error').length, 0, JSON.stringify(ctx.diagnostics));

  const book = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
  assert.ok(book._derived.words > 0 && book._derived.words !== 99999,
    `旧 word_count=99999 不可信，迁移应重算成真实值，实际 ${book._derived.words}`);
  const files = fs.readdirSync(path.join(dir, 'manuscript', 'chapters')).sort();
  assert.equal(files.length, 2);
  const parsed = files.map((f) => NWBible.parseFrontmatter(fs.readFileSync(path.join(dir, 'manuscript', 'chapters', f), 'utf8')));
  const byTitle = Object.fromEntries(parsed.map((p) => [p.data.title, p]));
  // 旧库里 第二章.order=1 / 第一章.order=2，导入必须按 order 把章号理顺
  assert.equal(byTitle['第二章'].data.number, 1, 'order 更小的章节应排在前面');
  assert.equal(byTitle['第一章'].data.number, 2);
  assert.equal(byTitle['第一章'].body, '她说："走吧。"', '正文必须原样搬运，不转义');
  const ch = JSON.parse(fs.readFileSync(path.join(dir, 'bible', 'characters', 'char_a.json'), 'utf8'));
  assert.equal(ch.role, 'protagonist', '中文定位应映射到英文枚举');
  assert.equal(ch.status, 'alive');
  const wb = JSON.parse(fs.readFileSync(path.join(dir, 'bible', 'world', 'wb_a.json'), 'utf8'));
  assert.equal(wb.constant, true, 'rule 类条目默认常驻');
  assert.deepEqual(wb.keys, ['灵潮']);
  const pr = JSON.parse(fs.readFileSync(path.join(dir, 'bible', 'promises.json'), 'utf8'));
  assert.equal(pr.items[0].weight, 'candidate', '从笔记迁来的伏笔必须标记为待作者确认');
});
