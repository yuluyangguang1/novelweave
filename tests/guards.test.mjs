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

test('CLI 的 R 编号别名表覆盖每一条已实现规则（--rules R23 不能静默解析成空）', () => {
  // ALIAS 少一条时 resolveRuleNames 直接把它 filter 掉，--rules R22 变成「一条都没选」，
  // 于是使用者拿到一份空报告还以为没问题。别名表必须与规则表逐条对上。
  const src = read('scripts/nw-continuity.mjs');
  const body = src.match(/const ALIAS = \{([\s\S]*?)\n\};/)?.[1] || '';
  const mapped = new Map([...body.matchAll(/(R\d+b?):\s*'([\w-]+)'/g)].map((m) => [m[1], m[2]]));
  const missing = [], wrong = [];
  for (const [slug, rule] of Object.entries(NWRules.RULES)) {
    if (!rule.code) continue;
    if (!mapped.has(rule.code)) missing.push(`${rule.code}→${slug}`);
    else if (mapped.get(rule.code) !== slug) wrong.push(`${rule.code} 指向 ${mapped.get(rule.code)}，应为 ${slug}`);
  }
  assert.deepEqual(missing, [], `这些规则在 CLI 里按编号选不到：${missing.join('、')}`);
  assert.deepEqual(wrong, [], `别名指错了规则：${wrong.join('；')}`);
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

/**
 * planMerge 少要一张表不会报错，只会把那张表的每条记录都判成 new，
 * 于是导入时用文件版静默盖掉本地改动 —— 关系边与决策就是这么丢过的。
 * 比较器在 core、取数在 app.js，两边只靠一份键名对齐，所以拿静态核对钉住。
 */
test('导入比较要的每张表，app.js 都必须真的取出来', () => {
  const project = read('src/core/project.js');
  const body = project.match(/async function planMerge[\s\S]*?\n  \}/)?.[0];
  assert.ok(body, 'project.js 里找不到 planMerge');
  const needed = [...new Set([...body.matchAll(/currentRows\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.ok(needed.length >= 8, `planMerge 的表名单看着不完整：${needed.join('、')}`);

  const app = read('src/app.js');
  const given = app.match(/const current = \{([\s\S]*?)\n  \};/)?.[1] || '';
  const keys = new Set([...given.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
  const missing = needed.filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], `导入时这些表没有取本地值，会被整表判成 new：${missing.join('、')}`);
});

test('侧栏每个 tab 都有渲染函数，能新增的都有处理器', () => {
  // 旧版定义了四个列表函数却从不调用，四个 tab 永远空白；反过来定义了没人调的
  // 视图同样是死代码。两个方向一起查，tab 表才是唯一事实源。
  const js = read('src/app.js');
  const tabs = [...js.matchAll(/\{ id: '([\w-]+)',[^\n]*?hasAdd: (true|false)/g)]
    .map((m) => ({ id: m[1], hasAdd: m[2] === 'true' }));
  assert.ok(tabs.length >= 10, `TABS 只解析出 ${tabs.length} 项，检查匹配式`);
  const views = new Set([...(js.match(/const SIDEBAR_VIEWS = \{([\s\S]*?)\n\};/)?.[1] || '')
    .matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
  const adds = new Set([...(js.match(/const ADD_ACTIONS = \{([\s\S]*?)\n\};/)?.[1] || '')
    .matchAll(/'nav-add-([\w-]+)'/g)].map((m) => m[1]));
  const noView = tabs.filter((t) => !views.has(t.id)).map((t) => t.id);
  const noAdd = tabs.filter((t) => t.hasAdd && !adds.has(t.id)).map((t) => t.id);
  const orphan = [...views].filter((v) => !tabs.some((t) => t.id === v));
  assert.deepEqual(noView, [], '这些 tab 点开是空的');
  assert.deepEqual(noAdd, [], '这些 tab 的 + 按钮点了没反应');
  assert.deepEqual(orphan.sort(), [], '这些视图没有任何 tab 会用到');
});

/**
 * 加载表一共四张：Web 壳、离线缓存、测试加载器、CLI 装配器，每张都手写一遍文件名。
 * 上面那两条静态守卫只覆盖壳（清单与顺序），但 UMD 工厂的实参依赖是**加载期**取的，
 * 四张表各自都要成立 —— 加一条依赖只改壳、漏改 CLI，表现不是报错而是规则拿到
 * undefined 后静默不响。这里按文件里真实存在的 factory(root.NWxxx, …) 反推依赖，
 * 新模块不必回头改测试。
 *
 * 刻意不要求「四张表都有全部模块」：draft.js 只给 CLI 与测试、db.js 与 epub.js 等
 * 只给 Web，那是分工不是疏漏。
 */
function loadLists() {
  const web = [...read('index.html').matchAll(/<script src="(src\/[^"]+\.js)"><\/script>/g)].map((m) => m[1]);
  const precache = read('sw.js').match(/const PRECACHE = \[([\s\S]*?)\n\];/)?.[1] || '';
  const cache = [...precache.matchAll(/'(src\/[^']+\.js)'/g)].map((m) => m[1]);
  const loader = read('tests/_load.mjs');
  const tests = [...loader.matchAll(/require\('\.\.\/(src\/[^']+\.js)'\)/g)].map((m) => m[1]);
  const book = read('scripts/lib/book.mjs');
  const cli = [...book.matchAll(/require\(core\('([^']+\.js)'\)\)/g)].map((m) => `src/core/${m[1]}`);
  return { web, cache, tests, cli };
}

/** 全局名 → 文件：UMD 尾部那行 `else root.NWxxx = mod;` 就是它自报的家门。 */
function globalNames() {
  const map = new Map();
  for (const f of readdirSync(repoPath('src', 'core'))) {
    if (!f.endsWith('.js')) continue;
    const src = read(`src/core/${f}`);
    const g = src.match(/else root\.(\w+) = mod;/)?.[1];
    if (g) map.set(g, `src/core/${f}`);
  }
  return map;
}

/** 工厂实参里出现的 root.NWxxx 就是加载期依赖 —— 它们必须在每张表里先就位。 */
function umdDeps(file, names) {
  const call = read(file).match(/const mod = factory\(([^)]*)\)/)?.[1] || '';
  return [...call.matchAll(/root\.(\w+)/g)].map((m) => m[1]).filter((g) => names.has(g));
}

test('每张加载表里，UMD 依赖都排在用它的模块之前', () => {
  const names = globalNames();
  const lists = loadLists();
  const bad = [];
  for (const [tag, list] of Object.entries(lists)) {
    for (const file of list) {
      if (!existsSync(repoPath(...file.split('/')))) continue;
      for (const g of umdDeps(file, names)) {
        const dep = names.get(g);
        const i = list.indexOf(dep);
        if (i === -1) bad.push(`${tag}: ${file} 要 ${g}，但这一张表根本没加载它`);
        else if (i > list.indexOf(file)) bad.push(`${tag}: ${file} 排在 ${dep} 前面，加载时 ${g} 还是 undefined`);
      }
    }
  }
  assert.deepEqual(bad, [], `加载顺序有问题：\n${bad.join('\n')}`);
});

test('新增离线缓存条目必须同时进壳 —— PRECACHE 与 <script> 是同一份表', () => {
  // 「清单覆盖页面加载的每个文件」那条只查页面向缓存的单向覆盖；反方向（缓存里
  // 多出一个壳不加载的文件）同样会把两份表越拉越远，且没人会察觉。
  const { web, cache } = loadLists();
  assert.ok(web.length >= 15 && cache.length >= 15, `解析出的条数太少：${web.length}/${cache.length}`);
  assert.deepEqual(cache, web, 'sw.js 的 PRECACHE 与壳的 <script> 表对不上');
});

test('src/core 下没有孤儿模块，也没有表里写着不存在的文件', () => {
  const lists = loadLists();
  const every = new Set([...lists.web, ...lists.cache, ...lists.tests, ...lists.cli]);
  const onDisk = readdirSync(repoPath('src', 'core')).filter((f) => f.endsWith('.js')).map((f) => `src/core/${f}`);
  // Web 与 CLI 各自要能独立跑完，所以「只出现在测试加载器里」也算孤儿
  const reachable = new Set([...lists.web, ...lists.cli]);
  const stranded = onDisk.filter((f) => !reachable.has(f));
  const ghost = [...every].filter((f) => f.startsWith('src/core/') && !onDisk.includes(f));
  assert.deepEqual(stranded.sort(), [], '这些模块只有测试能加载，Web 与 CLI 都跑不到：' + stranded.join('、'));
  assert.deepEqual(ghost.sort(), [], '这些表引用了不存在的 core 文件：' + ghost.join('、'));
});

test('信息差表单的每个控件都要被 readSecretForm 读走', () => {
  // 这一族的字段比关系页多（三个章节选择器 + 多选 + 停用开关），
  // 漏读一个字段等于作者填了但从来不落库，而且不会有任何报错。
  const js = read('src/app.js');
  const form = js.match(/function secretFields\([\s\S]*?\n\}/)?.[0] || '';
  const write = js.match(/function readSecretForm\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(form && write, 'app.js 里找不到信息差表单的两个函数');
  const ids = [...new Set([...form.matchAll(/\$\{prefix\}-([\w-]+)/g)].map((m) => m[1]))];
  assert.ok(ids.length >= 8, `只解析出 ${ids.length} 个控件，检查匹配式`);
  // 只看 return 之后：光在函数里 getElementById 一下又不用它，等于没读
  const afterReturn = write.slice(write.indexOf('return {'));
  const missing = ids.filter((k) => !afterReturn.includes(k));
  assert.deepEqual(missing, [], `这些控件的值从来没被读走：${missing.join('、')}`);
});

/**
 * 文体面板是「作者能改包」这一条承诺的全部实现，而它横跨四个文件：
 * 表单在 app.js、键名规则在 stylepack.js 的 optsFrom、过桥在 story.js 的 buildCtx。
 * 每一处都是字符串级的对接，改错一边不报错，只是作者在界面上勾的东西不再起作用。
 */
test('文体规则面板：控件全被读走，存进库的键与包认的键一模一样', () => {
  const js = read('src/app.js');
  const form = js.match(/function stylePackFields\([\s\S]*?\n\}/)?.[0] || '';
  const reader = js.match(/function readStylePackForm\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(form && reader, 'app.js 里找不到文体面板的两个函数');
  const ids = [...new Set([...form.matchAll(/\$\{prefix\}-([\w-]+)/g)].map((m) => m[1]))];
  assert.ok(ids.length >= 3, `只解析出 ${ids.length} 个控件，检查匹配式`);
  const orphan = ids.filter((k) => !reader.includes(`-${k}`));
  assert.deepEqual(orphan, [], `这些控件的值从来没被读走：${orphan.join('、')}`);
  // 开关必须是逐组生成的：往 GROUPS 里加一组却漏了面板，表现是那一组永远关不掉
  assert.match(form, /NWStylePack\.GROUPS\.map/, '词组开关不是从 GROUPS 生成的，加一组就会漏一个');

  const pack = read('src/core/stylepack.js');
  const optsBody = pack.match(/function optsFrom\([\s\S]*?\n\}/)?.[0] || '';
  const known = new Set([...optsBody.matchAll(/sp\.(\w+)/g)].map((m) => m[1]));
  assert.ok(known.size >= 3, `optsFrom 只解析出 ${known.size} 个键，检查匹配式`);
  const saved = new Set([...reader.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]));
  assert.deepEqual([...saved].filter((k) => !known.has(k)).sort(), [], '面板存了包不认的键，落库也没人读');
  assert.deepEqual([...known].filter((k) => !saved.has(k)).sort(), [], '这些包开关作者在界面上改不了');

  // 面板写的是 novel.stylePack，buildCtx 读的也是这个名字 —— 拼错是静默失效
  assert.match(js, /update\(APP\.novel\.id, \{ stylePack \}\)/, '保存按钮没把表单写进 novel.stylePack');
  assert.match(read('src/core/story.js'), /rows\.novel\.stylePack/, 'buildCtx 没把 stylePack 过桥给 R22 与生成 prompt');
});

/**
 * R28（毁灭后还点名）与 R30（建档却从没点名）问的是同一件事的两面，
 * 所以「一条设定在正文里可能被怎么叫」必须只有一个出处。分家过的两次都在别人身上见过：
 * 一边认副键一边不认，表现是一条规则判它活着、另一条判它从没出现过。
 */
test('守卫：世界条目的称呼集只有一处手写，R28/R30 都调 worldForms', () => {
  const js = read('src/core/rules.js');
  assert.match(js, /const terms = worldForms\(w\);/, 'R28 又自己拼了一份称呼集');
  assert.match(js, /const forms = worldForms\(w\);/, 'R30 又自己拼了一份称呼集');
  assert.equal([...js.matchAll(/\[w\.name, \.\.\.\(w\.keys \|\| \[\]\)/g)].length, 1,
    '称呼集的构造只许出现在 worldForms 里，出现第二处就说明两条规则又分家了');
});

/**
 * 世界设定的触发词/副键/销毁章曾经只有 CLI 写得出来：R28、R30 与两层召回全读这几格，
 * 界面上却既填不进也看不见。表单补齐之后，这条守卫负责让「填不进」不再悄悄回来 ——
 * 设置页那条守卫只盯 s-/ws- 前缀，这里这种 m-wb-* / e-wb-* 是它的盲区。
 */
test('世界设定表单：每个控件都有人读，读回来的键 db 落库、导出带得走', () => {
  const js = read('src/app.js');
  const form = js.match(/function worldFields\([\s\S]*?\n\}/)?.[0] || '';
  const reader = js.match(/function readWorldForm\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(form && reader, 'app.js 里找不到世界表单或它的读取器');
  const ids = [...new Set([...form.matchAll(/\$\{prefix\}-([\w-]+)/g)].map((m) => m[1]))];
  assert.deepEqual(ids.filter((k) => !reader.includes(`-${k}`)), [],
    `这些控件的值从来没被读走：${ids.filter((k) => !reader.includes(`-${k}`)).join('、')}`);
  // 新建与编辑必须共用同一个读取器：两份读取器迟早有一份漏字段
  assert.match(js, /NovelDB\.worldbuilding\.create\(APP\.novel\.id, data\)/, '新建没走 readWorldForm 的 data');
  assert.match(js, /NovelDB\.worldbuilding\.update\(id, data\)/, '编辑没走 readWorldForm 的 data');

  const store = read('src/core/db.js').match(/async function createWorldbuilding\([\s\S]*?\n\}/)?.[0] || '';
  const saved = [...reader.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  assert.ok(saved.includes('keys') && saved.includes('secondary_keys') && saved.includes('selective')
    && saved.includes('lifecycle'), `读取器没产出这几格：${saved.join('、')}`);
  for (const k of ['keys', 'secondary_keys', 'selective', 'lifecycle']) {
    assert.ok(store.includes(`${k}:`), `createWorldbuilding 不落 ${k}，界面上填了也只活到本次会话`);
  }
  // 这几格的名字必须与规则/导出认的字段名一字不差（story.js 的 toWorld 是过桥处）
  const story = read('src/core/story.js');
  const toWorld = story.match(/function toWorld\([\s\S]*?\n\}/)?.[0] || '';
  for (const k of ['keys', 'secondary_keys', 'selective', 'lifecycle', 'content']) {
    assert.ok(toWorld.includes(k), `toWorld 不认 ${k}，界面上的这一格进不了文件也进不了规则`);
  }
  // 称呼表的解析器只许有一把：角色别名与世界触发词分开写，分隔法迟早两边不一样
  assert.equal([...js.matchAll(/split\(\/、,，\//g)].length, 0,
    '又手写了一份顿号/逗号切分，应该调 splitTerms');
  assert.match(js, /splitTerms\(val\(`\$\{prefix\}-aliases`\)\)/, '角色别名不再用 splitTerms，两把尺要分家了');
  // 填得进还得看得见：列表卡片必须调用摘要函数（摘要本身的内容在下一条里按行为验）。
  // 注意锚点要带模板插值的壳 —— 只写 worldNote(w, deadChapters) 会连函数定义那行一起匹配上。
  assert.match(js, /\$\{esc\(worldNote\(w, deadChapters\)\)\}/, '设定列表不再显示这几格，作者只能相信自己刚填的那一次');
});

test('R29「照正文改」：按钮只在机器给出建议章时出现，且有处理器', () => {
  const js = read('src/app.js');
  assert.match(js, /data-action="fix-first"/, '诊断卡上没有一键改 first 的按钮');
  assert.match(js, /^\s+'fix-first':\s*\(id, el\) =>/m, 'fix-first 没注册进 ACTIONS，点了静默不动');
  assert.match(js, /NovelDB\.characters\.update\(entityId, \{ first: chapterId \}\)/,
    '处理器没把章 id 写进角色卡的 first');
  // 按钮的数据源必须是规则给出的那一章，不能是「当前诊断指向的那一章」——后者在 first 写早了那支是登记章
  const rules = read('src/core/rules.js');
  assert.match(rules, /suggestFirst: late \? actual\.chapter : null/,
    'R29 不再只给「写晚了」那一支提供可写回目标，按钮会去掩盖「那一章没点名」这个问题');
  assert.match(js, /d\.rule === 'first-appearance-mismatch' \? \(d\.evidence\?\.suggestFirst \|\| ''\)/,
    '按钮的显示条件不再只看 suggestFirst，可能把别的规则的字段当章号用');
});

/**
 * 上一节那条守卫只查「控件有没有被读」，查不出「用什么读」写错。
 * 真出过的事：读取器里调 checked(...)，而 checked 只是文体规则面板里的一个局部 const ——
 * 静态看它在文件里确实「有声明」，浏览器里点保存才炸，且弹窗把异常吞了、界面上毫无症状。
 * 所以这里把读取链真的跑一遍：从 app.js 抠出这几段源码，在假 DOM 下调用，键名与值都核对。
 */
test('世界设定读取链在假 DOM 下真跑得通（助手名写错=点保存静默失败）', () => {
  const js = read('src/app.js');
  const parts = {
    val: js.match(/\nfunction val\(id\) \{[\s\S]*?\n\}/)?.[0],
    isChecked: js.match(/\nconst isChecked = [^\n]*/)?.[0],
    splitTerms: js.match(/\nconst splitTerms = [^\n]*/)?.[0],
    readWorldForm: js.match(/\nfunction readWorldForm\([\s\S]*?\n\}/)?.[0],
  };
  for (const [k, src] of Object.entries(parts)) {
    assert.ok(src, `app.js 里抠不出 ${k}，读取链测试的形状变了，改测试也改这里`);
  }
  const fields = {
    'm-wb-type': { value: 'faction' },
    'm-wb-name': { value: '  青冥山 ' },
    'm-wb-desc': { value: '终年大雾。' },
    'm-wb-keys': { value: '青冥、北宗故地,青雾' },
    'm-wb-secondary': { value: '祭石' },
    'm-wb-selective': { checked: true },
    'm-wb-dead': { value: 'ch-002' },
  };
  const run = (lifecycle) => new Function('document',
    `${Object.values(parts).join('\n')} return readWorldForm('m', ${JSON.stringify(lifecycle)});`)({
      getElementById: (id) => fields[id] ?? null,
    });
  assert.deepEqual(run({ 'revealed-in': 'ch-001', 'destroyed-in': '旧值' }), {
    type: 'faction',
    name: '青冥山',
    description: '终年大雾。',
    keys: ['青冥', '北宗故地', '青雾'],
    secondary_keys: ['祭石'],
    selective: true,
    lifecycle: { 'revealed-in': 'ch-001', 'destroyed-in': 'ch-002' },
  }, '界面上填的这几格没有原样读出来');
  // 空销毁章必须写成 null，不能留 ''：CLI 与 R28 都按 null 判「没毁」
  for (const k of Object.keys(fields)) delete fields[k];
  fields['m-wb-name'] = { value: '甲' };
  assert.deepEqual(run({}), {
    type: 'location', name: '甲', description: '', keys: [], secondary_keys: [],
    selective: false, lifecycle: { 'destroyed-in': null },
  }, '清空表单时读出来的值不对');

  // 读回来还要看得见：卡片摘要的三段各对应表单里的一格，缺一格等于那格白填
  const noteSrc = js.match(/\nfunction worldNote\([\s\S]*?\n\}/)?.[0];
  assert.ok(noteSrc, 'app.js 里抠不出 worldNote');
  const renderNote = (w, deadEntries) => new Function('dead',
    `${noteSrc} return worldNote(${JSON.stringify(w)}, new Map(dead));`)(deadEntries);
  assert.equal(renderNote({
    keys: ['青冥', '北宗故地'], secondary_keys: ['祭石', '故地'], selective: true,
    lifecycle: { 'destroyed-in': 'ch-003' },
  }, [['ch-003', 3]]), '[触发 2 词 · 副键 2·需同中 · 毁于第3章] ');
  assert.equal(renderNote({ keys: [], lifecycle: {} }, []), '',
    '什么都没填的设定不该顶着一空括号');
  assert.equal(renderNote({ keys: ['甲'], lifecycle: { 'destroyed-in': 'ch-999' } }, []),
    '[触发 1 词 · 毁于（章已删）] ', '销毁章被删了要看得见，而不是静默当成没毁');
});

/**
 * 上一条守卫查的是「渲染了没人读」，方向反过来才是更致命的那一半：
 * 读了一个页面里根本不存在的 id。表现不是报错就是静默 —— 起书向导里的
 * `inp-ai-platform` 从 fa8e6a4 那天起就没有渲染点，于是「目标平台」这一格
 * 从来没存在过，target_words 恒为 null，字数达标进度条永远不出现，
 * 而全量测试一直是绿的。
 *
 * 认三种渲染点：静态 `id="x"`、脚本里 `el.id = 'x'`（遮罩与 toast）、
 * 以及模板拼出来的 `id="${prefix}-tail"`（读到 m-note-title 时按尾巴 -note-title 认）。
 * 按尾巴认意味着前缀写错不会被抓到 —— 这条守卫只保证「这个控件至少有人画」，
 * 前缀对不对得上归浏览器真跑管。
 */
test('界面读到的每个控件 id 都必须真的有渲染点 —— 读到 null 就是点了没反应', () => {
  const src = read('src/app.js') + '\n' + read('index.html');

  const readIds = new Set();
  for (const m of src.matchAll(/(?:\bval|\bisChecked|document\.getElementById)\(\s*['"]([\w-]+)['"]/g)) {
    // `'x-' + id` 那种拼接：字面量只是前缀，整 id 拼出来才知道，跳过
    if (/['"]\s*\+/.test(src.slice(m.index + m[0].length - 1, m.index + m[0].length + 6))) continue;
    readIds.add(m[1]);
  }
  assert.ok(readIds.size > 50, `只解析出 ${readIds.size} 个读取点，检查匹配式`);

  const rendered = new Set([...src.matchAll(/id="([^"$]+)"/g)].map((m) => m[1]));
  for (const m of src.matchAll(/\.id\s*=\s*['"]([\w-]+)['"]/g)) rendered.add(m[1]);
  const tails = new Set([...src.matchAll(/id="\$\{[^}]+\}([-\w]+)"/g)].map((m) => m[1]));
  // `id="rev-body-${…}"` 这种「静态前缀 + 动态尾巴」：读的时候也是拼接，按前缀认
  const heads = new Set([...src.matchAll(/id="([-\w]+)-?\$\{/g)].flatMap((m) => [m[1], `${m[1]}-`]));

  const missing = [...readIds].filter((id) => {
    if (rendered.has(id) || heads.has(id)) return false;
    const seg = id.indexOf('-');
    return !(seg > 0 && tails.has(id.slice(seg)));
  }).sort();
  assert.deepEqual(missing, [], `这些 id 有人读、没人画：${missing.join('、')}`);
});

/**
 * 第二个坑同样是浏览器才看得见：closeModal() 把 .modal-overlay 整块摘掉，
 * 之后 `document.getElementById('inp-ai-genre').value` 就是读 null 的属性 ——
 * 抛错发生在 async 处理器里被吞掉，用户看到的是「生成完弹窗一关，啥也没发生」。
 * 两个起书向导都这么写过。只查「紧跟一行」这一种形状（那正是出事时的形状）：
 * 再往后的行分不清是不是同一个函数体，硬查会误报。
 */
test('closeModal 之后紧跟着一行读弹窗控件 = 读到的是 null', () => {
  const lines = read('src/app.js').split(/\r?\n/);
  const bad = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/closeModal\(\);/.test(lines[i])) continue;
    const next = lines[i + 1];
    const m = next.match(/(?:\bval|document\.getElementById)\(\s*['"](inp-[\w-]*|[me]-[\w-]*)['"]/);
    if (m) bad.push(`${m[1]}（第 ${i + 2} 行）`);
  }
  assert.deepEqual(bad, [], `这些值在弹窗拆掉之后才读，拿到的是 null：${bad.join('、')}`);
});

/**
 * 平台字数 → 篇幅档那条对应关系，原先是 app.js 里手抄的两个阈值，
 * 而它上面那行注释写着「2 万→标准」、代码走的却是「2 万→大短篇」。
 * 阈值收进 NovelLLM.platformTierIndex 之后，这里钉住界面确实走它。
 */
test('篇幅档阈值不许在界面里再抄一份', () => {
  const js = read('src/app.js');
  assert.match(js, /NovelLLM\.platformTierIndex\(/, '平台联动篇幅档要调那个唯一的出处');
  assert.doesNotMatch(js, /words\s*<=\s*\d+/, '界面里抄了阈值数字，就会和 llm.js 那份各说各话');
});

/**
 * 导入时那行 novels 记录以前是在界面层手拼字面量拼出来的：其余每张表都走 core 里的
 * from*（有测试盯着），只有这本书没有，所以 format / target_words 漏在桥上是全绿的。
 * 这里钉住「翻译只有一份、且在 core 里」。
 */
test('文件 → 库行的翻译只许有 core 里那一份，界面不许再拼一遍', () => {
  const app = read('src/app.js');
  const project = read('src/core/project.js');
  assert.match(project, /book:\s*Story\.fromBook\(/, 'parseFileMap 交回的是文件记录而不是库行');
  assert.match(app, /\.\.\.parsed\.book/, '导入建档没吃 parseFileMap 的库行，是自己另拼了一份');
  assert.doesNotMatch(app, /format:\s*parsed\.book\.format/, '界面层自己翻译 format：core 那份一改它就静默落后');
});

