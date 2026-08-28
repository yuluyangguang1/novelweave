#!/usr/bin/env node
/**
 * install.mjs — 把 skills/ 这一个权威源装到各 agent 的官方目录
 *
 * 用法：
 *   node tools/install.mjs --all | --only=claude,qoder | --except=codex
 *   node tools/install.mjs --status [--json]
 *   node tools/install.mjs --uninstall [--only=…] [--purge]
 *   以上均可加 --dry-run
 *
 * 安全边界（这个脚本会写到仓库之外，所以刻意保守）：
 *   · 只删除 manifest 里登记为自己装的东西；用户自装的同名目录一律不动（除非 --force）
 *   · 往已有文件（CLAUDE.md / AGENTS.md）插入指针块时：先备份一次，再用标记块精确替换，
 *     卸载只切除标记之间的内容，不碰文件其余部分
 *   · 没有公开格式文档的 agent 不写任何文件，只打印解析过真实绝对路径的手动指引
 *   · 路径含非 ASCII 的用户名，全部走 fs/path API，不拼 shell 字符串
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AGENTS, SKILLS, STAGED_DIR, MANIFEST_FILE, POINTER_BLOCK, CURSOR_RULE, POINTER_MARK_BEGIN, POINTER_MARK_END } from './agents.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = fs.readFileSync(path.join(repoRoot, 'skills', 'novelweave', 'SKILL.md'), 'utf8')
  .match(/^metadata:\n\s+version:\s*"?([\d.]+)"?/m)?.[1] || '0.0.0';

/** 每个 skill 装完必须自包含：SKILL.md 里写的 `node scripts/...` 要在装出来的目录里真能跑。 */
const PAYLOAD_DIRS = ['scripts', 'src/core', 'schemas'];

function expand(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}
const toPosix = (p) => p.split(path.sep).join('/');

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(abs, base));
    else out.push(abs);
  }
  return out;
}

/** skill 目录下直接放 SKILL.md，附属目录与源同级：scripts/ src/core/ schemas/ */
function skillPayloadMap(skill) {
  const skillRoot = path.join(repoRoot, 'skills', skill);
  const files = listFiles(skillRoot).map((f) => ({ abs: f, rel: path.relative(skillRoot, f) }));
  for (const d of PAYLOAD_DIRS) {
    const dir = path.join(repoRoot, d);
    for (const f of listFiles(dir)) files.push({ abs: f, rel: path.join(d, path.relative(dir, f)) });
  }
  return files;
}

function sourceTreeHash() {
  const h = crypto.createHash('sha256');
  for (const skill of SKILLS) {
    for (const f of skillPayloadMap(skill)) {
      h.update(skill).update('/').update(f.rel).update('\0').update(fs.readFileSync(f.abs)).update('\0');
    }
  }
  return 'sha256:' + h.digest('hex');
}

/** Hermes 要求顶层 version。用最保守的文本插入，不解析 YAML —— 猜错格式比不改更糟。 */
function applyFrontmatter(text, needs) {
  if (!needs?.needsTopLevel) return text;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text;
  let block = m[1];
  let changed = false;
  for (const [key, value] of Object.entries(needs.needsTopLevel)) {
    if (new RegExp(`^${key}:`, 'm').test(block)) continue;
    block = `${key}: ${value}\n` + block;
    changed = true;
  }
  return changed ? text.replace(m[0], `---\n${block}\n---`) : text;
}

function copyPayload({ staged, skill, dryRun }) {
  const destDir = path.join(staged, skill);
  const written = [];
  for (const f of skillPayloadMap(skill)) {
    const dest = path.join(destDir, f.rel);
    written.push(dest);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(f.abs));
  }
  return { destDir, files: written.length };
}

function placeSkillDir(agent, staged, { dryRun, force, manifest }) {
  const target = expand(agent.target);
  const results = [];
  for (const skill of SKILLS) {
    const src = path.join(staged, skill);                       // 权威源恒为扁平
    const layout = agent.layout === 'category' ? path.join(agent.category || 'writing', skill) : skill;
    const dest = path.join(target, layout);                     // 只有落位遵循 agent 布局
    const exists = fs.existsSync(dest);
    const managed = (manifest.placements || []).some((p) => p.path === dest);
    if (exists && !managed && !force) {
      results.push({ agent: agent.key, skill, path: dest, action: 'skipped-exists' });
      continue;
    }
    if (exists && !managed && force) {
      if (!dryRun) fs.renameSync(dest, `${dest}.pre-nw`);
      results.push({ agent: agent.key, skill, path: dest, action: 'moved-aside', backup: `${dest}.pre-nw` });
    }
    if (!dryRun) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
      // 权威源保持原文；各 agent 的 frontmatter 差异在落位这一步才施加
      const entry = path.join(dest, 'SKILL.md');
      if (agent.frontmatter?.needsTopLevel && fs.existsSync(entry)) {
        fs.writeFileSync(entry, applyFrontmatter(fs.readFileSync(entry, 'utf8'), agent.frontmatter), 'utf8');
      }
    }
    results.push({ agent: agent.key, skill, path: dest, action: 'installed' });
  }
  return results;
}

/** 标记块：幂等插入 / 替换 / 精确切除 */
function upsertBlock(file, block, { dryRun, remove = false }) {
  const existed = fs.existsSync(file);
  if (remove) {
    if (!existed) return { file, action: 'absent' };
    const text = fs.readFileSync(file, 'utf8');
    const stripped = stripBlock(text);
    if (!stripped.trim()) {
      if (!dryRun) fs.rmSync(file, { force: true });
      return { file, action: 'removed-empty' };
    }
    if (!dryRun) writeFileWithBackup(file, stripped);
    return { file, action: 'block-removed' };
  }
  if (!existed) {
    if (!dryRun) fs.writeFileSync(file, block + '\n', 'utf8');
    return { file, action: 'created' };
  }
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(POINTER_MARK_BEGIN) && text.includes(block)) return { file, action: 'up-to-date' };
  if (!dryRun) writeFileWithBackup(file, (stripBlock(text).trimEnd() + '\n\n' + block + '\n'));
  return { file, action: 'block-updated' };
}

function stripBlock(text) {
  const re = new RegExp(`${POINTER_MARK_BEGIN}[\\s\\S]*?${POINTER_MARK_END}\\n?`, 'g');
  return text.replace(re, '');
}

function writeFileWithBackup(file, text) {
  const bak = `${file}.novelweave.bak`;
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);   // 只备份一次
  const tmp = `${file}.nw-tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function detectAgent(agent) {
  const found = [];
  for (const d of agent.detect) {
    const abs = expand(d);
    if (fs.existsSync(abs)) found.push(abs);
  }
  return found;
}

/** probe 类：只有能证明它按 agentskills 布局工作（已有 <x>/<skill>/SKILL.md）才装。 */
function probeInstall(agent, staged, { dryRun }) {
  for (const dir of detectAgent(agent)) {
    const scanRoots = [dir, path.join(dir, 'skills')];
    for (const root of scanRoots) {
      if (!fs.existsSync(root)) continue;
      const existing = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, e.name, 'SKILL.md'))
        .find((f) => fs.existsSync(f));
      if (existing) {
        const results = placeSkillDir({ ...agent, target: root, layout: 'flat' }, staged, { dryRun, force: false, manifest: {} });
        return { status: 'installed-heuristic', target: root, evidence: existing, results,
          warning: `${agent.label} 的格式未经验证，本次按 agentskills 通用布局装入 ${root}` };
      }
    }
  }
  return { status: 'manual', reason: 'no-verified-skill-dir', pathsToCheck: agent.detect.map(toPosix).map(expand2),
    instructions: `把 ${toPosix(path.join(staged, 'novelweave'))} 与 ${toPosix(path.join(staged, 'novelweave-continuity'))} 两个目录整体复制到 ${agent.label} 的技能目录（本脚本未写入任何文件）` };
}
const expand2 = (p) => toPosix(expand(p));

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  const cmds = [];
  for (const a of argv) {
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; }
    else cmds.push(a);
  }
  const json = !!flags.json, dryRun = !!flags['dry-run'];
  const manifestFile = expand(MANIFEST_FILE);
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { version: VERSION, placements: [], pointers: [] };

  const pick = flags.all ? AGENTS
    : flags.only ? String(flags.only).split(',').map((k) => AGENTS.find((a) => a.key === k.trim())).filter(Boolean)
    : flags.except ? AGENTS.filter((a) => !String(flags.except).split(',').includes(a.key))
    : AGENTS;

  const staged = expand(STAGED_DIR);
  const srcHash = sourceTreeHash();
  const report = { version: VERSION, srcTreeHash: srcHash, dryRun, staged, actions: [], manual: [] };

  if (flags.status) {
    for (const agent of pick) {
      const detected = detectAgent(agent);
      const placements = (manifest.placements || []).filter((p) => p.agent === agent.key);
      report.actions.push({
        agent: agent.key, label: agent.label, confidence: agent.confidence,
        detected: detected.map(toPosix),
        installed: placements.map((p) => ({ path: toPosix(p.path), exists: fs.existsSync(p.path) })),
        state: !detected.length ? 'not-detected' : placements.length && placements.every((p) => fs.existsSync(p.path)) ? 'installed' : 'missing',
      });
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  // ── 物化权威源（幂等：哈希相同就跳过） ──
  if (fs.existsSync(manifestFile) && manifest.srcTreeHash === srcHash && !flags.force) {
    process.stderr.write(`权威源已是最新（${srcHash.slice(0, 18)}…）\n`);
  } else {
    for (const skill of SKILLS) {
      const r = copyPayload({ staged, skill, dryRun });
      report.actions.push({ agent: 'stage', skill, path: toPosix(r.destDir), files: r.files, action: dryRun ? 'would-stage' : 'staged' });
    }
  }

  if (flags.uninstall) {
    for (const p of (manifest.placements || [])) {
      if (!pick.some((a) => a.key === p.agent)) continue;
      if (fs.existsSync(p.path)) { if (!dryRun) fs.rmSync(p.path, { recursive: true, force: true }); report.actions.push({ agent: p.agent, path: toPosix(p.path), action: 'removed' }); }
    }
    for (const pt of (manifest.pointers || [])) {
      const r = upsertBlock(pt.file, '', { dryRun, remove: true });
      report.actions.push({ agent: pt.agent, path: toPosix(pt.file), action: r.action });
    }
    if (flags.purge && !dryRun) fs.rmSync(path.dirname(manifestFile), { recursive: true, force: true });
    else if (!dryRun) {
      const keep = (list) => list.filter((x) => !pick.some((a) => a.key === x.agent));
      manifest.placements = keep(manifest.placements || []);
      manifest.pointers = keep(manifest.pointers || []);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  for (const agent of pick) {
    const detected = detectAgent(agent);
    if (agent.kind === 'probe') {
      const r = probeInstall(agent, staged, { dryRun });
      if (r.status === 'manual') { report.manual.push({ agent: agent.key, label: agent.label, ...r }); report.actions.push({ agent: agent.key, action: 'manual-only' }); }
      else { report.actions.push({ agent: agent.key, action: r.status, warning: r.warning, results: r.results }); }
      continue;
    }
    if (!detected.length && agent.scope === 'user') {
      report.actions.push({ agent: agent.key, action: 'not-detected', checked: agent.detect.map(toPosix) });
      continue;
    }
    if (agent.kind === 'skill-dir') {
      const results = placeSkillDir(agent, staged, { dryRun, force: !!flags.force, manifest });
      for (const r of results) {
        report.actions.push({ agent: agent.key, skill: r.skill, path: toPosix(r.path), action: r.action });
        if (r.action === 'installed' && !dryRun) manifest.placements.push({ agent: agent.key, skill: r.skill, path: r.path, at: new Date().toISOString() });
      }
      if (agent.pointer?.mode === 'block' && agent.pointer.file) {
        const file = expand(agent.pointer.file);
        const r = upsertBlock(file, POINTER_BLOCK(toPosix(staged)), { dryRun });
        report.actions.push({ agent: agent.key, path: toPosix(file), action: r.action });
        if (!dryRun && !manifest.pointers.some((p) => p.file === file)) manifest.pointers.push({ agent: agent.key, file });
      }
      continue;
    }
    if (agent.kind === 'pointer') {
      const rel = agent.pointer.file;
      const cwd = path.resolve(process.cwd());
      if (agent.scope === 'project' && (cwd === repoRoot || cwd.startsWith(repoRoot + path.sep))) {
        report.actions.push({ agent: agent.key, action: 'refused-inside-repo', note: 'project 作用域会把规则写进 cwd，不能写进本仓库自身；请在目标书项目目录下运行' });
        continue;
      }
      const file = agent.scope === 'project' ? path.resolve(process.cwd(), rel) : expand(rel);
      const content = path.extname(file) === '.mdc' ? CURSOR_RULE(toPosix(staged)) : POINTER_BLOCK(toPosix(staged));
      const r = agent.pointer.mode === 'file'
        ? (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content
            ? { file, action: 'up-to-date' }
            : (() => { if (!dryRun) writeFileWithBackup(file, content); return { file, action: 'written' }; })())
        : upsertBlock(file, content, { dryRun });
      report.actions.push({ agent: agent.key, path: toPosix(file), action: r.action, scope: agent.scope });
      if (!dryRun && !manifest.pointers.some((p) => p.file === file)) manifest.pointers.push({ agent: agent.key, file });
    }
  }

  if (!dryRun) {
    manifest.srcTreeHash = srcHash;
    manifest.version = VERSION;
    manifest.installedSkills = SKILLS;
    manifest.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  }

  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    for (const a of report.actions) process.stdout.write(`${dryRun ? '[试运行] ' : ''}${a.agent.padEnd(10)} ${a.action.padEnd(16)} ${a.path || ''}\n`);
    for (const m of report.manual) {
      process.stdout.write(`\n${m.label}：未写入任何文件（${m.reason}）\n`);
      process.stdout.write(`  探测过：${m.pathsToCheck.join(', ')}\n`);
      process.stdout.write(`  请手动：${m.instructions}\n`);
    }
  }
}

main();
