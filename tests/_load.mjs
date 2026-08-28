/**
 * 测试加载器：src/core 下是浏览器用的经典脚本（UMD），在 Node 里要用
 * createRequire 走 CJS 包装，并且必须先立好全局对象 —— llm.js 的 UMD
 * 工厂在 Node 下从 globalThis 取 NWText。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

globalThis.self = globalThis;
globalThis.window = globalThis;

export const NWText = (globalThis.NWText = require('../src/core/text.js'));
export const NWBible = (globalThis.NWBible = require('../src/core/bible.js'));
export const NWRules = (globalThis.NWRules = require('../src/core/rules.js'));
export const NWStory = (globalThis.NWStory = require('../src/core/story.js'));
export const NWProject = (globalThis.NWProject = require('../src/core/project.js'));
export const NovelLLM = (globalThis.NovelLLM = require('../src/core/llm.js'));
export const routerMod = require('../src/router.js');

export function readSchema() {
  return JSON.parse(readFileSync(path.join(repoRoot, 'schemas', 'story-bible.v1.json'), 'utf8'));
}

export function schemaDef(name) {
  const root = readSchema();
  return { root, def: root.$defs[name] };
}

export function repoPath(...segs) {
  return path.join(repoRoot, ...segs);
}

export { repoRoot };
