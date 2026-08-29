import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
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

test('样式自洽：界面上用到的每个 class 都必须有定义', () => {
  // 重构时发现 workspace-main / ws-section 两个结构类完全没有样式、
  // 删掉静态侧栏头后留下死规则 —— 这类问题肉眼看不出来。
  const html = read('index.html');
  const js = read('src/app.js');
  const css = read('src/styles/app.css');

  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const VALID = /^[a-zA-Z][\w-]*$/;
  const used = new Set();
  for (const src of [html, js]) {
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      const raw = m[1];
      // 插值里的字符串字面量也是类名引用，如 class="${conflict ? 'cell-bad' : ''}"
      for (const q of raw.matchAll(/'([\w-]+)'/g)) used.add(q[1]);
      // 剥掉插值后再取静态部分，避免 ${ 之类残片被当成类名
      for (const c of raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
        if (VALID.test(c)) used.add(c);
      }
    }
    for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\('([\w-]+)'/g)) used.add(m[1]);
  }
  const missing = [...used].filter((c) => VALID.test(c) && !defined.has(c)).sort();
  assert.deepEqual(missing, [], `app.css 里缺这些 class 的定义：${missing.join(', ')}`);
});

test('index.html 加载的每个脚本必须能通过语法解析', () => {
  // 起因：app.js 里多写一个右括号 → 整页函数全部消失，而 110 项测试全绿，
  // 因为没有任何测试会把 app.js 当脚本解析。这类错误必须静态拦住。
  const html = read('index.html');
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 6, '没抓到脚本清单');
  const bad = [];
  for (const rel of scripts) {
    try { new vm.Script(read(rel), { filename: rel }); }
    catch (e) { bad.push(`${rel}: ${e.message.split('\n')[0]}`); }
  }
  assert.deepEqual(bad, [], `浏览器脚本语法错误：\n${bad.join('\n')}`);
});

test('sw.js 自身也要能解析', () => {
  if (!existsSync(repoPath('sw.js'))) return;
  new vm.Script(read('sw.js'), { filename: 'sw.js' });
});

test('PWA 一旦存在就必须自洽：清单覆盖页面加载的每个文件', () => {
  const hasManifest = existsSync(repoPath('manifest.webmanifest'));
  const hasSw = existsSync(repoPath('sw.js'));
  if (!hasManifest && !hasSw) return;   // 还没做 PWA，前面的测试已要求 README 不许声称
  assert.ok(hasManifest && hasSw, 'manifest 与 sw.js 必须同时存在');

  const html = read('index.html');
  assert.match(html, /rel="manifest"/, 'index.html 没链接 manifest');
  assert.match(html, /serviceWorker\.register\(['"]\.\/sw\.js['"]\)/, 'index.html 没注册 service worker');
  // 子路径部署下不能用根绝对路径
  assert.equal(/href="\/|src="\/|register\(['"]\//.test(html), false, '出现根绝对路径，会破坏 /novelweave/ 子路径部署');

  const sw = read('sw.js');
  const list = [...sw.matchAll(/^\s*'(.*?)',/gm)].map((m) => m[1]);
  const precached = new Set(list.filter((p) => p !== ''));
  const loaded = [...html.matchAll(/(?:src|href)="((?:src|icons)\/[^"?]+)/g)].map((m) => m[1]);
  const missing = loaded.filter((p) => !precached.has(p));
  assert.deepEqual(missing, [], `sw.js 预缓存清单漏了这些文件，离线会白屏：${missing.join(', ')}`);
  for (const p of precached) {
    assert.ok(existsSync(repoPath(p)), `预缓存清单里的文件不存在：${p}`);
  }
});

test('跨域请求绝不进 service worker 缓存（BYOK 请求必须直达服务商）', () => {
  if (!existsSync(repoPath('sw.js'))) return;
  const sw = read('sw.js');
  assert.match(sw, /if \(!isSameOrigin\(req\.url\)\) return;/, '缺少跨域放行守卫');
  assert.match(sw, /if \(req\.method !== 'GET'\) return;/, '缺少非 GET 放行守卫');
});

test('核心模块必须全部被页面加载且顺序正确（漏一个是静默失效）', () => {
  const html = read('index.html');
  const order = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  for (const mod of ['src/core/text.js', 'src/core/bible.js', 'src/core/rules.js', 'src/core/story.js', 'src/core/project.js']) {
    assert.ok(order.includes(mod), `${mod} 没进加载清单`);
    assert.ok(order.indexOf('src/core/text.js') <= order.indexOf(mod), `${mod} 必须排在 text.js 之后`);
  }
  assert.ok(order.indexOf('src/core/bible.js') < order.indexOf('src/core/rules.js'));
  assert.ok(order.indexOf('src/core/bible.js') < order.indexOf('src/core/story.js'));
  assert.ok(order.indexOf('src/core/story.js') < order.indexOf('src/core/project.js'));
  assert.ok(order.indexOf('src/core/text.js') < order.indexOf('src/core/db.js'));
  assert.ok(order.indexOf('src/core/text.js') < order.indexOf('src/core/llm.js'));
  assert.ok(order.indexOf('src/router.js') < order.indexOf('src/app.js'));
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
