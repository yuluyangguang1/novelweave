import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NWBible, NWText, repoRoot, NWProject, NWStyleFit,
  scaffoldBook, upsertProject, writeJsonAtomic, writeFileAtomic, recountBook,
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

test('R6 走完整文件路径：CLI 读 timeline.json 能查出时间倒流，填了 thread 就不报', () => {
  const tlPath = path.join(bookDir, 'bible', 'timeline.json');
  const write = (anchors) => writeJsonAtomic(tlPath, { schemaVersion: '1', unit: 'day', anchors, backstory: [] });

  write([
    { id: 'ev-001', chapter: 'ch-001', label: '夜火', at: { day: 1, clock: '夜' }, confidence: 'author' },
    { id: 'ev-002', chapter: 'ch-002', label: '清晨', at: { day: 1, clock: '晨' }, confidence: 'author' },
  ]);
  const hit = JSON.parse(run('nw-continuity.mjs', [bookDir, '--rules', 'R6', '--json'], 1).stdout);
  assert.equal(hit.diagnostics.length, 1, 'CLI 应通过文件路径查出时间倒流');
  assert.equal(hit.diagnostics[0].rule, 'timeline-regression');

  write([
    { id: 'ev-001', chapter: 'ch-001', label: '夜火', at: { day: 1, clock: '夜' }, thread: '甲', confidence: 'author' },
    { id: 'ev-002', chapter: 'ch-002', label: '清晨', at: { day: 1, clock: '晨' }, thread: '乙', confidence: 'author' },
  ]);
  const parallel = JSON.parse(run('nw-continuity.mjs', [bookDir, '--rules', 'R6', '--json'], 0).stdout);
  assert.deepEqual(parallel.diagnostics, [], '并行叙事线之间不该互相比时间');

  fs.rmSync(tlPath, { force: true });
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

/**
 * defaultSeverity 是「声明」而不是「发出来的档位」：R33 每条诊断自带 severity:'info'，
 * 所以改那一格不会有任何一条诊断变色 —— 唯一读它的人是 explain 的「默认级别」行。
 * 那就得在这一条里把它读出来，否则「卷级缺口默认只是提醒」只是 rules.js 里一句注释。
 */
test('R33 的默认级别由 explain 说出口：补卷是提醒，不是拦路的', () => {
  const j = JSON.parse(run('nw-continuity.mjs', ['explain', '--rule', 'R33', '--json']).stdout);
  assert.equal(j.name, 'volume-gap');
  assert.equal(j.code, 'R33');
  assert.equal(j.defaultSeverity, 'info', '这一条不许命令作者，只许告诉他哪几章还没被卷盖住');
  assert.match(run('nw-continuity.mjs', ['explain', '--rule', 'R33']).stdout, /默认级别：info/);
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

/**
 * 「这次模型到底看见了哪一段过去」是作者判断要不要补卷的唯一依据，
 * 所以人读的那一行里必须有分层数字，而且必须与 --json 报的是同一份 ——
 * 两个数各算各的，就等于命令行与界面各说一套。
 */
let tierSeq = 0;
/** 磁盘上的分层夹具：15 章、摘要可填可不填、卷可建可不建。 */
function tierBook({ summaries = true, volume = true } = {}) {
  const box = path.join(tmp, `tier-box-${++tierSeq}`);
  const book = scaffoldBook(box, { slug: `tb${tierSeq}`, id: `novel_tier${tierSeq}`, title: '分层', genre: '仙侠' });
  for (let i = 1; i <= 15; i++) {
    const body = `第${i}章的正文。明长老说了一句不可下山。`;
    const meta = NWBible.newChapter({ id: `ch-0${String(i).padStart(2, '0')}`, number: i, slug: `t${i}`, title: `第${i}章`, status: 'draft' });
    meta.schemaVersion = NWBible.SCHEMA_VERSION;
    meta['x-words'] = NWText.countWords(body);
    if (summaries) meta.summary = `第${i}章：做了一件事。`;
    writeFileAtomic(path.join(book, 'manuscript', 'chapters', NWBible.chapterFileName(meta)), NWBible.serializeChapterFile(meta, body));
  }
  if (volume) {
    writeJsonAtomic(path.join(book, 'continuity', 'volumes.json'), {
      schemaVersion: NWBible.SCHEMA_VERSION,
      items: [{
        id: 'vol-001', order: 1, title: '卷一·出山',
        fromChapter: 'ch-001', toChapter: 'ch-002',
        summary: '林烟火出山、查明师之死', created: '2026-01-01T00:00:00.000Z',
      }],
    });
  }
  recountBook(book);
  return book;
}

test('context 的人读末尾要报分层，数字与 --json 的 recapTiers 同一份', () => {
  const book = tierBook();
  const j = JSON.parse(run('nw-context.mjs', [book, '--chapter', 'ch-015', '--json']).stdout);
  const t = j.recapTiers;
  assert.ok(t, 'recapTiers 没进 JSON');
  assert.deepEqual([t.fine, t.volumes, t.covered, t.uncovered], [12, 1, 2, 0], '分层本身错了');
  const human = run('nw-context.mjs', [book, '--chapter', 'ch-015']).stdout;
  const line = human.match(/<!-- 前情分层：([^>]*?) -->/)?.[1] || '';
  assert.ok(line, `人读输出里没有分层那一行：\n${human.slice(-300)}`);
  for (const frag of [`细摘要 ${t.fine} 行`, `章名 ${t.titles} 章`, `卷 ${t.volumes} 行`, `压掉 ${t.covered} 章`, `${t.uncovered} 章只剩计数`]) {
    assert.ok(line.includes(frag), `${frag} 没出现在「${line}」里`);
  }
});

/** 摘要一章都没填时那一段是空的，不是「0 行 0 章」—— 报出来就是凭空多出一层。 */
test('没有摘要时分层那一行整个不出现，JSON 也不许填 0', () => {
  const book = tierBook({ summaries: false, volume: false });
  const j = JSON.parse(run('nw-context.mjs', [book, '--chapter', 'ch-015', '--json']).stdout);
  assert.equal(j.recapTiers, null, '没有层可数却报了数');
  const human = run('nw-context.mjs', [book, '--chapter', 'ch-015']).stdout;
  assert.doesNotMatch(human, /前情分层/, '没有层也照样打印一行「细摘要 0 行」，作者从此不信这一行');
});

test('changes：未过门禁的声明绝不落地，过了门禁的要作者 apply 才写库', async () => {
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

  // 基线哈希必须可信：占位符会让 Web 端导入时把这些记录全判成冲突
  const sync = JSON.parse(fs.readFileSync(path.join(bookDir, 'meta', 'sync.json'), 'utf8'));
  const agentRecords = Object.entries(sync.records).filter(([, v]) => v.source === 'agent');
  assert.ok(agentRecords.length >= 2, `apply 应登记至少 2 条基线，实际 ${agentRecords.length}`);
  for (const [tag, v] of agentRecords) {
    assert.match(v.hash, /^sha256:[0-9a-f]{64}$/, `${tag} 的基线不是真实哈希：${v.hash}`);
  }
  // 用磁盘当前内容按同一投影重算，必须等于记录的基线
  const linForHash = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible', 'characters', 'char-lin.json'), 'utf8'));
  assert.equal(await NWProject.hashRecord('character', linForHash), sync.records['character:char-lin'].hash,
    '角色基线与文件实际内容不符：导入会把这条误判成两侧都改过');
  const planted = JSON.parse(fs.readFileSync(path.join(bookDir, 'bible', 'promises.json'), 'utf8'))
    .items.find((i) => i.title === '涧底的钟声');
  assert.equal(await NWProject.hashRecord('promise', planted), sync.records[`promise:${planted.id}`].hash,
    '伏笔基线与文件实际内容不符');
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

// ═══════════ adopt：散稿建档 ═══════════

test('adopt 建出的书能通过 validate 与连续性检查，且一个源文件都不改', () => {
  const base = path.join(tmp, 'adopt-case');
  const drafts = path.join(base, 'drafts');
  fs.mkdirSync(drafts, { recursive: true });
  const para = '明长老坐在山门口擦那枚铜印，铜印上的纹路他已经看了三十年。';
  const src = {
    '楔子.txt': '据说青雾山原先没有门，只有一个背着铜印的老人上了山。他在山门口坐了三十年，后来再没有人见过他，只有那枚铜印还在。\n',
    '001-山门.md': `第一章 山门\n\n${para.repeat(3)}\n`,
    '002-夜袭.md': `第二章 夜袭\n\n${para.repeat(2)}夜里火起，明长老战死在山门口。\n`,
  };
  for (const [name, text] of Object.entries(src)) fs.writeFileSync(path.join(drafts, name), text, 'utf8');
  const out = path.join(base, 'workspace');

  const dry = run('nw-io.mjs', ['adopt', drafts, '--title', ' adopt 测试', '--dir', out, '--dry-run']);
  assert.equal(fs.existsSync(path.join(out, '.novelweave')), false, '--dry-run 绝不能写盘');
  assert.match(dry.stdout, /预演/);

  const got = run('nw-io.mjs', ['adopt', drafts, '--title', 'adopt 测试', '--dir', out]);
  assert.equal(got.code, 0, `建档应无待确认项：\n${got.stdout}`);
  const dir = path.join(out, '.novelweave', 'adopt-测试');
  assert.equal(run('nw-validate.mjs', [dir]).code, 0, '建出来的书必须当场通过结构校验');
  const cont = run('nw-continuity.mjs', [dir, '--json']);
  const errs = JSON.parse(cont.stdout).diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errs, [], '建档不该制造连续性 error');

  const files = fs.readdirSync(path.join(dir, 'manuscript', 'chapters')).sort();
  assert.deepEqual(files, ['ch-000-楔子.md', 'ch-001-山门.md', 'ch-002-夜袭.md'], 'id / 文件名 / 章号三者必须一致');

  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'meta', 'adopt-report.json'), 'utf8'));
  const names = rep.nameCandidates.map((c) => c.name);
  assert.ok(names.includes('明长老'), '正文里出现六次的人名该进候选');
  for (const junk of ['路他已', '经看了', '个背着']) {
    assert.ok(!names.includes(junk), `虚词拼出来的假名字不该进候选：${junk}`);
  }
  // 草稿只读：这是 adopt 唯一不可违背的承诺
  for (const [name, text] of Object.entries(src)) {
    assert.equal(fs.readFileSync(path.join(drafts, name), 'utf8'), text, `源文件被改了：${name}`);
  }
});

test('adopt 拒绝重号与判不出章号，不猜出一个错序的书', () => {
  const base = path.join(tmp, 'adopt-bad');
  const drafts = path.join(base, 'drafts');
  fs.mkdirSync(drafts, { recursive: true });
  const para = '明长老坐在山门口擦那枚铜印，铜印上的纹路他已经看了三十年。';
  fs.writeFileSync(path.join(drafts, '第1章-甲.md'), `第一章\n\n${para.repeat(2)}`, 'utf8');
  fs.writeFileSync(path.join(drafts, '第1章-乙.md'), `第一章\n\n${para.repeat(2)}`, 'utf8');
  fs.writeFileSync(path.join(drafts, '随手记.md'), `${para.repeat(2)}`, 'utf8');

  const got = run('nw-io.mjs', ['adopt', drafts, '--title', '坏稿', '--dir', path.join(base, 'workspace')]);
  assert.equal(got.code, 2);
  assert.equal(fs.existsSync(path.join(base, 'workspace')), false, '拒绝时不能留下半个项目目录');
  assert.match(got.stdout, /判不出章号|重号/);
});

test('CLI --lore 说得出这条设定是第几层、被谁带出来的', () => {
  // 单独造一本书：往共享夹具里塞世界条目会改掉别的用例的诊断数
  const dir = path.join(tmp, 'lore-box');
  const book = scaffoldBook(dir, { slug: 'lore', id: 'novel_lore', title: '炉边', genre: '仙侠' });
  const wb = (over) => Object.assign(NWBible.defaultWorldEntry({ schemaVersion: '1' }), over);
  writeJsonAtomic(path.join(book, 'bible', 'world', 'wb-a.json'),
    wb({ id: 'wb-a', name: '青雾山', type: 'location', keys: ['青雾山'], content: '山门三千阶。' }));
  writeJsonAtomic(path.join(book, 'bible', 'world', 'wb-b.json'),
    wb({ id: 'wb-b', name: '山门', type: 'location', keys: ['山门'], content: '刻着守拙二字。' }));
  writeJsonAtomic(path.join(book, 'bible', 'world', 'wb-c.json'),
    wb({ id: 'wb-c', name: '黑水泽', type: 'location', keys: ['黑水泽'], content: '沼泽。' }));

  const j = JSON.parse(run('nw-context.mjs', [book, '--lore', '--text', '他踏上青雾山。', '--json']).stdout);
  assert.deepEqual(j.included.map((e) => [e.id, e.round]), [['wb-a', 1], ['wb-b', 2]],
    '正文只点了青雾山，山门是第二层带出来的');
  assert.deepEqual(j.included[1].via, ['青雾山']);
  assert.equal(j.included.some((e) => e.id === 'wb-c'), false);

  const human = run('nw-context.mjs', [book, '--lore', '--text', '他踏上青雾山。']).stdout;
  assert.match(human, /第 2 层，由「青雾山」的设定带出/, '人读的那份也要交代来源');
});

// ═══════════ nw-pitch.mjs · 选题评分卡 ═══════════

test('nw-pitch rubric 把判据摊开说，并声明哪些东西它不测', () => {
  const j = JSON.parse(run('nw-pitch.mjs', ['rubric', '--json'], 0).stdout);
  assert.deepEqual(j.dims.map((d) => d.id), ['hook', 'diff', 'structure', 'length']);
  assert.ok(j.words.length >= 20 && j.maxPerDim === 3);
  assert.ok(j.notMeasured.includes('平台榜单'), '不测什么必须写出来，否则作者以为它查过热榜');
  const human = run('nw-pitch.mjs', ['rubric'], 0).stdout;
  assert.match(human, /手写的 \d+ 个词/);
  assert.match(human, /明确不测/);
  assert.match(human, /恒退 0/);
});

test('nw-pitch score 读磁盘上的一本书，与 core 同一份分数', () => {
  const j = JSON.parse(run('nw-pitch.mjs', [bookDir, '--json'], 0).stdout);
  assert.equal(j.basis.kind, 'ctx', '已导出到磁盘的书按 ctx 判');
  assert.equal(j.book, '烟火纪');
  assert.ok(j.total >= 0 && j.total <= 12);
  const human = run('nw-pitch.mjs', [bookDir], 0).stdout;
  assert.match(human, new RegExp(`选题评分 ${j.total}/12 —— ${j.verdict}`), '人类可读那份的分数必须是同一个数');
  assert.match(human, /撞车未查/);
});

test('分数再低也不阻断：评分卡不是门禁', () => {
  const j = JSON.parse(run('nw-pitch.mjs', [bookDir, '--json'], 0).stdout);
  assert.ok(j.total < 12, '这本夹具书本来就该有弱项');
  run('nw-pitch.mjs', [bookDir], 0);
  run('nw-pitch.mjs', [], 2);
  // 在项目目录下不给书路径 = 只有一本时用那本，不猜第二本
  assert.equal(JSON.parse(run('nw-pitch.mjs', ['score', '--json'], 0).stdout).book, '烟火纪');
  run('nw-pitch.mjs', ['score', '--concept', path.join(tmp, 'nope.json')], 5);
});

test('nw-pitch --concept 吃向导那份 JSON，没填字数按 0 分并提示去选平台', () => {
  const file = path.join(tmp, 'concept.json');
  writeJsonAtomic(file, {
    title: '最后一班地铁',
    logline: '末班车司机发现多出来的乘客三年前就死了，谁来把她送回去？',
    characters: [{ name: '陈默', role: '主角', personality: '认死理' }, { name: '红衣女', role: '反派', personality: '总在笑' }],
    chapters: [{ title: '首班车', beat: '陈默数乘客，发现多了一个？' }, { title: '末班车', beat: '突然，红衣女在终点站下车了' }],
  });
  const bare = JSON.parse(run('nw-pitch.mjs', ['score', '--concept', file, '--json'], 0).stdout);
  assert.equal(bare.basis.kind, 'concept');
  assert.equal(bare.dims.find((d) => d.id === 'length').score, 0);
  assert.match(bare.dims.find((d) => d.id === 'length').advice, /平台/);
  assert.equal(bare.dims.find((d) => d.id === 'hook').score, 3);

  const set = JSON.parse(run('nw-pitch.mjs', ['score', '--concept', file, '--words', '8000', '--format', 'short', '--json'], 0).stdout);
  assert.equal(set.total, 12);
  assert.equal(set.verdict, '可以动笔');
  assert.match(run('nw-pitch.mjs', ['score', '--concept', file]).stdout, /《最后一班地铁》/);

  const bad = path.join(tmp, 'bad-concept.json');
  writeFileAtomic(bad, '{这不是 JSON');
  const r = run('nw-pitch.mjs', ['score', '--concept', bad], 5);
  assert.match(r.stderr, /不是合法 JSON/);
});

test('nw-pitch --against 才查撞车，且绝不跟自己比', () => {
  const other = path.join(tmp, 'against-box');
  const twin = scaffoldBook(other, {
    slug: 'twin', id: 'novel_twin', title: '末班车', genre: '悬疑',
    description: '末班车司机发现多出来的乘客三年前就死了，谁来把她送回去？',
  });
  const concept = path.join(tmp, 'concept2.json');
  writeJsonAtomic(concept, { title: '归途', logline: '末班车司机发现多出来的乘客三年前就死了，谁来把她送回去？', characters: [], chapters: [] });

  const j = JSON.parse(run('nw-pitch.mjs', ['score', '--concept', concept, '--against', twin, '--json'], 0).stdout);
  assert.deepEqual(j.against, ['末班车']);
  assert.match(j.dims.find((d) => d.id === 'diff').reason, /重合/);

  // 给自己打分时对照表里只有自己：剔掉它，否则每本书都跟自己撞车
  const self = JSON.parse(run('nw-pitch.mjs', [twin, '--json'], 0).stdout);
  assert.deepEqual(self.against, []);
  assert.ok(!/重合/.test(self.dims.find((d) => d.id === 'diff').reason), '自己不该成为自己的对照书');
  // 点名拿自己当对照：要说清「没比成是因为只有你自己」，不许推给「没给对照书」
  const selfHuman = run('nw-pitch.mjs', [twin, '--against', twin]).stdout;
  assert.match(selfHuman, /对照只有这本书自己/);
  assert.ok(!/未给对照书/.test(selfHuman), '给了 --against 却被说成没给，那是撒谎');
});

// ═══════════ nw-style.mjs · 文风指纹 ═══════════

const FIT_LONG = '他沿着石阶往上走，雾贴着脚背流动，山门还在很远的地方，钟声从崖下传上来一声隔着一声。';
const FIT_TALK = '“你来晚了。”他低声说。\n“我知道。”她没有回头。';
const fitRep = (n, unit) => Array.from({ length: n }, () => unit).join('\n\n');

let fitSeq = 0;
/** 造一本磁盘上的书：前两章同一种长句笔法，第三章短句加对话，第四章故意太短。 */
function styleBook() {
  const box = path.join(tmp, `style-box-${++fitSeq}`);
  const book = scaffoldBook(box, { slug: `sb${fitSeq}`, id: `novel_style${fitSeq}`, title: '问剑', genre: '仙侠' });
  const specs = [
    { title: '山门', body: fitRep(24, FIT_LONG) },
    { title: '夜袭', body: fitRep(24, FIT_LONG) },
    { title: '下山', body: fitRep(40, FIT_TALK) },
    { title: '挑水', body: '他挑水。' },
  ];
  specs.forEach((s, i) => {
    const meta = NWBible.newChapter({ id: `ch-00${i + 1}`, number: i + 1, slug: `s${i + 1}`, title: s.title, status: 'draft' });
    meta.schemaVersion = NWBible.SCHEMA_VERSION;
    meta['x-words'] = NWText.countWords(s.body);
    writeFileAtomic(path.join(book, 'manuscript', 'chapters', NWBible.chapterFileName(meta)), NWBible.serializeChapterFile(meta, s.body));
  });
  // scaffoldBook 里的 _derived 是全 0，补完正文就必须走库内那个唯一出口重算，
  // 否则这本夹具一开场就自报 derived-field-touched，跑在它上面的门禁命令全退 3。
  recountBook(book);
  return book;
}
const bookJson = (book) => JSON.parse(fs.readFileSync(path.join(book, 'book.json'), 'utf8'));

test('nw-style keys：四格与门槛都从包里现取，也交代了它不测什么', () => {
  const j = JSON.parse(run('nw-style.mjs', ['keys', '--json'], 0).stdout);
  assert.deepEqual(j.keys.map((k) => k.id), NWStyleFit.KEYS.map((k) => k.id));
  assert.deepEqual(j.keys.map((k) => k.threshold), NWStyleFit.KEYS.map((k) => k.dev), 'CLI 里抄了第二份门槛');
  assert.equal(j.minBodyWords, NWStyleFit.MIN_BODY);
  assert.deepEqual(j.notMeasured, ['文笔高低', '一个总分', '语义相似度']);

  const human = run('nw-style.mjs', ['keys'], 0).stdout;
  assert.match(human, new RegExp(`正文 ≥${NWStyleFit.MIN_BODY} 字`), '够不够格的数字要说出口');
  assert.match(human, /不合成总分/);
  assert.match(human, /明确不算：文笔高低/);
  assert.match(human, /只认 book\.styleAnchor 勾定的基准章/);
});

test('没勾基准时这份视图照样给数字，但话术不许把它叫作标准，R32 也一条不报', () => {
  const book = styleBook();
  const j = JSON.parse(run('nw-style.mjs', [book, '--json'], 0).stdout);
  assert.equal(j.baseline.source, 'auto');
  assert.deepEqual(j.baseline.declared, []);
  assert.equal(j.baseline.chapters, 3, '没勾时参照是全部够格的章，不是最近两章');
  assert.deepEqual(j.chapters.map((c) => c.role), ['chapter', 'chapter', 'chapter', 'too-short']);
  assert.equal(j.chapters[3].words, 0, '太短的章不许编一个字数');

  const human = run('nw-style.mjs', [book], 0).stdout;
  assert.match(human, /未勾定基准/);
  assert.match(human, /R32 在这种情况下一条不报/);
  assert.match(human, /两章彼此一模一样也可能各报偏离/, '参照被离群章拖走这件事要当场说，不然数字看着像指控');
  assert.match(human, /第4章《挑水》　正文不足 \d+ 字，不进指纹/);

  const gate = JSON.parse(run('nw-continuity.mjs', [book, '--rules', 'R32', '--json'], 0).stdout);
  assert.deepEqual(gate.diagnostics, [], '没勾基准就没有基准，机检必须整条闭嘴');
});

test('anchor --set 勾定基准：写的就是 book.styleAnchor，越几格与 R32 报的是同一件事', () => {
  const book = styleBook();
  assert.equal('styleAnchor' in bookJson(book), false);
  const j = JSON.parse(run('nw-style.mjs', ['anchor', book, '--set', 'ch-001,ch-002', '--json'], 0).stdout);
  assert.deepEqual(bookJson(book).styleAnchor, { chapterIds: ['ch-001', 'ch-002'] }, 'book.json 里没落成 R32 认的那个形状');
  assert.deepEqual(j.baseline.declared, ['ch-001', 'ch-002']);
  assert.equal(j.baseline.source, 'anchor');
  assert.equal(j.baseline.fingerprint.words, 1824, '基准按两章加权，不是各章比值再平均');
  assert.deepEqual(j.chapters.map((c) => c.role), ['baseline', 'baseline', 'chapter', 'too-short'], '基准章不评自己');
  assert.deepEqual(j.chapters[2].drift.map((d) => d.id), ['sentAvg', 'dialogue', 'paraSent']);

  // 与 core 同一把尺：同样的夹具在测试里再算一遍，话术与数字必须一字不差
  const core = NWStyleFit.compare(
    NWStyleFit.fingerprint([{ id: 'a', body: fitRep(24, FIT_LONG) }, { id: 'b', body: fitRep(24, FIT_LONG) }], {}),
    NWStyleFit.fingerprint([{ id: 'c', body: fitRep(40, FIT_TALK) }], {}));
  assert.deepEqual(j.chapters[2].drift.map((d) => d.text), core.map((d) => d.text));

  const human = run('nw-style.mjs', [book], 0).stdout;
  assert.match(human, /作者勾定的基准：第1章《山门》、第2章《夜袭》/);
  assert.match(human, /第3章《下山》　640 字 · 越 3 格：句均字数 38\.0 字→4\.0 字（降 89%）/);
  assert.match(human, /第1章《山门》　基准，不评自己/);

  const gate = JSON.parse(run('nw-continuity.mjs', [book, '--rules', 'R32', '--json'], 0).stdout);
  assert.deepEqual(gate.diagnostics.map((d) => [d.chapter, d.severity]), [['ch-003', 'info']],
    '视图里越三格的那一章与机检报的那一章必须是同一章，且永远只是 info');

  // 勾了基准，导出去再读回来还认这几章（与 Web 侧共用同一条桥）
  const v = JSON.parse(run('nw-validate.mjs', [book, '--json', '--no-write'], 0).stdout);
  assert.deepEqual(v.diagnostics.filter((d) => d.severity === 'error'), [], '勾完基准的书必须仍然过 schema');
});

test('anchor --clear 是删掉这一格，不是留一个 schema 不认的 null', () => {
  const book = styleBook();
  run('nw-style.mjs', ['anchor', book, '--set', 'ch-001'], 0);
  assert.deepEqual(bookJson(book).styleAnchor, { chapterIds: ['ch-001'] });
  const keysBefore = Object.keys(bookJson(book));
  run('nw-style.mjs', ['anchor', book, '--clear', '--json'], 0);
  assert.equal('styleAnchor' in bookJson(book), false, '留一个空键就不叫取消');
  assert.deepEqual(Object.keys(bookJson(book)), keysBefore.filter((k) => k !== 'styleAnchor'), '除了这一格，别的键一个不许动');
  assert.equal(bookJson(book).title, '问剑');
  assert.equal(JSON.parse(run('nw-style.mjs', [book, '--json'], 0).stdout).baseline.source, 'auto');
  const v = JSON.parse(run('nw-validate.mjs', [book, '--json', '--no-write'], 0).stdout);
  assert.deepEqual(v.diagnostics.filter((d) => d.severity === 'error'), [], '取消基准之后 validate 仍要 0 error');
});

test('anchor 的参数错要说清能勾哪些章，且一个字都不落盘', () => {
  const book = styleBook();
  const snapshot = fs.readFileSync(path.join(book, 'book.json'), 'utf8');
  let r = run('nw-style.mjs', ['anchor', book, '--set', 'ch-009,ch-001'], 2);
  assert.match(r.stderr, /不在书里：ch-009/);
  assert.match(r.stderr, /ch-001、ch-002、ch-003、ch-004/, '拒绝的时候要给出可写的清单');
  r = run('nw-style.mjs', ['anchor', book, '--set', 'ch-001', '--clear'], 2);
  assert.match(r.stderr, /只能给一个/);
  run('nw-style.mjs', ['anchor', book, '--set', ''], 2);
  run('nw-style.mjs', ['anchor', book], 2);
  assert.equal(fs.readFileSync(path.join(book, 'book.json'), 'utf8'), snapshot, '参数错了却不许已经动过盘');
  run('nw-style.mjs', ['anchor', path.join(tmp, 'no-such-book'), '--set', 'ch-001'], 5);
  run('nw-style.mjs', [], 2);
});

test('注入预览与生成时同一函数同一预算：样例是谁、指纹多少都跟着基准走', () => {
  const book = styleBook();
  const auto = JSON.parse(run('nw-style.mjs', [book, '--json'], 0).stdout);
  assert.deepEqual(auto.injected.chapters, ['第2章《夜袭》', '第3章《下山》'], '没勾基准时按就近取，取的是最后两章');
  // 「在场两章」与「全书合格章」必须是两个不同的数，否则这句断言钉不住任何东西
  const inPool = NWStyleFit.fingerprint(
    [{ id: 'b', body: fitRep(24, FIT_LONG) }, { id: 'c', body: fitRep(40, FIT_TALK) }], {});
  const allEligible = NWStyleFit.fingerprint([
    { id: 'a', body: fitRep(24, FIT_LONG) }, { id: 'b', body: fitRep(24, FIT_LONG) },
    { id: 'c', body: fitRep(40, FIT_TALK) }], {});
  assert.ok(inPool.words < allEligible.words, `夹具塌了：两章 ${inPool.words} 字竟然不比全书 ${allEligible.words} 字小`);
  assert.match(auto.injected.fitLine, new RegExp(`【基准指纹】2 章 / ${inPool.words} 字`),
    '那一行说的必须是在场这两章的字数，不是全书的');

  run('nw-style.mjs', ['anchor', book, '--set', 'ch-001,ch-002', '--json'], 0);
  const pinned = JSON.parse(run('nw-style.mjs', [book, '--json'], 0).stdout);
  assert.deepEqual(pinned.injected.chapters, ['第1章《山门》', '第2章《夜袭》']);
  assert.equal(pinned.injected.fitLine, NWStyleFit.lines(NWStyleFit.fingerprint(
    [{ id: 'ch-001', body: fitRep(24, FIT_LONG) }, { id: 'ch-002', body: fitRep(24, FIT_LONG) }], {})));
});

test('关系账本一路走到 prompt：磁盘上 relations.json 里那条师徒要进「活跃关系」', () => {
  const rel = path.join(bookDir, 'bible', 'relations.json');
  const was = fs.existsSync(rel) ? fs.readFileSync(rel, 'utf8') : null;
  try {
    writeJsonAtomic(rel, {
      schemaVersion: NWBible.SCHEMA_VERSION,
      edges: [
        { id: 'rel-1', from: 'char-lin', to: 'char-ming', kind: '师徒', address: '师父', since: 'ch-001', until: null, notes: '' },
        { id: 'rel-2', from: 'char-lin', to: 'char-ghost', kind: '敌对', since: null, until: null, notes: '' },
      ],
    });
    const human = run('nw-context.mjs', [bookDir, '--chapter', 'ch-003']).stdout;
    assert.match(human, /## 活跃关系/, '关系边整个没进上下文：CLI 与 Web 共用 buildSections，缺的就是磁盘这条通路');
    assert.match(human, /- 林烟火 → 明长老：师徒（称谓「师父」）（自第 1 章起）/);
    assert.doesNotMatch(human, /char-ghost/, '解析不到人的那条边不该被拼进 prompt，它由 R15 说出口');

    const j = JSON.parse(run('nw-context.mjs', [bookDir, '--chapter', 'ch-003', '--json']).stdout);
    const row = j.sections.find((s) => s.name === '活跃关系');
    assert.ok(row && row.present, 'usage 里说这节没进 prompt，可正文里明明有');
    assert.deepEqual(row.included, ['登记关系边'], '这一节的出处要说得出：只有账本里登记过的边');
  } finally {
    if (was === null) fs.rmSync(rel); else fs.writeFileSync(rel, was);
  }
});
