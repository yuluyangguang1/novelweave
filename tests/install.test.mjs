import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot } from './_load.mjs';

/**
 * 安装器会写到仓库之外，所以测试一律用假 HOME 跑，
 * 并且额外断言「不该写的地方没写」。
 */
const install = path.join(repoRoot, 'tools', 'install.mjs');
let home, cwd;

function run(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [install, ...args], {
      encoding: 'utf8',
      cwd: opts.cwd || cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-cwd-'));
  fs.mkdirSync(path.join(home, '.qoder'));
  fs.mkdirSync(path.join(home, '.hermes'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.zcode', 'cli', 'plugins', 'cache'), { recursive: true });
  // 用户已有的指令文件，安装必须只能追加、卸载必须原样还原
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# 我的既有指令\n\n不要动这一段。\n', 'utf8');
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('装到探测得到的 agent，且每个 skill 自包含可运行', () => {
  const r = run(['--only=qoder,hermes,claude', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);

  const qoderSkill = path.join(home, '.qoder', 'skills', 'novelweave');
  assert.ok(fs.existsSync(path.join(qoderSkill, 'SKILL.md')), 'SKILL.md 未落位');
  assert.ok(fs.existsSync(path.join(qoderSkill, 'scripts', 'nw-continuity.mjs')), 'scripts 未随附');
  assert.ok(fs.existsSync(path.join(qoderSkill, 'src', 'core', 'rules.js')), 'src/core 未随附');
  assert.ok(fs.existsSync(path.join(qoderSkill, 'schemas', 'story-bible.v1.json')), 'schemas 未随附');

  // Hermes 要 category 两级嵌套 + 顶层 version
  const hermesSkill = path.join(home, '.hermes', 'skills', 'writing', 'novelweave');
  assert.ok(fs.existsSync(path.join(hermesSkill, 'SKILL.md')), 'Hermes 未按 writing/<skill> 嵌套');
  const hermesFm = fs.readFileSync(path.join(hermesSkill, 'SKILL.md'), 'utf8').split('---')[1];
  assert.match(hermesFm, /^version:\s*[\d.]+/m, 'Hermes 缺顶层 version');
  const qoderFm = fs.readFileSync(path.join(qoderSkill, 'SKILL.md'), 'utf8').split('---')[1];
  assert.doesNotMatch(qoderFm, /^version:/m, '不该给不需要 version 的 agent 硬塞');
});

test('CLAUDE.md 用标记块追加，原有内容一字不动', () => {
  const text = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.ok(text.startsWith('# 我的既有指令\n\n不要动这一段。'), '原有内容被改写');
  assert.equal((text.match(/<!-- BEGIN novelweave -->/g) || []).length, 1);
  assert.ok(text.includes('novelweave/SKILL.md'));
});

test('重复安装是幂等的：不产生第二个标记块', () => {
  run(['--only=claude']);
  run(['--only=claude']);
  const text = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.equal((text.match(/<!-- BEGIN novelweave -->/g) || []).length, 1, '标记块被重复追加');
  assert.equal((text.match(/不要动这一段。/g) || []).length, 1, '正文被重复注入');
});

test('卸载只切除标记块并删除自己装的东西，保留用户原文件', () => {
  run(['--uninstall', '--only=claude,qoder,hermes', '--json']);
  const text = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.equal(text.includes('novelweave'), false, '卸载后仍残留指针内容');
  assert.ok(text.includes('不要动这一段。'), '卸载误删了用户原有内容');
  assert.equal(fs.existsSync(path.join(home, '.qoder', 'skills', 'novelweave')), false);
  assert.equal(fs.existsSync(path.join(home, '.hermes', 'skills', 'writing', 'novelweave')), false);
});

test('没有公开格式的 agent 不写任何文件，只给手动指引', () => {
  const r = run(['--only=zcode', '--json']);
  const report = JSON.parse(r.stdout);
  const manual = report.manual.find((m) => m.agent === 'zcode');
  assert.ok(manual, '应给出 manual 项');
  assert.equal(manual.reason, 'no-verified-skill-dir');
  assert.equal(fs.existsSync(path.join(home, '.zcode', 'skills')), false, '不该凭猜测创建目录');
  assert.ok(manual.instructions.includes('.novelweave/skills'), '指引必须给出真实可复制的路径');
});

test('--dry-run 不写任何东西', () => {
  const before = fs.existsSync(path.join(home, '.qoder', 'skills'));
  run(['--all', '--dry-run']);
  assert.equal(fs.existsSync(path.join(home, '.qoder', 'skills')), before);
});

test('project 作用域的安装不会污染本仓库', () => {
  run(['--only=cursor', '--json'], { cwd: repoRoot });
  assert.equal(fs.existsSync(path.join(repoRoot, '.cursor')), false,
    '在仓库根目录安装 cursor 会造出 agent 镜像目录，必须被拒');
});
