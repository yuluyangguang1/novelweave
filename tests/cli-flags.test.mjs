import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, parseArgs, unknownFlagMessage, EXIT } from './_load-cli.mjs';

const script = (name) => path.join(repoRoot, 'scripts', name);
const CLIS = ['nw-io.mjs', 'nw-changes.mjs', 'nw-context.mjs', 'nw-continuity.mjs',
  'nw-pitch.mjs', 'nw-prose.mjs', 'nw-style.mjs', 'nw-validate.mjs', 'nw-workflow.mjs'];

function run(name, args, cwd = null) {
  const r = spawnSync(process.execPath, [script(name), ...args],
    { encoding: 'utf8', cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('不认识的开关被拒，且点名的是作者写的那一个', () => {
  for (const name of CLIS) {
    // nw-io 的第一个位置参数是子命令，开关只能跟在它后面；其余各支的解析都在顶层
    const args = name === 'nw-io.mjs' ? ['locate', '--这个开关谁都没写过'] : ['--这个开关谁都没写过'];
    const r = run(name, args);
    assert.equal(r.code, EXIT.USAGE, `${name} ${args.join(' ')} 该退 2：${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /不认识这个开关：--这个开关谁都没写过/, `${name} 没点名那一个：${r.stderr}`);
    assert.match(r.stderr, /这一支认的是：--/, `${name} 没把认得的清单念出来：${r.stderr}`);
    assert.equal(r.stdout, '', `${name} 拒绝之前不该先打印半份结果`);
  }
});

test('认得的开关不许被拒：九支各喂一次自家的 --json', () => {
  for (const name of CLIS) {
    const args = name === 'nw-io.mjs' ? ['locate', '--json'] : ['--json'];
    const r = run(name, args);
    assert.doesNotMatch(r.stderr, /不认识这个开关/, `${name} 把自家的 --json 拒了：${r.stderr}`);
  }
});

test('驼峰写错时给近邻建议，而不是拒了就完', () => {
  const r = run('nw-io.mjs', ['locate', '--dryRun']);
  assert.equal(r.code, EXIT.USAGE, r.stderr);
  assert.match(r.stderr, /你是不是想写 --dry-run/, r.stderr);
});

test('建议只在本家真有那一个时才说', () => {
  const msg = unknownFlagMessage(['dryRun'], ['json', 'out']);
  assert.doesNotMatch(msg, /你是不是想写/, `没有近邻却编了一个：${msg}`);
  assert.match(msg, /不认识这个开关：--dryRun/);
});

test('下划线写错与驼峰写错是同一种错', () => {
  const msg = unknownFlagMessage(['dry_run'], ['dry-run', 'json']);
  assert.match(msg, /你是不是想写 --dry-run/, msg);
});

test('未知开关在读书之前就被挡住：坏目录也退 2，不是退 5', () => {
  const r = run('nw-io.mjs', ['locate', '--dir', 'Z:\\根本没有这种路径', '--bogus']);
  assert.equal(r.code, EXIT.USAGE, `先加载书才拒 = 报错方向误导：${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /不认识这个开关：--bogus/);
});

test('清单缺席就等于退回「不认识的也收下」，所以当场抛', () => {
  assert.throws(() => parseArgs(['--whatever'], undefined), /要带这一支认得的开关清单/);
  assert.throws(() => parseArgs([], null), /要带这一支认得的开关清单/);
});

test('等号写法与空格写法是同一个意思（nw-io 以前不认等号）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-flags-'));
  const space = run('nw-io.mjs', ['locate', '--dir', tmp]);
  const equal = run('nw-io.mjs', ['locate', `--dir=${tmp}`], process.cwd());
  assert.equal(equal.code, space.code, `两种写法退码不同：${space.code} vs ${equal.code}`);
  assert.equal(equal.stderr, space.stderr, `等号那份没把值当成 --dir 的值：${equal.stderr}`);
  assert.match(space.stderr + space.stdout, /project\.json|"found"/, '夹具本身没跑到 locate 那条路');
});

test('那句拒绝不念引擎英文，建议只给真有近邻的那一个', () => {
  const msg = unknownFlagMessage(['failOn', 'webook'], ['fail-on', 'book', 'json']);
  assert.doesNotMatch(msg, /Error|unknown option|unrecognized/, msg);
  assert.match(msg, /不认识这个开关：--failOn、--webook/, msg);
  assert.equal(msg.split('\n')[1], '你是不是想写 --fail-on？', `第二行只该列有近邻的那个：${msg}`);
});

// 上面测的是「传错了会被拒」。这一节测清单自己会不会说谎 ——
// 说明书上点了名却没人读的开关，和收了别人不认的开关，是同一种病的两个方向。

const readScript = (rel) => fs.readFileSync(path.join(repoRoot, 'scripts', rel), 'utf8');

const declaredFlags = (src) => {
  const m = /const FLAGS = \[([^\]]*)\]/.exec(src);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
};

// 两种写法都算「真有人读」：flags.dryRun 与 flags['dry-run']
const flagsRead = (src) => {
  const out = new Set();
  for (const m of src.matchAll(/flags\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/flags\[['"]([A-Za-z0-9_-]+)['"]\]/g)) out.add(m[1]);
  return [...out].sort();
};

const docBlock = (src) => {
  const start = src.indexOf('/**');
  const end = src.indexOf('*/', start);
  return start < 0 || end < 0 ? '' : src.slice(start, end);
};

const flagsMentioned = (text) => {
  const out = new Set();
  for (const m of text.matchAll(/--([a-z][a-z0-9-]*)/g)) out.add(m[1]);
  return [...out].sort();
};

test('注释头点名的开关都在清单里：说明书里不许有假入口', () => {
  for (const name of CLIS) {
    const src = readScript(name);
    const ghost = flagsMentioned(docBlock(src)).filter((f) => !(declaredFlags(src) ?? []).includes(f));
    assert.deepEqual(ghost, [], `${name} 的注释头点了 --${ghost.join('、--')} 的名，清单里却没有`);
  }
});

test('清单里没有没人读的开关：多列一个就是多宣称一个入口', () => {
  for (const name of CLIS) {
    const src = readScript(name);
    const dead = (declaredFlags(src) ?? []).filter((f) => !flagsRead(src).includes(f));
    assert.deepEqual(dead, [], `${name} 的 FLAGS 列了 ${dead.join('、')}，全文却没有一处读它`);
  }
});

test('真被读到的开关都在清单里：不然这一支会拒掉自己人的写法', () => {
  for (const name of CLIS) {
    const src = readScript(name);
    const declared = declaredFlags(src) ?? [];
    const unlisted = flagsRead(src).filter((f) => !declared.includes(f));
    assert.deepEqual(unlisted, [], `${name} 读了 ${unlisted.join('、')} 却没列进清单`);
  }
});

test('九支都只走 parseArgs 那一道口：argv 交进去，不许自己切成开关', () => {
  for (const name of CLIS) {
    const src = readScript(name);
    assert.doesNotMatch(src, /startsWith\('--'\)/, `${name} 自己扫了一遍 argv —— 那道拒绝就被绕过去了`);
    assert.match(src, /parseArgs\(process\.argv\.slice\(\d\), FLAGS\)/, `${name} 没把自家的清单交给 parseArgs`);
  }
  const lib = readScript('lib/book.mjs');
  assert.equal((lib.match(/startsWith\('--'\)/g) ?? []).length, 2,
    '那道扫描只该是 book.mjs 里同一个 for 的两个判点');
});

test('拒绝那三句话术只有一个出处：CLI 里不许再抄一遍', () => {
  const phrases = ['不认识这个开关', '你是不是想写', '这一支认的是'];
  for (const name of CLIS) {
    const src = readScript(name);
    for (const p of phrases) assert.ok(!src.includes(p), `${name} 自己写了一份「${p}」，以后改一句要改十处`);
  }
  const lib = readScript('lib/book.mjs');
  for (const p of phrases) {
    assert.equal((lib.match(new RegExp(p, 'g')) ?? []).length, 1, `book.mjs 里「${p}」不止一份`);
  }
});

test('清单这件事在文档里说给作者与 agent 听了', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /const FLAGS/, 'README 没点名每支那份清单');
  assert.match(readme, /parseArgs/, 'README 没点名唯一的扫描口');
  const skill = fs.readFileSync(path.join(repoRoot, 'skills/novelweave/SKILL.md'), 'utf8');
  assert.match(skill, /退 2/, 'SKILL 的统一约定没说写错开关会退 2，agent 照样以为传对了');
});

test('H 的规格写进了 roadmap，T 节那条遗留也改了口', () => {
  const road = fs.readFileSync(path.join(repoRoot, 'docs/roadmap.md'), 'utf8');
  assert.match(road, /^## H\. .*命令行那一份开关清单/m, 'roadmap 没有 H 节');
  assert.match(road, /开关的取值没有闸/, 'H 自己留下的那一条得进待办口径，不只写在节内');
  assert.match(road, /CLI 对未知 flag 静默忽略[\s\S]{0,220}H 节已收/,
    'T 节那条还挂着「没做」—— 两处文档对同一件事各说一遍就是这一批要消灭的病');
});

test('参考文档里点名的开关都在并集里：agent 照文档写不该被拒', () => {
  const declared = new Set(['json']);
  for (const name of CLIS) {
    const m = /const FLAGS = \[([^\]]*)\]/.exec(readScript(name));
    for (const x of (m ? m[1].matchAll(/'([^']+)'/g) : [])) declared.add(x[1]);
  }
  const files = fs.readdirSync(path.join(repoRoot, 'skills')).flatMap((skill) => {
    const dir = path.join(repoRoot, 'skills', skill, 'references');
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((x) => x.endsWith('.md')).map((x) => path.join(dir, x)) : [];
  });
  assert.ok(files.length >= 10, `参考文档只扫到 ${files.length} 份 —— 这条守卫在空转`);
  for (const file of files) {
    const ghost = [...new Set([...fs.readFileSync(file, 'utf8').matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]))]
      .filter((f) => !declared.has(f));
    assert.deepEqual(ghost, [], `${path.basename(file)} 写了 --${ghost.join('、--')}，九支的清单里却没有`);
  }
});
