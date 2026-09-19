import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { repoPath, repoRoot, NWRules, NovelDB } from './_load.mjs';

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

test('界面不使用 emoji 字形，一律走内联 SVG 图标', () => {
  // emoji 是彩色位图字形，压在墨色配色上必然跳；语义已由 currentColor 描线图标 + 颜色承担
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2460}-\u{24FF}\u{1F100}-\u{1F1FF}]/gu;
  const bad = [];
  for (const f of ['index.html', 'src/app.js', 'src/styles/app.css']) {
    read(f).split('\n').forEach((line, i) => {
      const hit = line.match(EMOJI);
      if (hit) bad.push(`${f}:${i + 1} ${[...new Set(hit)].join('')} — ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(bad, [], `发现 emoji 字形：\n${bad.join('\n')}`);
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
  for (const mod of ['src/core/text.js', 'src/core/bible.js', 'src/core/rules.js', 'src/core/story.js', 'src/core/context.js', 'src/core/project.js']) {
    assert.ok(order.includes(mod), `${mod} 没进加载清单`);
    assert.ok(order.indexOf('src/core/text.js') <= order.indexOf(mod), `${mod} 必须排在 text.js 之后`);
  }
  assert.ok(order.indexOf('src/core/bible.js') < order.indexOf('src/core/rules.js'));
  assert.ok(order.indexOf('src/core/bible.js') < order.indexOf('src/core/story.js'));
  assert.ok(order.indexOf('src/core/story.js') < order.indexOf('src/core/context.js'));
  assert.ok(order.indexOf('src/core/context.js') < order.indexOf('src/core/llm.js'), 'llm 依赖 context，必须后置');
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

test('界面与 README 里写死的机器规则条数必须等于实际实现数', () => {
  // 「N 条机器规则」这个数字被 R17/R18/R19 连续三次落地甩在后面，写第二遍时
  // 没人回去改第一遍。规则表是唯一事实源，面向用户的声称值由它算出来。
  // docs/roadmap.md 不在内：它是编年记录，「阶段二 10 条」说的是当时。
  const actual = Object.keys(NWRules.RULES).length;
  const claims = [];
  for (const f of ['index.html', 'README.md']) {
    read(f).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(\d+)\s*条[^，。\n]{0,6}机器规则/g)) {
        claims.push({ file: f, line: i + 1, claimed: Number(m[1]), text: line.trim().slice(0, 50) });
      }
    });
  }
  assert.ok(claims.length > 0, '没抓到任何条数声明，检查匹配式');
  const stale = claims.filter((c) => c.claimed !== actual);
  assert.deepEqual(stale, [], `实际 ${actual} 条，这些声明过期：\n${stale.map((s) => `${s.file}:${s.line} 写 ${s.claimed} — ${s.text}`).join('\n')}`);
});

test('app.js 用到的每个 NovelDB 门面成员都必须真的存在', () => {
  // 实测事故：db.js 顶层的 `window.NovelDB = { decisions: { list: listDecisions, … },
  // usage: { list: listUsage, record: recordUsage } }` 引用了六个从未定义过的函数，
  // 于是那条赋值语句抛 ReferenceError，整个数据层根本没挂上，站点只剩一个空态首页。
  // 当时的 188 项测试全绿 —— 语法守卫只 vm.Script 解析，而这份代码语法完全合法，
  // 缺的只是符号。门面引用与暴露面必须静态对上。
  assert.equal(typeof NovelDB, 'object', 'db.js 顶层没能挂出 window.NovelDB');
  const js = read('src/app.js');
  const missing = new Set();
  for (const [, group, member] of js.matchAll(/NovelDB\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    if (NovelDB[group] === undefined) { missing.add(`NovelDB.${group}`); continue; }
    if (member && NovelDB[group][member] === undefined) missing.add(`NovelDB.${group}.${member}`);
  }
  assert.deepEqual([...missing].sort(), [], 'app.js 调用了门面上不存在的成员');
});

/** ACTIONS 的四处长法：两处字面量常量 + 若干 Object.assign(ACTIONS, {…})。 */
function actionsSource(js) {
  const parts = [];
  for (const op of ['const ACTIONS = {', 'const ADD_ACTIONS = {', 'Object.assign(ACTIONS, {']) {
    for (let i = js.indexOf(op); i !== -1; i = js.indexOf(op, i + op.length)) {
      const body = js.slice(i + op.length);
      const end = body.search(/^(?:\};|\}\));[^\n]*$/m);
      parts.push(end === -1 ? body : body.slice(0, end));
    }
  }
  return parts.join('\n');
}

test('每个 data-action 都有处理器 —— 派发器遇到未注册的名字是静默 return', () => {
  // 实测事故：设置页 8 个按钮（导出 .novelweave/、导入、EPUB、备份、保存、测试连接、选服务商）
  // 的 data-action 从来没进 ACTIONS，点了既不报错也不动；README 却把它们写成能用。
  const js = read('src/app.js');
  const registered = new Set([...actionsSource(js).matchAll(/^\s+(['"])([\w-]+)\1\s*:/gm)].map((m) => m[2]));
  // data-action="${…}" 那种拼出来的名字守卫管不到，靠 ADD_ACTIONS 与 nav-add-* 那条约定
  const used = [...read('index.html').matchAll(/data-action="([^"$]+)"/g), ...js.matchAll(/data-action="([^"$]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((a) => !registered.has(a)).sort();
  assert.deepEqual(missing, [], `这些按钮点了没反应：${missing.join('、')}`);
});

test('设置页的每个表单控件都有人读 —— 填了没人接等于没填', () => {
  const js = read('src/app.js');
  const ids = new Set([...js.matchAll(/<(?:input|select|textarea)\b[^>]*id="((?:s|ws)-[\w-]+)"/g)].map((m) => m[1]));
  const readIds = new Set([...js.matchAll(/(?:val|document\.getElementById)\(\s*['"]((?:s|ws)-[\w-]+)['"]/g)].map((m) => m[1]));
  // providerFormFrom 用 `${prefix}-baseurl` 拼 id，把它展开进「已读」名单，否则误报
  const body = js.match(/function providerFormFrom[\s\S]*?\n\}/)?.[0] || '';
  const suffixes = [...body.matchAll(/v\('([\w-]+)'\)/g)].map((m) => m[1]);
  const prefixes = [...js.matchAll(/providerFormFrom\('([\w-]+)'\)/g)].map((m) => m[1]);
  for (const p of prefixes) for (const s of suffixes) readIds.add(`${p}-${s}`);
  const orphan = [...ids].filter((id) => !readIds.has(id)).sort();
  assert.deepEqual(orphan, [], `这些输入框的值从来没被读过：${orphan.join('、')}`);
});
