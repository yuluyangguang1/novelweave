import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { repoPath, repoRoot } from './_load.mjs';

const read = (p) => readFileSync(repoPath(...p.split('/')), 'utf8');

/**
 * 阶段一最贵的一课：用户数据被拼进内联脚本。旧版把整章正文 JSON.stringify
 * 塞进 onclick 属性，正文里一个半角双引号就闭合了属性、那一章直接点不开。
 * 这类问题靠 review 拦不住，所以把「不允许再出现」写成测试。
 */
test('index.html 里不再有任何内联事件处理器', () => {
  const html = read('index.html');
  const hits = html.match(/\sonclick\s*=/g) || [];
  assert.equal(hits.length, 0, `发现 ${hits.length} 处 onclick，改用 data-action + 事件委托`);
});

test('app.js 里不再把数据拼进内联脚本', () => {
  const js = read('src/app.js');
  assert.equal((js.match(/\sonclick\s*=/g) || []).length, 0, 'HTML 模板串里不应出现 onclick');
  assert.equal((js.match(/onclick=\\?["']/g) || []).length, 0);
  assert.equal(js.includes('${JSON.stringify'), false, '正文一类的数据不得进模板串');
});

test('所有写进 value="…" 的动态值都必须过 attr()', () => {
  const js = read('src/app.js');
  // value="${...}" 里没走 attr 的，就是可被半角双引号突破的属性
  const bad = [...js.matchAll(/value="\$\{(?!attr\()([^}]+)\}/g)];
  assert.deepEqual(bad.map((m) => m[1].trim()), [], '未转义的属性插值');
});

test('模型输出只能以文本形式落地，不得当 HTML 注入', () => {
  const js = read('src/app.js');
  assert.equal(js.includes('target.innerHTML = full'), false);
  assert.match(js, /function renderAIResult[\s\S]{0,200}el\.textContent = text/);
});

test('旧的 escapeHtml 已被 NWText.esc 取代（它不转义引号）', () => {
  assert.equal(read('src/app.js').includes('escapeHtml'), false);
});

test('脚本加载顺序：text.js 先于依赖它的 db.js / llm.js，router.js 先于 app.js', () => {
  const html = read('index.html');
  const order = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  assert.ok(order.indexOf('src/core/text.js') < order.indexOf('src/core/db.js'));
  assert.ok(order.indexOf('src/core/text.js') < order.indexOf('src/core/llm.js'));
  assert.ok(order.indexOf('src/router.js') < order.indexOf('src/app.js'));
});

test('bible.js 必须被页面加载（浏览器实测抓到过漏加载，NWBible 是 undefined）', () => {
  const html = read('index.html');
  const order = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  assert.ok(order.includes('src/core/bible.js'), 'Story Bible 格式实现没进加载清单');
  assert.ok(order.indexOf('src/core/text.js') < order.indexOf('src/core/bible.js'));
});

test('禁止禁缩放：viewport 不得再关掉用户缩放', () => {
  const html = read('index.html');
  assert.equal(html.includes('user-scalable=no'), false);
  assert.equal(html.includes('maximum-scale=1'), false);
});

test('仓库内不得存在任何 agent 镜像目录（Qoder create-plugin 硬规则）', () => {
  const banned = ['.claude', '.claude-plugin', '.cursor', '.cursor-plugin', '.codex', '.codex-plugin', '.hermes', '.openclaw'];
  const entries = readdirSync(repoRoot, { withFileTypes: true });
  const present = entries.filter((e) => e.isDirectory() && banned.includes(e.name)).map((e) => e.name);
  assert.deepEqual(present, [], `跨 agent 分发只在安装时发生，仓库里不放镜像目录：${present.join(', ')}`);
});

test('README 不得声称尚未实现的能力', () => {
  const md = read('README.md');
  const hasManifest = existsSync(repoPath('manifest.webmanifest'));
  const hasSw = existsSync(repoPath('sw.js'));
  if (!(hasManifest && hasSw)) {
    assert.equal(/PWA[^\n]*可安装/.test(md), false, '没有 manifest 与 service worker 时，README 不该写「PWA 可安装」');
  }
});
