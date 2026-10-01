import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { repoPath, repoRoot, NWRules, NovelDB, NWStyleFit, NWContext, NWStateScope, NWStory, NWText, NWTension, NWPitch, NWVolume, NWRelationGraph } from './_load.mjs';

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

/**
 * 反验时撞出来的洞：把 rules.md 里的 R32 改成 RXX、把 SKILL.md 路由表里的 nw-style.mjs 改成
 * nw-styleX.mjs，全量测试一声不响 —— 因为此前没有任何一条测试读 skills/。
 * 文档是 agent 唯一的入口：编号点错、脚本名点错，那条能力对它就不存在，
 * 而作者看到的是一句「按文档做了却没反应」。
 */
test('技能文档点名的规则编号、脚本与参考文件必须对得上', () => {
  const known = new Set(Object.values(NWRules.RULES).map((r) => r.code).filter(Boolean));
  const scripts = new Set(readdirSync(repoPath('scripts')).filter((f) => f.endsWith('.mjs')));
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(repoPath(dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.md')) files.push(rel);
    }
  })('skills');
  assert.ok(files.length >= 6, `只找到 ${files.length} 份技能文档，八成是遍历写错了`);
  const badCode = [], badScript = [], badRef = [];
  for (const f of files) {
    const md = read(f);
    const skillDir = f.split('/').slice(0, -1).join('/');   // skills/<skill>/xxx.md
    for (const m of md.matchAll(/\bR\d+\b/g)) {
      if (!known.has(m[0])) badCode.push(`${f} 点了 ${m[0]}`);
    }
    for (const m of md.matchAll(/nw-[\w-]+\.mjs/g)) {
      if (!scripts.has(m[0])) badScript.push(`${f} 点了 ${m[0]}`);
    }
    for (const m of md.matchAll(/references\/([\w.-]+\.md)/g)) {
      // 参考文件与点它的那份文档在同一个技能目录下，所以按各自技能目录查
      const here = existsSync(repoPath(...skillDir.split('/'), 'references', m[1]));
      const sibling = files.some((g) => g !== f && g.startsWith('skills/')
        && g.endsWith(`/references/${m[1]}`));
      if (!here && !sibling) badRef.push(`${f} 点了 references/${m[1]}`);
    }
  }
  assert.deepEqual(badCode, [], `文档里点到不存在的规则编号：${badCode.join('；')}`);
  assert.deepEqual(badScript, [], `文档里点到不存在的脚本：${badScript.join('；')}`);
  assert.deepEqual(badRef, [], `文档里点到不存在的参考文件：${badRef.join('；')}`);
  // 反方向：每条已实现的规则都得在 rules.md 里有那一节。
  // 上面那三条只查「文档点到的东西存在」，把 R32 那一节整个改名成 RXX 反而全绿 —— 反验时就是绿的。
  const doc = read('skills/novelweave-continuity/references/rules.md');
  const missing = Object.entries(NWRules.RULES)
    .filter(([slug, r]) => r.code && !doc.includes(`${r.code} \`${slug}\``))
    .map(([slug, r]) => `${r.code} ${slug}`);
  assert.deepEqual(missing, [], `rules.md 里缺了这些小节：${missing.join('、')}`);
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

  // 面板写的是 novel.stylePack 与 novel.styleAnchor，buildCtx 读的也是这两个名字 —— 拼错是静默失效
  assert.match(js, /update\(APP\.novel\.id, \{ stylePack, styleAnchor \}\)/, '保存按钮没把两份表单写进 novel 行');
  assert.match(read('src/core/story.js'), /rows\.novel\.stylePack/, 'buildCtx 没把 stylePack 过桥给 R22 与生成 prompt');
  assert.match(read('src/core/story.js'), /rows\.novel\.styleAnchor/, 'buildCtx 没把 styleAnchor 过桥给 R32 与样例选择');
});

/**
 * 基准章这一格的两个消费方（生成时选样例的 NWContext.stylePool、检查器 R32）
 * 都不在界面里，界面上勾错一个名字不会有任何报错，只会让作者以为自己勾过了。
 * 所以这几条静态核对一起做：面板有画、有人读、写进库的名字与 core 读的名字一致，
 * 而「哪几章够格」这个门槛必须只有一个出处。
 */
test('文体面板的基准章：画了有人读，读回来的键 core 认，合格门槛不抄第二份', () => {
  const js = read('src/app.js');
  const form = js.match(/function styleAnchorFields\([\s\S]*?\n\}/)?.[0] || '';
  const reader = js.match(/function readStyleAnchorForm\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(form && reader, 'app.js 里找不到基准章表单或它的读取器');
  // 定义了不等于画出来了：删掉模板里的渲染点，函数体守卫照样全绿，只有语法解析那条泛红（删了 ${…} 打断模板）。
  assert.match(js, /\$\{styleAnchorFields\('sty', ctx\)\}/, '基准章表单没被渲染进文体面板');
  // 容器 id 两边必须同一个拼法：画成 ${prefix}-p-anchor、读成 'sty-p-anchor'，前缀写错就是读到 null
  const box = form.match(/id="\$\{prefix\}-([\w-]+)"/)?.[1];
  assert.ok(box, '基准章列表没有容器 id');
  assert.ok(reader.includes('getElementById(`${prefix}-' + box + '`)'), `读取器没读 ${box} 这个容器`);
  assert.match(form, /value="\$\{attr\(c\.id\)\}"/, '章 id 没走 attr，属性会被半角引号突破');
  assert.match(form, /disabled/, '正文不够长的章必须画成禁用，勾了也不进指纹');

  // 那一行数字得跟着勾态当场动：勾了一章而屏上还写着「2 章 / 1760 字」，作者就用旧尺子理解新基准
  assert.match(form, /data-action="style-anchor-preview"/, '基准章容器没有预览动作，改了勾态数字不动');
  assert.match(js, /'style-anchor-preview': \(\) => refreshStyleAnchorFit\('sty'\)/, '预览动作没人接，点 checkbox 毫无反应');
  const preview = js.match(/function refreshStyleAnchorFit\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(preview, 'app.js 里没有当场重算那行的函数');
  assert.match(form, /id="\$\{prefix\}-p-fit"/, '指纹那一行没有可替换的容器');
  assert.ok(preview.includes('getElementById(`${prefix}-p-fit`)'), '重算没写回那个容器');
  assert.ok(preview.includes('getElementById(`${prefix}-p-anchor`)'), '重算没读作者眼前勾着的那几章');
  assert.match(preview, /NWStyleFit\.fingerprint\(/, '重算另起了一套算法，面板与检查器就会分家');
  assert.match(js, /APP\.styleCtx = ctx/, '面板没把手里的 ctx 存下来，重算时拿不到正文');
  assert.doesNotMatch(form, /改勾态按「保存」后才会重算/, '界面还写着「按保存才重算」，与当场重算的行为对不上');

  // 保存 → 库 → 过桥 → 导出白名单，四段都得认这个名字
  assert.match(js, /NovelDB\.novels\.update\(APP\.novel\.id, \{ stylePack, styleAnchor \}\)/);
  assert.match(js, /readStyleAnchorForm\('sty'\)/, 'styleAnchor 没人从表单读，勾态进不了库');
  const project = read('src/core/project.js');
  assert.match(project, /styleAnchor: ctx\.book\.styleAnchor \|\| null/, '导出的 book.json 不带基准章');
  assert.match(project, /'styleAnchor'/, 'styleAnchor 不在导出白名单里，导出目录里根本没有这一格');

  // 门槛的出处：判「够不够长」这件事只有 stylefit 那一份，面板与 core 都只调 qualifies，
  // 谁都不许自己比一个长度 —— 更要紧的是口径：它必须与界面那个「N 字」同一个数法。
  assert.match(form, /NWStyleFit\.qualifies\(/, '面板自己判「够不够长」，与指纹的门槛会分家');
  assert.doesNotMatch(form, /(?:length|长度)\s*[<>]=?\s*\d/, '面板里出现了第二个长度门槛');
  assert.doesNotMatch(form, /MIN_BODY/, '面板又开始自己拿门槛数值比了');
  assert.match(read('src/core/context.js'), /StyleFit\.qualifies\(/, '选样例的门槛不再问 stylefit 要那一份判据');
  const fitSrc = read('src/core/stylefit.js');
  assert.match(fitSrc, /function qualifies\(body\)/, '「够不够长」的判据不在 stylefit 里，四处就各判各的');
  assert.match(fitSrc, /function qualifies\(body\)[\s\S]{0,200}?T\.countWords\(s\)[\s\S]{0,40}?>= MIN_BODY/,
    '够不够长改回按字符数判：界面写着「480 字」却允许勾，规则话术里的「600 字」就是假话');
  assert.doesNotMatch(fitSrc, /trim\(\)\.length >= MIN_BODY/, '指纹入口还留着一份按字符数的第二门槛');

  // 数字必须与检查器同源：面板与 R32 都调 NWStyleFit，界面不许自己拼四格
  assert.match(form, /NWStyleFit\.fingerprint\(/, '面板的基准指纹不是 core 那个函数算的');
  assert.match(form, /NWStyleFit\.lines\(/, '面板没把指纹念成那一行，作者看不见基准到底是几个数');
  assert.match(form, /NWContext\.styleOpts\(ctx\.book\)/, '算基准指纹没带作者自己的包，关掉的词组还会算进密度');

  // 「先只勾最早那一章」是给老书回填用的：没有处理器就是点了静默不动
  assert.match(js, /data-action="style-anchor-first"/, '没有回填基准的入口，建了三章才想起要勾的人只能一眼看一章');
  assert.match(js, /^\s+'style-anchor-first':\s*\(\) =>/m, 'style-anchor-first 没注册进 ACTIONS');
});

/**
 * 上一条守卫还是字符串级的，抓不出「读的方式写错」。基准章这一格尤其脆：
 * 容器 id 与选择器都是拼出来的，错一点就是作者勾了三章、库里存了空数组，
 * 而 R32 与生成样例都按「没勾过」静默退回就近取样 —— 表现是「我明明勾了」。
 * 所以这里把读取链与回填按钮的处理器都在假 DOM 下真跑一遍。
 */
test('基准章读取链与回填按钮在假 DOM 下真跑得通', () => {
  const js = read('src/app.js');
  const readerSrc = js.match(/\nfunction readStyleAnchorForm\([\s\S]*?\n\}/)?.[0];
  const fitSrc = js.match(/\nfunction refreshStyleAnchorFit\([\s\S]*?\n\}/)?.[0];
  const clickSrc = js.match(/\n\s+'style-anchor-first': \(\) => \{[\s\S]*?\n {2}\},/)?.[0];
  assert.ok(readerSrc, 'app.js 里抠不出 readStyleAnchorForm，读取链测试的形状变了，改测试也改这里');
  assert.ok(fitSrc, 'app.js 里抠不出 refreshStyleAnchorFit，回填后的重算没走真函数');
  assert.ok(clickSrc, 'app.js 里抠不出 style-anchor-first 的函数体');

  const box = (items) => ({ querySelectorAll: () => items });
  const runReader = (items, id = 'sty-p-anchor') => new Function('document',
    `${readerSrc} return readStyleAnchorForm('sty');`)({
    getElementById: (key) => (key === id ? box(items) : null),
  });
  const c = (value, checked, disabled) => ({ value, checked: !!checked, disabled: !!disabled });

  assert.deepEqual(runReader([c('ch-001', true), c('ch-002'), c('ch-003', true)]),
    { chapterIds: ['ch-001', 'ch-003'] }, '勾着的章没有原样交回库里');
  assert.deepEqual(runReader([c('ch-001'), c('ch-002')]), { chapterIds: [] }, '一章都没勾时要给空数组，不是 null');
  // 正文后来变短的章：画成 disabled 却仍带着作者原来的勾，一次保存不该把他的选择抹掉
  assert.deepEqual(runReader([c('ch-001', true, true), c('ch-002')]),
    { chapterIds: ['ch-001'] }, 'disabled+checked 的历史勾态被静默清空了');

  // 指纹行跑真函数：面板上那句「几章几字」是作者唯一的尺子，回填后它不跟着变就是拿旧尺子量新基准。
  const long = '他往前走，山很静，风也从很远的地方赶过来。'.repeat(40);
  const body = clickSrc.match(/'style-anchor-first': \(\) => \{([\s\S]*?)\n {2}\},/)?.[1];
  assert.ok(body, 'style-anchor-first 的函数体抠不出来，改形状请同时改这里');
  const fire = (items, id = 'sty-p-anchor', fitText = '【基准指纹】2 章 / 1800 字的实测值') => {
    const said = [];
    const fit = { textContent: fitText };
    new Function('document', 'showToast', 'APP', 'NWStyleFit', 'NWContext',
      `${fitSrc}\n${body}`)(
      { getElementById: (key) => (key === id ? box(items) : key === 'sty-p-fit' ? fit : null) },
      (m) => said.push(m),
      { styleCtx: { book: {}, chapters: [
        { id: 'ch-002', number: 2, title: '夜行', body: long },
        { id: 'ch-003', number: 3, title: '下山', body: long },
      ] } },
      NWStyleFit, NWContext);
    return { said, fit };
  };
  const list = [c('ch-001', false, true), c('ch-002', true), c('ch-003', true)];
  const first = fire(list);
  assert.deepEqual(first.said, ['已只勾上最早那一章，按「保存」生效']);
  assert.deepEqual(list.map((x) => x.checked), [false, true, false],
    '回填要清掉旧勾、只留最早那一条正文够长的章，不然它只是又加一个勾');
  assert.match(first.fit.textContent, /^【基准指纹】1 章 /,
    '勾已经只剩一章，那一行还写着两章的旧数字 —— 界面在谎报基准的范围');
  assert.doesNotMatch(first.fit.textContent, /1800 字/, '指纹行还是点进去时那份，没按新勾态重算');
  assert.deepEqual(fire([c('ch-001', false, true), c('ch-002', false, true)]).said,
    ['还没有正文够长的章节可当基准，先写一章再勾'], '全是短章时要说人话，不是默默什么都不发生');
  assert.deepEqual(fire([c('ch-001')], '别的页').said, ['先进入文体规则页'],
    '容器不在 DOM 里时不许抛异常');
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


/**
 * 选题评分卡横跨四处：判据在 core、界面上那张卡、CLI 那张卡、确认弹窗的解析。
 * 每一处只要自己另算一份（阈值、词表、或那四个控件的解析），
 * 表现就是「界面说 12 分、命令行说 9 分」，而且两边各自的测试都是绿的。
 */
test('评分卡：分数只从 core 那一份来，界面与 CLI 都不抄阈值、不抄词表', () => {
  const app = read('src/app.js');
  const cli = read('scripts/nw-pitch.mjs');
  assert.match(app, /NWPitch\.scorePitch\(/, '界面自己算分 = 第二份判据');
  assert.match(cli, /NWPitch\.scorePitch\(/, 'CLI 同理');
  assert.match(cli, /NWPitch\.renderLines\(/, '人读的那份文字必须与 JSON 同源');
  // 阈值与词表抄一份就会各说各话
  assert.doesNotMatch(app, /退婚|赘婿|开局签到/, '套路词表进了界面就有第二份');
  assert.doesNotMatch(cli, /0\.85|0\.6\b|1200|4000/, 'CLI 里出现阈值数字，说明它没走 core');
  assert.doesNotMatch(app, /选题评分 \$\{[^}]*\/12/, '满分数字写死在界面里，core 改档位界面不会跟着变');
});

test('评分卡那张弹窗：重新评分按钮有处理器，弹窗控件的解析只有一份', () => {
  const js = read('src/app.js');
  assert.match(js, /id="pitch-recalc"/, '按钮没渲染就是点了没反应');
  assert.match(js, /querySelector\('#pitch-recalc'\)\.onclick\s*=/, '渲染了但没人挂处理器');
  assert.match(js, /function wirePitchCard\(/, '两个向导各挂一遍接线，必有一份落后');
  assert.ok((js.match(/wirePitchCard\(/g) || []).length >= 3, '两个向导都要挂上这张卡');
  assert.match(js, /function readConceptForm\(/);
  // 保存处理器一旦绕过 readConceptForm 自己再解析一遍，「评分看的」与「建档存的」就不是同一份内容
  assert.doesNotMatch(js, /getElementById\(('inp-c-[a-z]+'|id)\)\.value/, '弹窗控件被解析了两遍');
  assert.match(js, /await showConceptConfirm\(/, '确认弹窗要读库做对照，不 await 就是异常被弹窗吞掉那种死法');
  assert.match(js, /await showLongConceptConfirm\(/);
});

/**
 * 弹窗那六格在假 DOM 下真读一遍。长篇向导的人物那一格原先被切了两遍
 * （parseLines 已按 | 拆过，又拿拆出来的名字去拆 role/personality），
 * 于是主角与性格从来进不了库、且一声不响 —— 静态守卫看不见这种 bug，只有真跑才看得见。
 */
test('确认弹窗六格在假 DOM 下读回来的就是作者填的（人物定位与性格不许丢）', () => {
  const js = read('src/app.js');
  const valSrc = js.match(/\nfunction val\(id\) \{[\s\S]*?\n\}/)?.[0];
  const reader = js.match(/\nfunction readConceptForm\([\s\S]*?\n\}/)?.[0];
  assert.ok(valSrc && reader, 'app.js 里抠不出 val / readConceptForm');
  const fields = {
    'inp-c-title': { value: ' 归途 ' },
    'inp-c-logline': { value: '他必须赶在末班车前把信送到，可只剩一站了' },
    'inp-c-chars': { value: '陈默|主角|沉默，认死理\n红衣女|反派|一直在笑\n|主角|没名字的算他不存在' },
    'inp-c-world': { value: '4号线|每晚 23:47 发车\n|空名字不要' },
    'inp-c-vols': { value: '第一卷|进城，认出凶手|但凶手也在找他' },
    'inp-c-chapters': { value: '首班车|陈默数乘客，发现多了一个？\n|只有拍点没有标题\n|  ' },
  };
  const read_ = () => new Function('document', `${valSrc}\n${reader} return readConceptForm();`)({
    getElementById: (id) => fields[id] ?? null,
  });
  const got = read_();
  assert.equal(got.title, '归途');
  assert.deepEqual(got.characters, [
    { name: '陈默', role: '主角', personality: '沉默，认死理' },
    { name: '红衣女', role: '反派', personality: '一直在笑' },
  ], '人物三格必须原样读出来，空名字的丢掉');
  assert.deepEqual(got.volumes, [{ title: '第一卷', summary: '进城，认出凶手|但凶手也在找他' }], '拍点里剩下的竖线不许被吃掉');
  assert.deepEqual(got.world, [{ name: '4号线', content: '每晚 23:47 发车' }]);
  assert.deepEqual(got.chapters.map((c) => c.title), ['首班车', '第2章', '第3章'], '空标题按第 N 章补，行本身不能丢');
  assert.deepEqual(got.chapters.map((c) => c.beat), ['陈默数乘客，发现多了一个？', '只有拍点没有标题', '']);
  // 短篇弹窗没有世界/卷纲这两格：读不到控件就是空数组，不能抛
  delete fields['inp-c-world'];
  delete fields['inp-c-vols'];
  assert.deepEqual(read_().world, []);
  assert.deepEqual(read_().volumes, []);
});

/**
 * nw-style.mjs 是文风指纹的第四个消费方（另三个：注入 prompt 的那一行、文体面板、R32）。
 * 它一旦自己抄一份门槛、自己判「哪几章不评」、自己另挑一遍样例，
 * 表现就是同一本书在三处给两个答案，而这四个测试文件各自都是绿的。
 */
test('nw-style.mjs 只搬运 core 的判据：门槛、豁免名单、注入预览都不许有第二份', () => {
  const cli = read('scripts/nw-style.mjs');
  assert.match(cli, /NWStyleFit\.KEYS\.map/, '四格表不是从包里现取的，加一格 CLI 就少一格');
  assert.match(cli, /NWStyleFit\.MIN_BODY/, 'CLI 自己判「够不够长」，与指纹的门槛会分家');
  assert.match(cli, /NWRules\.EXEMPT_FLAGS/, '豁免名单自己抄一份，CLI 说不评的章 R32 却照样报');
  assert.match(cli, /NWContext\.stylePool\(/, '参照章不是按「作者勾没勾」选的，那这视图与生成时看的不是同一份');
  assert.match(cli, /NWContext\.pickStyleExemplars\(/, '注入预览另算一遍就不是生成时那一份');
  assert.match(cli, /NWStylePack\.optsFrom\(book\)/, '没带作者自己的包就算指纹，他关掉的词组还照样报密度');
  // 门槛数字只许出现在 core 那份里
  assert.doesNotMatch(cli, /\b(?:0\.3|0\.4|1\.5)\b/, 'CLI 里出现了阈值数字，说明它没走 KEYS');
  // 视图不是门禁：偏离再多也不许用它拦人
  assert.doesNotMatch(cli, /process\.exit\((?:EXIT\.ERROR_FOUND|1)\)/, '这份视图退出码非零过 0，它只是量出来的数字');
});

/** 「越两格才报」这句话在规则里、在 CLI 的 keys 输出里各说一遍，两遍必须是同一个数。 */
test('守卫：R32 的「两格」门槛只有一处，CLI 与规则的话术跟着它走', () => {
  const rules = read('src/core/rules.js');
  assert.match(rules, /if \(drift\.length < 2\) continue;/, 'R32 的格数门槛写法变了，这条守卫与 CLI 话术都要改');
  assert.doesNotMatch(rules, /drift\.length < [3-9]/, '门槛被抬高却没改 CLI 与文档那句「两格」');
  const cli = read('scripts/nw-style.mjs');
  assert.match(cli, /同时越两格以上/, 'keys 里没交代报的门槛，作者会以为越一格也会被报');
});

/**
 * 状态矩阵这一批的全部价值都在「只画窗口内那几列」，而窗口判据在 statescope.js。
 * 界面一旦自己 `slice(-40)`，core 那个数就变成一句摆设 —— 这正是本项目反复犯的病，
 * 所以三条守卫各盯一面：加载表挂齐、界面只问 core、翻页条那颗按钮真有人接。
 */
test('statescope.js 在三张加载表里都在，且排在 app.js 之前', () => {
  const lists = loadLists();
  const miss = [];
  for (const [tag, list] of Object.entries({ web: lists.web, cache: lists.cache, tests: lists.tests })) {
    const i = list.indexOf('src/core/statescope.js');
    if (i === -1) miss.push(`${tag} 没挂 statescope.js`);
    else if (list.indexOf('src/app.js') !== -1 && i > list.indexOf('src/app.js')) miss.push(`${tag} 里它排在 app.js 之后`);
  }
  assert.deepEqual(miss, [], `加载表不齐：${miss.join('；')}（旧壳里没有它，矩阵的图例与翻页条会整块缺席）`);
});

test('矩阵画哪几列只问 statescope，界面里不许有第二份窗口', () => {
  const js = read('src/app.js');
  const panel = js.match(/\nasync function showStatesPanel\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(panel, 'app.js 里抠不出 showStatesPanel，这条守卫的形状变了');
  assert.match(panel, /NWStateScope\.windowOf\(/, '列不是 statescope 给的，默认窗口就成了第二份口径');
  assert.match(panel, /NWStateScope\.idSet\(/, '数「这一页几格」自己 filter 一遍，判据就分家了');
  assert.match(panel, /NWStateScope\.lines\(/, '图例不是 statescope 那句，三件事就说不齐');
  assert.doesNotMatch(panel, /\.slice\(-\d/, '界面自己按数字裁列，core 那个数改了没人知道');
  assert.doesNotMatch(panel, /size:\s*\d+|\bwindowOf\([^)]*\b\d{2,}\b/, '界面里出现了窗口大小的字面量');
  assert.match(panel, /NWStateScope\.WINDOW_SIZE/, '默认窗口没从 core 取，两处会各长各的');
  const scope = js.match(/\nfunction stateScopeOf\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(scope, 'app.js 里抠不出 stateScopeOf');
  assert.match(scope, /novelId !== key/, '换书不重置页码，会拿着上一本的页码翻这一本，画出来的是莫名其妙的几章');
});

/**
 * 翻页条上的按钮名是拼出来的（`data-action="${action}"`），那条「每个 data-action 都有处理器」
 * 的守卫抓不到 —— 所以这里真跑 stateScopeBar，把名字抠出来对着 ACTIONS 核，并把三种显隐状态验一遍：
 * 翻不动的按钮要 disabled，只有一页时整条不出现（给一个点了没反应的按钮比不给更坏）。
 */
test('翻页条在假 DOM 下真跑得通：按钮名有人接、翻不动时收着', () => {
  const js = read('src/app.js');
  const barSrc = js.match(/\nfunction stateScopeBar\([\s\S]*?\n\}/)?.[0];
  assert.ok(barSrc, 'app.js 里抠不出 stateScopeBar');
  const run = (win) => new Function('esc', 'W',
    `${barSrc} return stateScopeBar(W);`)((s) => String(s), win);
  const S = NWStateScope;
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, order: i + 1 }));
  /** 抠出某一颗按钮的整段标签：disabled 写在文字前面，光看文字周围几个字符是看不见的。 */
  const tagOf = (html, action) =>
    html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>[^<]*</button>`))?.[0] || '';
  const off = (html, action) => { const t = tagOf(html, action); return t.includes('disabled'); };

  const first = run(S.windowOf(mk(180), 40, 0));
  assert.deepEqual([...first.matchAll(/data-action="([\w-]+)"/g)].map((m) => m[1]).sort(),
    ['state-scope-all', 'state-scope-back', 'state-scope-recent'], '翻页条上不是那三颗按钮');
  const registered = new Set([...actionsSource(js).matchAll(/^\s+(['"])([\w-]+)\1\s*:/gm)].map((m) => m[2]));
  const dead = [...first.matchAll(/data-action="([\w-]+)"/g)].map((m) => m[1]).filter((a) => !registered.has(a));
  assert.deepEqual(dead, [], `这些按钮点了没反应：${dead.join('、')}`);
  assert.ok(off(first, 'state-scope-recent'), '已经在最近一页，那颗按钮还亮着');
  assert.equal(off(first, 'state-scope-back'), false, '往前还有四页，就说翻不动了');
  assert.ok(tagOf(first, 'state-scope-all').includes('全书一起看'), first);
  assert.ok(first.includes('第 5／5 页'), first);

  const last = run(S.windowOf(mk(180), 40, 4));
  assert.ok(off(last, 'state-scope-back'), '已经翻到最早一页，往前没得翻了还不收按钮');
  assert.equal(off(last, 'state-scope-recent'), false, last);
  assert.ok(last.includes('第 1／5 页'), last);

  // 不足一页的书不给条；全书模式反过来 —— 它必须留着「收成一片」，否则回不到分页
  assert.equal(run(S.windowOf(mk(6), 40, 0)), '', '书比一页还短，不该出现「再往前」');
  const wide = run(S.windowOf(mk(180), 180, 0));
  assert.ok(wide.includes('收成一片'), '全书模式下没有那颗退回分页的按钮，进去就出不来：' + wide);
  assert.equal(tagOf(wide, 'state-scope-back'), '', '全书模式没有「第几页」，别摆两颗永远点不动的翻页钮');
  assert.equal(tagOf(wide, 'state-scope-recent'), '', wide);
  assert.ok(wide.includes('全书 180 章都画出来了'), wide);
});

/**
 * 卷是新长出来的一族表单：四格，其中两格是章节选择器。
 * 漏读一格的表现是作者填了「起始章」、卷建好了却盖不住任何章 —— 不报错，
 * 面板上看起来一切正常，只有 prompt 里那段「更早 N 章」永远不减。
 * 所以既核对名字全被读走，也在假 DOM 下真跑一遍：读回来的必须就是作者填的。
 */
test('卷表单的每个控件都要被 readVolumeForm 读走，读回来的就是作者填的', () => {
  const js = read('src/app.js');
  const form = js.match(/\nfunction volumeFields\([\s\S]*?\n\}/)?.[0];
  const valSrc = js.match(/\nfunction val\(id\) \{[\s\S]*?\n\}/)?.[0];
  const reader = js.match(/\nfunction readVolumeForm\([\s\S]*?\n\}/)?.[0];
  assert.ok(form && valSrc && reader, 'app.js 里抠不出 volumeFields / val / readVolumeForm');
  const ids = [...new Set([...form.matchAll(/\$\{prefix\}-([\w-]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(ids, ['v-from', 'v-summary', 'v-title', 'v-to'], '卷表单不是那四格控件，这条守卫得跟着改');
  const afterReturn = reader.slice(reader.indexOf('return {'));
  assert.deepEqual(ids.filter((k) => !afterReturn.includes(k)), [], '这些控件的值从来没被读走');

  const run = (fields) => new Function('document', `${valSrc}\n${reader} return readVolumeForm('vol');`)(
    { getElementById: (id) => fields[id] ?? null });
  assert.deepEqual(run({
    'vol-v-title': { value: ' 卷一·出山 ' },
    'vol-v-from': { value: 'ch_3' },
    'vol-v-to': { value: 'ch_9' },
    'vol-v-summary': { value: '林烟火出山查明师死，结识沈孤舟' },
  }), {
    title: '卷一·出山', fromChapter: 'ch_3', toChapter: 'ch_9',
    summary: '林烟火出山查明师死，结识沈孤舟',
  });
  // 没选章要落成 null 而不是空串：saveVolume 判「没选起止章」靠的就是 null
  assert.deepEqual(run({ 'vol-v-title': { value: '卷二' } }),
    { title: '卷二', fromChapter: null, toChapter: null, summary: '' });
});

/**
 * 卷面板上每一句状态话都由 recapPlan 的分桶决定，而窗口判据只有 volumes.js 一份。
 * 界面一旦自己 `slice(-12)` 或把 12 抄进文案，core 改了口径没人知道，表现是
 * 面板说「已覆盖」、续写时那段「更早 N 章」却还长着 —— 正是本项目反复犯的病。
 */
test('卷面板的分层只问 volumes/context，界面里不许有第二份窗口', () => {
  const js = read('src/app.js');
  const panel = js.match(/\nasync function showVolumeList\([\s\S]*?\n\}/)?.[0];
  assert.ok(panel, 'app.js 里抠不出 showVolumeList，这条守卫的形状变了');
  assert.match(panel, /NWContext\.recapPlanOf\(/, '分层不是 context 给的那一份，窗口就成了第二份口径');
  assert.match(panel, /NWVolume\.gapNotice\(/, '缺口那句话自己重写了一遍，面板说的和 prompt 说的就分家');
  assert.match(panel, /NWVolume\.rangeText\(/, '区间不是 volumes.js 那句，「存章不存号」的口径会走样');
  assert.match(panel, /NWVolume\.coveredCount\(/, '盖住了几章界面自己数，R33 与 prompt 报的数就对不上');
  assert.match(panel, /NWContext\.RECAP_ITEMS/, '「压在最近 N 章上」的 N 没从 core 取，两处会各长各的');
  assert.doesNotMatch(panel, /\.slice\(-\d/, '界面自己按数字裁章，core 那个窗口改了没人知道');
  assert.doesNotMatch(panel, /\b(?:fine|mid|cap|window|size):\s*\d+/, '界面里出现了分层窗口的字面量');
});

/**
 * 上一条只核对「没抄第二份窗口」，这一条真跑一遍：面板上每一张卷卡的那个状态标签，
 * 是作者唯一的「这一卷到底压住了没有」的依据。标签接错桶看不出来 ——
 * 空摘要的卷被画成「已覆盖」，作者就再也不会去补那 120 字，而 prompt 里那段「更早」照旧长着。
 * 面板一律按「整本都算过去」出计划（currentId=null），所以盖到最后一章的那一卷是
 * 「压在最近 12 章上」，不是「越过本章」—— 这一条也顺手钉住：别把同一件事说成剧透。
 */
test('卷面板假 DOM 下真跑：五种状态标签各归各桶，区间与缺口那句用的是 core 的数', async () => {
  const js = read('src/app.js');
  const src = js.match(/\nasync function showVolumeList\([\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'app.js 里抠不出 showVolumeList');
  const hintSrc = js.match(/\nfunction emptyHint\([\s\S]*?\n\}/)?.[0];
  assert.ok(hintSrc, '抠不出 emptyHint，那条「没建卷」的话就没被真跑过');

  const chapters = Array.from({ length: 40 }, (_, i) => ({
    id: 'ch_' + i, order: i + 1, title: '第' + (i + 1) + '章', summary: `事件${i + 1}`,
  }));
  const V = (id, order, a, b, summary) => ({ id, order, title: id, fromChapter: 'ch_' + a, toChapter: 'ch_' + b, summary });
  const rows = [
    { id: '坏卷', order: 1, title: '坏卷', fromChapter: 'ch_被删了', toChapter: 'ch_12', summary: '有摘要也没用' },
    V('空卷', 2, 0, 4, '   '),
    V('压窗卷', 3, 20, 35, '压着最近那 12 章的一段'),
    ...Array.from({ length: 13 }, (_, i) => V('卷' + (i + 6), 10 + i, i + 6, i + 6, '单章一卷')),
  ];
  const emptyHint = new Function('esc', `${hintSrc}\n return emptyHint;`)(NWText.esc);
  const render = async (list, novel = { id: 'n1' }) => {
    const host = { innerHTML: '' };
    const run = new Function('NovelDB', 'NWContext', 'NWVolume', 'APP', 'esc', 'attr', 'document', 'emptyHint',
      `${src}\n return showVolumeList;`)({ volumes: { list: async () => list } }, NWContext, NWVolume,
      { novel, chaptersCache: chapters }, NWText.esc, NWText.attr, { getElementById: () => null }, emptyHint);
    await run(host);
    return host.innerHTML;
  };
  const card = (html, title) => html.split('char-card" ').find((s) => s.includes('>' + title) || s.includes(title + ' <')) || '';

  const html = await render(rows);
  assert.match(card(html, '坏卷'), /起止章读不出来/, '起止章被删了得说清读不出来，不能画成正常一卷');
  assert.match(card(html, '空卷'), /还没写摘要/, '空摘要的卷不许顶着「已压缩」的样子');
  assert.match(card(html, '压窗卷'), /压在最近 12 章上/, '压着细窗口的卷说的是重复，不是缺口');
  assert.ok(!card(html, '压窗卷').includes('越过本章'), '面板按整本算过去，最后一卷不是剧透');
  assert.match(card(html, '卷6'), /太早，已折成计数/, '13 卷里折掉最老那一卷要看得出来');
  assert.ok(!/novel-card-upgrade/.test(card(html, '卷7')), '真进了上下文的那一卷不该再顶一个标签');
  assert.match(html, /第 7 章·1 章/, '单章卷说「第 7 章」而不是「第 7–7 章」，章号取自库行的 order');
  assert.match(html, /第 21–36 章·16 章/, '跨段卷的区间与章数都在，且不是「第 undefined 章」');
  assert.match(html, /class="volume-gap"/, '顶部那句缺口没了，作者就看不到该补哪一卷');
  assert.match(html, /1 卷还没写摘要[^·]*·[^·]*1 卷的起止章在书里读不出来/, '缺口那句说的是 core 那五种成因里的两种');

  const empty = await render([]);
  assert.match(empty, /建第一卷/, '没建卷时那句引导必须在');
  assert.match(empty, /卷纲[^。]*不会自动变成卷/, '向导填的卷纲不会自动变成卷 —— 这句实话不能丢');
  assert.ok(!empty.includes('volume-gap'), '一卷都没有时不该报缺口');
});

/**
 * 浏览器侧装配 ctx 这一环，反验时改坏两次都没人管（取库少取 volumes、buildCtx 少传 volumes）：
 * 界面照样画得出卷，只是那一行永远进不了 prompt。所以这里不比对字符串，直接拿假库跑一遍，
 * 再看前情摘要里到底有没有那一行。
 */
test('浏览器装配 ctx 在假库下真跑：库里取的卷交进 buildCtx，最后成为前情里那一行', async () => {
  const src = read('src/app.js').match(/\nasync function loadStoryCtx\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'app.js 里抠不出 loadStoryCtx');
  const chapters = Array.from({ length: 40 }, (_, i) => ({
    id: 'ch_' + i, order: i + 1, number: i + 1, title: '第' + (i + 1) + '章',
    summary: `事件${i + 1}`, content: '正文。',
  }));
  const volumes = [{ id: 'vol_1', order: 1, title: '卷一·出山', fromChapter: 'ch_0', toChapter: 'ch_19', summary: '林烟火出山查明师死，得半枚铜印' }];
  const list = (rows) => async () => rows;
  const stub = {
    novels: { get: async () => ({ id: 'n1', title: '烟火纪', format: 'long' }) },
    chapters: { list: list(chapters) },
    characters: { list: list([]) }, worldbuilding: { list: list([]) }, promises: { list: list([]) },
    timeline: { list: list([]) }, suppressions: { list: list([]) }, states: { list: list([]) },
    relations: { list: list([]) }, decisions: { list: list([]) }, secrets: { list: list([]) },
    volumes: { list: list(volumes) },
  };
  const APP = { novel: { id: 'n1' } };
  const load = new Function('NovelDB', 'NWStory', 'APP', `${src}\n return loadStoryCtx;`)(stub, NWStory, APP);
  const ctx = await load();
  assert.equal(ctx.volumes.length, 1, '卷没交进 buildCtx：侧栏看得见，模型一个字都吃不到');
  assert.equal(ctx.volumes[0].title, '卷一·出山');
  assert.equal(APP.chaptersCache, chapters, '章节缓存要跟着更新，矩阵与卷面板都读它');
  const text = NWContext.buildSections(ctx, { chapterId: 'ch_39' })
    .sections.find((s) => s.name === '前情摘要').text;
  assert.match(text, /卷一·出山/, '前情摘要里必须有这一行卷摘要');
  assert.ok(!text.includes('第20章'), '卷盖住的最后一章仍逐章列着：那一卷等于没压');
  assert.match(text, /更早 7 章：第21章/, '盖住之后那几章退回章名层 —— 分层只问 core 那一份');
});

/**
 * 卷这条通路横跨五个文件，每一处都是字符串级对接：库行在 db.js、过桥在 story.js 的
 * buildCtx、分层在 context.js、导出在 project.js、读盘在 CLI。接错一边不报错，
 * 只是作者建的卷永远进不了 prompt —— 而界面上一切看起来正常。
 */
test('卷这条通路五段都接通：库 → ctx → 前情分层 → 导出 → CLI 读盘', () => {
  const db = read('src/core/db.js');
  assert.match(db, /createObjectStore\('volumes'/, 'volumes store 没建，保存卷会直接抛错');
  const cascade = db.match(/const CASCADE_STORES = \[[\s\S]*?\]/)?.[0] || '';
  assert.ok(cascade.includes("'volumes'"), 'volumes 不在级联清单里，删书会留下一堆孤儿卷');
  assert.match(db, /volumes:\s*\{[^}]*list: listVolumes/, '门面上没有 volumes，界面调不到');

  assert.match(read('src/core/story.js'), /volumes: rows\.volumes/,
    'buildCtx 没把卷过桥，作者建的卷就只是侧栏里的一行字，进不了 prompt');

  const cx = read('src/core/context.js');
  assert.match(cx, /Vol\.recapPlan\(/, '分层判据不是 volumes.js 那一份，两处窗口会各长各的');
  assert.match(cx, /recapText\(chapters, current,[^)]*ctx\.volumes/,
    'buildSections 造摘要时没把 ctx.volumes 喂进去，建多少卷都不注入');

  const pr = read('src/core/project.js');
  assert.ok(pr.includes("'continuity/volumes.json'"), '导出没写卷文件，同步时等于从没建过卷');
  assert.match(pr, /case 'volume':/, 'authorProjection 没有 volume 分支，导入时字段白名单对不上');
  assert.match(pr, /\['volumes', 'volume'/, 'planMerge 没有卷这一桶，本地与远端改过的卷无人裁决');

  assert.ok(read('scripts/lib/book.mjs').includes("'volumes.json'"),
    'CLI loadBook 不读卷，Web 建的卷在命令行了不存在');
});

/**
 * 文档里那几个数字是作者做决定用的依据（「再往前 24 章只列章名」「一卷摘要 ≤120 字」），
 * 而它们是抄 core 的。core 改了窗口而文档没跟，作者就照旧的说法去补卷、补完发现压不住 ——
 * 「宣称与实现对不上」这一族的病，成本最低的一次复发就是文档先烂。
 */
test('技能文档与 README 里写死的窗口数字与三条判据，跟着 core 那一份走', () => {
  const budget = read('skills/novelweave/references/context-budget.md');
  assert.match(budget, new RegExp(`再往前 ${NWVolume.RECAP_MID} 章只列章名`),
    `文档说的章名层窗口不是 core 那个 ${NWVolume.RECAP_MID}`);
  assert.match(budget, new RegExp(`≤${NWVolume.VOL_LINE_CHARS} 字`),
    '文档里卷摘要的长度与 lineOf 裁的那个数不是同一份');
  assert.match(budget, /斜率降到每卷一行，不是 O\(1\)/, '「压缩到常数」这种话不许写进文档：卷多到上限仍要折成计数');

  const readme = read('README.md');
  for (const claim of ['没写摘要的卷不盖章', '盖到本章之后的卷不注入', '起止章被删了就整卷不用']) {
    assert.ok(readme.includes(claim), `README 少了三条判据里的一条：${claim}`);
  }
});

// ═══════════════ T 族：关系这条通路（假 DOM 真跑 + 只有一份判据）═══════════════

test('AI 抽关系入库的是角色 id，不是模型给的那两个字（假 DOM 真跑）', async () => {
  const js = read('src/app.js');
  const src = js.match(/\nasync function renderExtractedRelations\([\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'app.js 里抠不出 renderExtractedRelations');
  assert.doesNotMatch(src, /byName\.get\(/, '界面里不许再有第二份「名字→人」的查法：那份不认撞名');
  assert.match(src, /NWRelationGraph\.endpointOf\(/, '端点解析必须问 core 那一份');

  const chars = [{ id: 'char_lin', name: '林烟火' }, { id: 'char_ming', name: '明长老' },
    { id: 'char_a', name: '甲' }, { id: 'char_b', name: '甲' }];
  const saved = [];
  const db = {
    characters: { list: async () => chars },
    relations: { save: async (nid, e) => { saved.push(e); return e; } },
  };
  const made = [];
  const doc = {
    createElement: (tag) => {
      const node = { tag, className: '', innerHTML: '', textContent: '', dataset: {}, style: {}, children: [] };
      node.appendChild = (c) => node.children.push(c);
      made.push(node);
      return node;
    },
  };
  const rows = [];
  const host = {
    children: [],
    appendChild(n) { this.children.push(n); if (n.dataset.vi !== undefined) rows.push(n); },
    querySelectorAll: () => rows.filter((r) => /type="checkbox" checked/.test(r.innerHTML)),
  };
  const run = new Function('NovelDB', 'NWRelationGraph', 'APP', 'esc', 'document',
    `${src}\n return renderExtractedRelations;`)(db, NWRelationGraph, { novelId: 'n1' }, NWText.esc, doc);

  await run(host, [
    { from: '林烟火', to: 'char_ming', kind: '师徒', address: '师父', evidence: '第 3 章' },
    { from: 'char_lin', to: '甲', kind: '同门' },
    { from: '明长老', to: '明长老', kind: '自恋' },
    { from: 'char_lin', to: '查无此人', kind: '敌对' },
  ]);

  assert.equal(rows.length, 4, '四条候选都得列出来 —— 悄悄丢掉一半，作者不知道少了什么');
  assert.match(rows[1].innerHTML, /撞名/, '撞名要说是撞名，不是含糊的「解析失败」');
  assert.match(rows[2].innerHTML, /同一个角色/);
  assert.match(rows[3].innerHTML, /不在角色卡上/);
  assert.ok(!/type="checkbox" checked/.test(rows[1].innerHTML), '落不了库的那几条不许默认勾上');
  assert.match(rows[0].innerHTML, /type="checkbox" checked/);
  assert.match(host.children[0].textContent, /1 条两端对得上角色卡/, '顶上那句先说清几条能落地');
  assert.match(host.children[0].textContent, /3 条对不上/);

  const btn = made.find((n) => n.className === 'btn btn-primary');
  // 作者手贱把落不了库的那条也勾上：不入库，而且要点完当场就知道
  rows[1].innerHTML = rows[1].innerHTML.replace('type="checkbox"', 'type="checkbox" checked');
  await btn.onclick();
  assert.equal(saved.length, 1, '只有两端都对得上的那条进得了库');
  assert.deepEqual([saved[0].from, saved[0].to], ['char_lin', 'char_ming'],
    '存的必须是解析后的角色 id：名字是作者随时会改的那个字段');
  assert.equal(saved[0].kind, '师徒');
  assert.match(btn.textContent, /已入库 1 条/);
  assert.match(btn.textContent, /1 条两端对不上角色卡/, '拒了几条要说几条，不许显示成「什么都没发生」');
});

test('关系面板的起止章是下拉不是手打 id，弹窗里读的六个格子都有渲染点', () => {
  const js = read('src/app.js');
  const src = js.match(/\nfunction showCreateRelation\(existing\)[\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'app.js 里抠不出 showCreateRelation');
  for (const id of ['inp-rel-from', 'inp-rel-to', 'inp-rel-kind', 'inp-rel-address', 'inp-rel-since', 'inp-rel-until']) {
    assert.match(src, new RegExp(`id="${id}"`), `面板读了 ${id} 却没渲染它`);
  }
  for (const side of ['since', 'until']) {
    assert.match(src, new RegExp(`<select class="settings-select" id="inp-rel-${side}">`),
      `起止章还是手打输入框：库里存的是章 id，让作者照着 placeholder 敲就是一个字符一条断链`);
  }
  assert.match(src, /（这一章已不在书里）/, '老边指着被删的章时，下拉里要看得见那个坏值，不许静默变成「不限」');
  assert.match(src, /起止章选反了/, '填反了要在点保存那一刻说出口，不是留给写库闸抛错（modal 吞 rejection）');
  assert.doesNotMatch(src, /closeModal\(\)[\s\S]*?val\('inp-rel/, '关掉弹窗之后再读控件就是读 null');
});

/**
 * 关系弹窗的真跑夹具：假 NovelDB 记下了每一次存与删，假控件表就是作者此刻填的那六格。
 * 浏览器里点出来的一条毛病（改一条没有 id 的旧关系多出一条边）光看源码是看不出的 ——
 * 那行 delete 读起来完全合理，只有把库做成数组才知道它有没有被调用。
 */
function openRelationModal(existing, filled) {
  const js = read('src/app.js');
  const src = js.match(/\nfunction showCreateRelation\(existing\)[\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'app.js 里抠不出 showCreateRelation');
  const rows = existing ? [{ ...existing }] : [];
  const saved = [];
  const deleted = [];
  const toasts = [];
  const db = {
    characters: { list: async () => [{ id: 'char_lin', name: '林烟火' }, { id: 'char_ming', name: '明长老' }] },
    chapters: { list: async () => [{ id: 'ch_a', order: 1, title: '井台' }, { id: 'ch_b', order: 2, title: '火' }] },
    relations: {
      save: async (nid, edge) => {
        saved.push(edge);
        rows.push({ ...edge, id: edge.id || 'rel-generated' });   // 空主键那行不会覆盖旧行，只会另起一行
      },
      delete: async (id) => {
        deleted.push(id);
        const i = rows.findIndex((r) => (r.id ?? '') === id);
        if (i >= 0) rows.splice(i, 1);
      },
    },
  };
  const controls = {
    'inp-rel-from': 'char_lin', 'inp-rel-to': 'char_ming', 'inp-rel-kind': '师徒',
    'inp-rel-address': '师父', 'inp-rel-since': '', 'inp-rel-until': '', ...filled,
  };
  let onOk = null;
  let onDel = undefined;
  const run = new Function('NovelDB', 'APP', 'esc', 'attr', 'val', 'showModal', 'closeModal', 'showToast',
    'renderSidebarPanel', 'document', 'confirm',
    `${src}\n return showCreateRelation;`)(
    db, { novel: { id: 'n1' } }, NWText.esc, NWText.attr, (id) => controls[id],
    (title, body, cb, delCb) => { onOk = cb; onDel = delCb; }, () => {}, (t) => toasts.push(t), async () => {},
    { getElementById: () => null }, () => true);
  run(existing);
  return new Promise((r) => setTimeout(r, 0)).then(() => ({
    rows, saved, deleted, toasts,
    hasDel: typeof onDel === 'function',
    save: () => onOk(),
    del: () => (onDel ? onDel() : Promise.reject(new Error('弹窗没有删除回调，那颗按钮根本没渲染'))),
  }));
}

test('改一条没有 id 的旧关系只剩一条：空主键那行得回头删掉，不然每改一次多出一条边', async () => {
  const m = await openRelationModal({ id: '', from: 'char_lin', to: 'char_ming', kind: '师徒' }, {});
  await m.save();
  assert.equal(m.saved.length, 1);
  assert.deepEqual(m.deleted, [''], 'save 给这条换了个新主键，旧行不会自己消失，必须点名叫一次 delete');
  assert.equal(m.rows.length, 1, `库里还该是一条边，实际 ${m.rows.length} 条：作者看见两条一模一样的师徒，删一条还剩一条`);
});

test('起止章填反了要说清反在哪一头：失效章排在生效章之前', async () => {
  const m = await openRelationModal(null, { 'inp-rel-since': 'ch_b', 'inp-rel-until': 'ch_a' });
  await m.save();
  assert.equal(m.saved.length, 0, '填反了不该落库');
  assert.match(m.toasts.join('｜'), /起止章选反了[：:].{0,12}失效章排在生效章之前/,
    '说成「之后」就是把方向讲反了，作者会照着反话去改对的那一头');
});

test('改口之后不许再有人把「改不到」写回来：这三处文案说的都是同一件已经能做好的事', () => {
  for (const p of ['src/app.js', 'src/core/relationgraph.js', 'src/core/rules.js']) {
    assert.doesNotMatch(read(p), /改不到|改了也不会生效/,
      `${p} 还在说关系边改不动：面板里存一次就会领到自己的 id，这句话已经把作者挡在门外了`);
  }
});

test('编辑关系弹窗里那颗删除按钮是真渲染的：回调得当 showModal 的第 4 个参数交进去', async () => {
  const m = await openRelationModal({ id: 'rel_ok', from: 'char_lin', to: 'char_ming', kind: '师徒' }, {});
  assert.ok(m.hasDel, '编辑已有关系却不给删除回调 —— showModal 只按第 4 个参数渲染那颗按钮，事后 getElementById 拿到的是 null');
  await m.del();
  assert.deepEqual(m.deleted, ['rel_ok']);
  assert.equal(m.rows.length, 0, '点删除要真少一条');

  const fresh = await openRelationModal(null, {});
  assert.ok(!fresh.hasDel, '登记新关系时不该出现删除：那一条还没进库');
});

test('全仓不许再有人事后找那颗删除按钮：它只在 showModal 收到第 4 个参数时才存在', () => {
  const js = read('src/app.js');
  assert.doesNotMatch(js, /getElementById\('modal-del-btn'\)/,
    'modal-del-btn 是 showModal 按第 4 个参数才渲染的：弹窗已经开完再按 id 去找，拿到的是 null，删的那条路就成了一段永不执行的代码');
  const dec = js.match(/\nfunction showCreateDecision\(existing\)[\s\S]*?\n\}/)?.[0];
  assert.ok(dec, 'app.js 里抠不出 showCreateDecision');
  assert.match(dec, /\}, isEdit \? async \(\) => \{[\s\S]{0,220}?decisions\.delete/,
    '决策的删除回调没当第 4 个参数交给 showModal：编辑弹窗里不会出现那颗按钮');
});

// ═══════════════ T5：关系面板只问 core，一个坐标都不自己算 ═══════════════

test('面板与弹窗里不许有第二套判据：坐标、区间、缺口都出自 NWRelationGraph', () => {
  const js = read('src/app.js');
  const region = js.match(/\nasync function showRelationList\([\s\S]*?\nfunction showRelationGraph\(/)?.[0];
  assert.ok(region, 'app.js 里抠不出 showRelationList');
  assert.match(region, /NWRelationGraph\.build\(/, '哪条边还活着必须问 core');
  assert.match(region, /NWRelationGraph\.notice\(/, '缺口那一句只可能来自 core');
  assert.match(region, /NWRelationGraph\.rangeText\(/, '区间的人话说法也在 core，别在面板里拼「第 X–Y 章」');
  const modal = js.match(/\nfunction showRelationGraph\([\s\S]*?\n\}/)?.[0];
  assert.ok(modal, 'app.js 里抠不出 showRelationGraph');
  assert.match(modal, /NWRelationGraph\.toSvg\(/, '那张图是 core 出的字符串');

  const both = region + modal;
  assert.doesNotMatch(both, /Math\./, '视图里不算几何：圆心与半径是 layout 的事');
  assert.doesNotMatch(both, /viewBox|x1=|cx=/, '视图里不写 SVG 属性：那些是 toSvg 的事');
  assert.doesNotMatch(both, /class="rg-|'rg-/, 'rg-* 这些 class 只由 core 写出去，界面照着上色');
  // 从前这张卡片写的是 `e.until ? '已结束'`：填了失效章就算结束，坏边与自环边都被它盖过去
  assert.doesNotMatch(region, /e\.until \? ['"][ ]*<span/, '「填了 until 就算结束」是那份算反的判据，别回来');
  assert.match(region, /l\.state === 'ended'/, '「已结束」问的是 stateOf 那一份');
});

test('core 出图用到的每个 class 都在样式表里活着（少一条就是一片看不见的线）', () => {
  const core = read('src/core/relationgraph.js');
  const css = read('src/styles/app.css');
  const used = new Set();
  for (const m of core.matchAll(/\b(rg-[\w-]+|nw-relation-graph)\b/g)) used.add(m[1]);
  assert.ok(used.size >= 9, `只抠到 ${used.size} 个 class：${[...used].join(',')}`);
  const missing = [...used].filter((c) => !new RegExp(`\\.${c}\\b`).test(css)).sort();
  assert.deepEqual(missing, [], `app.css 里缺这些关系图 class 的定义：${missing.join(', ')}`);
  // 反过来说也成立：样式表里不该留着 core 已经不出来的 rg-*（那是一条永远套不上的规则）
  const stale = [...css.matchAll(/\.(rg-[\w-]+)\b/g)].map((m) => m[1]).filter((c) => !used.has(c));
  assert.deepEqual(stale, [], `app.css 里有 core 不再写出的关系图 class：${stale.join(', ')}`);
});

test('关系面板：缺口那一句、八种状态标签、那颗看全图按钮（假 DOM 真跑）', async () => {
  const js = read('src/app.js');
  const src = js.match(/\nasync function showRelationList\([\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'app.js 里抠不出 showRelationList');

  const chars = [
    { id: 'char_lin', name: '林烟火' },
    { id: 'char_ming', name: '明长老' },
    { id: 'char_su', name: '苏晚' },
  ];
  const chapters = [
    { id: 'ch_a', order: 1, title: '山门' }, { id: 'ch_b', order: 2, title: '夜袭' },
    { id: 'ch_c', order: 3, title: '下山' }, { id: 'ch_d', order: 4, title: '回头' },
  ];
  const edges = [
    { id: 'rel_open', from: 'char_lin', to: 'char_ming', kind: '师徒', address: '师父' },
    { id: 'rel_since', from: 'char_su', to: 'char_lin', kind: '同乡', since: 'ch_a', until: null },
    { id: 'rel_ended', from: 'char_lin', to: 'char_su', kind: '同门', since: 'ch_a', until: 'ch_b' },
    { id: 'rel_future', from: 'char_ming', to: 'char_su', kind: '旧识', since: 'ch_d', until: null },
    { id: 'rel_bad', from: 'char_lin', to: 'char_ming', kind: '决裂', since: 'ch_d', until: 'ch_b' },
    { id: 'rel_ghost', from: 'char_lin', to: 'ghost', kind: '敌对', until: 'ch_a' },
    { id: 'rel_name', from: '苏晚', to: '林烟火', kind: '同乡' },
    { id: 'rel_loop', from: 'char_lin', to: 'char_lin', kind: '自言自语' },
    { from: 'char_lin', to: 'char_su', kind: '没 id 的那条' },
  ];
  const db = {
    relations: { list: async () => edges },
    characters: { list: async () => chars },
    chapters: { list: async () => chapters },
  };
  const host = { innerHTML: '' };
  const run = new Function('NovelDB', 'NWRelationGraph', 'APP', 'esc', 'attr', 'emptyHint', 'document',
    `${src}\n return showRelationList;`)(
    db, NWRelationGraph, { novel: { id: 'n1' } }, NWText.esc, NWText.attr,
    (t) => `<div class="empty-hint">${NWText.esc(t)}</div>`, { getElementById: () => null });
  await run(host);

  const html = host.innerHTML;
  const cards = html.split('<div class="char-card"').slice(1);
  assert.equal(cards.length, edges.length, '账本里每一条都要有一张卡片：画不出来的那条尤其要看一眼');
  assert.match(html, /class="relation-gap"/);
  assert.match(html, /1 条边没有 id 或与别的边同 id/);
  assert.match(html, /1 条边的某一头连不到任何角色，画不出来/);
  assert.match(html, /1 条边的两头是同一个角色/);
  assert.match(html, /条边靠名字连着，改个名字就断/);
  assert.match(html, /生效区间是坏的（1 条填反了）/);
  assert.match(html, /data-action="relation-graph"/, '看全图那颗按钮得在，并且走事件委托');

  assert.doesNotMatch(cards[0], /novel-card-upgrade/, '一直如此的那条不该顶任何标签');
  assert.match(cards[0], /师徒（称谓：师父）<br>一直如此/);
  // 这一条是那一处旧毛病的反面：只填了起点、没填终点，旧面板不会标结束，新面板也不该标
  assert.doesNotMatch(cards[1], /已结束/, '没登记结束不等于结束了 —— 它现在还在约束');
  assert.match(cards[1], /自第 1 章起/);
  assert.match(cards[2], /已结束/);
  // 起点是全书最后一章的那条：面板按书末尾看，它已经开始了，所以不该顶「还没生效」
  assert.doesNotMatch(cards[3], /novel-card-upgrade/, '面板里没有「还没开始」这一档：走到了就说明 cut 传错了');
  assert.match(cards[3], /旧识<br>自第 4 章起/);
  assert.match(cards[4], /区间坏了/);
  assert.doesNotMatch(cards[4], /已结束/, '起止填反了的那条不该被说成「结束了」');
  assert.match(cards[4], /起止章填反了/);
  assert.match(cards[5], /画不出来/);
  assert.doesNotMatch(cards[5], /已结束/);
  assert.match(cards[5], /客体「ghost」角色卡上没有这个人/);
  assert.match(cards[6], /靠名字连着/);
  assert.match(cards[7], /两头同一个人/);
  assert.match(cards[8], /没有可用 id，图上没画/);
});

test('看全图弹窗里那段 SVG 是 core 的原样字符串，缺口那一句也一起进去（假 DOM 真跑）', async () => {
  const js = read('src/app.js');
  const src = js.match(/\nfunction showRelationGraph\([\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'app.js 里抠不出 showRelationGraph');
  const chars = [{ id: 'c1', name: '甲' }, { id: 'c2', name: '乙' }];
  const edges = [{ id: 'e1', from: 'c1', to: 'c2', kind: '师徒' }, { id: 'e2', from: 'c1', to: 'nope', kind: '敌对' }];
  const chapters = [{ id: 'ch_a', order: 1 }];
  const db = {
    relations: { list: async () => edges },
    characters: { list: async () => chars },
    chapters: { list: async () => chapters },
  };
  const seen = [];
  const run = new Function('NovelDB', 'NWRelationGraph', 'APP', 'esc', 'showModal', 'showToast',
    `${src}\n return showRelationGraph;`)(
    db, NWRelationGraph, { novel: { id: 'n1' } }, NWText.esc,
    (title, body) => seen.push({ title, body }), () => {});
  run();
  await new Promise((r) => setTimeout(r, 0));
  const g = NWRelationGraph.build({ characters: chars, edges, chapters, cut: null });
  assert.equal(seen.length, 1);
  assert.match(seen[0].body, new RegExp(NWRelationGraph.toSvg(g).slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '弹窗里就是 core 那张图，一个坐标都没重算');
  assert.match(seen[0].title, /2 个角色、1 条边/);
  assert.match(seen[0].body, /1 条边的某一头连不到任何角色/);
});

/**
 * 排版遗留这一批（U）三条守卫盯的是同一件事：一个数、一道几何只许有一处说了算。
 * 封面那列字数原先被裁两刀（JS 取 6 字、CSS 的 46px 只放得下约 3 字）；AI 操作条的几何
 * 原先在 app.css 与 app.js 各写一份，而且滚动时长正文把它顶出可视区；章节列表则要防的是
 * 「界面自己再排一遍」—— 与 R 批翻页条同构的病，所以连跑法都照抄那一条。
 */
test('封面那列书名只有 coverTitle 一处裁：样式里不许留第二道高度上限', () => {
  const css = read('src/styles/app.css');
  const span = css.match(/\.novel-card-cover span\s*\{[^}]*\}/)?.[0] || '';
  assert.ok(span, 'app.css 里找不到 .novel-card-cover span 这条规则');
  assert.doesNotMatch(span, /max-height|overflow/, '高度上限一旦回到样式里，就又是两道互不知情的裁切：画出来永远比代码少半截');
  const js = read('src/app.js');
  assert.equal(js.includes('titleForCover'), false, '界面里那道第二次截断（旧的 slice(0, 6)）不许回来');
  assert.match(js, /const coverTitle = NWText\.coverTitle\(n\.title\);/, '封面上的字必须问 core 那一处');
});

test('AI 结果操作条的几何只在 .ai-result-actions 一处：粘底、实心底、界面不写第二道内联样式', () => {
  const css = read('src/styles/app.css');
  const block = css.match(/\.ai-result-actions\s*\{[^}]*\}/)?.[0] || '';
  assert.ok(block, 'app.css 里找不到 .ai-result-actions');
  assert.match(block, /position:\s*sticky/, '这条挂着复制/插入/替换，生成的正文一长就得滚回底部才点得到');
  assert.match(block, /bottom:\s*0/);
  assert.doesNotMatch(block, /--bg-input/, '--bg-input 是 4% 半透明，粘住时底下滚过的正文会透上来糊成一片');
  assert.match(css, /\.ai-result-actions \.btn\s*\{/, '按钮尺寸得有唯一一处；界面那边不许再各写一份');
  const js = read('src/app.js');
  assert.equal((js.match(/className = 'ai-result-actions'/g) || []).length, 2, '结果与失败两条都要走这个类');
  for (const fn of ['renderAIResult', 'renderAIError']) {
    const body = js.match(new RegExp(`\\nfunction ${fn}\\([\\s\\S]*?\\n\\}`))?.[0] || '';
    assert.ok(body, `app.js 里抠不出 ${fn}，这条守卫的形状变了`);
    assert.doesNotMatch(body, /\b(?:bar|retry|b)\.style\./, `${fn} 还在给这条或它的按钮写内联几何：尺寸就有两处，改了 CSS 界面不动`);
  }
});

test('侧栏章节列表的排序只有一处：界面选档、db 排序，切换条那两颗按钮真有人接', () => {
  const js = read('src/app.js');
  const list = js.match(/\nasync function renderChapterList\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(list, 'app.js 里抠不出 renderChapterList');
  assert.doesNotMatch(list, /\.sort\(/, '排序判据住 db，界面里再排一遍就有两份口径');
  assert.match(list, /const sort = chapterSortOf\(\);/, '这一档没取当前档，按钮切了等于没切');
  assert.match(list, /chapters\.list\(APP\.novel\.id, \{ recent: sort\.recent \}\)/,
    '这一档必须把「当前是哪一档」真传到 db，写死任一侧都是装饰按钮');
  assert.match(list, /\$\{esc\(chapterWhen\(ch\)\)\}/, '最近档下不显示日期，作者没法核对这一排到底是不是最近');
  const scope = js.match(/\nfunction chapterSortOf\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(scope, 'app.js 里抠不出 chapterSortOf');
  assert.match(scope, /novelId !== key/, '换书不回到章号档，会拿着上一本的「最近编辑」来看这一本');
  assert.equal((js.match(/recent:\s*true/g) || []).length, 0, '除了这一档的开关，别处不许点最近编辑 —— nextOrder 与装配上下文要的是章号');

  const barSrc = js.match(/\nfunction chapterSortBar\([\s\S]*?\n\}/)?.[0];
  assert.ok(barSrc, 'app.js 里抠不出 chapterSortBar');
  const run = (count, recent) => new Function('esc', `${barSrc} return chapterSortBar;`)(NWText.esc)(count, recent);
  const names = (html) => [...html.matchAll(/data-action="([\w-]+)"/g)].map((m) => m[1]).sort();
  const off = (html, action) => new RegExp(`data-action="${action}"[^>]*disabled`).test(html);
  const registered = new Set([...actionsSource(js).matchAll(/^\s+(['"])([\w-]+)\1\s*:/gm)].map((m) => m[2]));

  assert.deepEqual(names(run(3, false)), ['chapter-sort-order', 'chapter-sort-recent'], '切换条上不是那两颗');
  const dead = names(run(3, false)).filter((a) => !registered.has(a));
  assert.deepEqual(dead, [], `这两颗按钮点了没反应：${dead.join('、')}`);
  assert.ok(off(run(3, false), 'chapter-sort-order'), '已经在章号档，那颗按钮还亮着');
  assert.equal(off(run(3, false), 'chapter-sort-recent'), false);
  assert.ok(off(run(3, true), 'chapter-sort-recent'), '已经在最近档，那颗按钮还亮着');
  assert.equal(off(run(3, true), 'chapter-sort-order'), false, run(3, true));
  assert.ok(run(3, true).includes('同一天改的按章号排'), '最近档没说要怎么对待同一天，作者会以为并列是随机');
  assert.equal(run(1, false), '', '只有一章时给切换条是噪音');
  assert.equal(run(0, true), '', '一章都没有，更没有档可切');

  const whenSrc = js.match(/\nfunction chapterWhen\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(whenSrc, 'app.js 里抠不出 chapterWhen');
  const when = new Function(`${whenSrc} return chapterWhen;`)();
  assert.equal(when({ updated_at: null, created_at: null }), '', '两个时间都没有就不显示，别写一个 1970 糊上去');
  assert.ok(when({ updated_at: 1780000000000, created_at: 1700000000000 }).includes('2026'), '最近档要看得见的正是 updated_at');
  assert.ok(when({ updated_at: null, created_at: 1780000000000 }).includes('2026'), '旧行没写过 updated_at，得退回创建时间而不是空着');

  const sortCss = read('src/styles/app.css').match(/\.chapter-sort\s*\{[^}]*\}/)?.[0] || '';
  assert.ok(sortCss, 'app.css 里找不到 .chapter-sort 这条规则');
  assert.match(sortCss, /position:\s*sticky/, '#sidebar-content 整体在滚：切换条不贴顶常驻，滚到第 30 章就看不见当前是哪一档、也切不回去');
  assert.match(sortCss, /top:\s*0/);
  assert.doesNotMatch(sortCss, /--bg-input/, '这条压在章节行上面，半透明的底挡不住底下滚过的行');
  assert.match(read('src/styles/app.css'), /\.chapter-item-when\s*\{/, '日期那一格没有样式，会把行挤歪');
});

/**
 * 工作流预设（V 批）。这一族的风险与别处不同：预设是**别人写的设置**，
 * 界面一旦自己认值、自己拼补丁、自己写文件名，core 那份闸就变成一句摆设 ——
 * 于是「分享者关掉了两组禁词」与「接收者以为已经生效」可以同时对不上。
 * 四条守卫各盯一面：清单只有一处、补丁只由 core 算、外部形状声明与代码同数、假 DOM 下真画得出行。
 */
const wfFns = () => {
  const js = read('src/app.js');
  const pick = (name, async_) =>
    js.match(new RegExp(`\\n${async_ ? 'async ' : ''}function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] || '';
  const fns = {
    panel: pick('showWorkflowPanel', true),
    rows: pick('workflowRows'),
    apply: pick('showWorkflowApplyModal'),
    imported: pick('workflowImportPreset', true),
    builtin: pick('workflowApplyBuiltin'),
    exporter: pick('showWorkflowExportModal'),
    notShared: pick('workflowNotShared'),
  };
  const missing = Object.entries(fns).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(missing, [], `app.js 里抠不出工作流的这些函数：${missing.join('、')}（守卫的形状变了）`);
  return { js, all: Object.values(fns).join('\n'), ...fns };
};

test('哪几格算工作流只有 NWWorkflow 一处清单，界面不写第二份', () => {
  const { js, all } = wfFns();
  assert.match(all, /NWWorkflow\.FIELDS/, '格名清单不是 core 给的，加一格就得改两个文件');
  assert.match(all, /NWWorkflow\.BUILTINS/, '随货预设不是 core 给的，内置就变成界面自己编的');
  assert.match(all, /NWWorkflow\.NOT_SHARED/, '「为什么不共享基准章」那句是界面自己写的，两处会各说各的');
  assert.match(all, /NWWorkflow\.fileName\(/, '导出的文件名不是 core 那一个出处，界面与 CLI 就会导出两种名字');
  // 界面既不认值也不认键：这四类字面量一旦出现，就是第二份判据
  for (const banned of ['target_words', 'styleAnchor', 'stylePack', "'long'", "'short'"]) {
    assert.equal(all.includes(banned), false, `界面里出现了「${banned}」—— 这一格的认法住在 NWWorkflow，不在这里`);
  }
  assert.equal(js.includes('novelweave-workflow-'), false, '文件名前缀是 core 的 fileName 给的，抄第二份就会导出两种名字');
  for (const b of NWWorkflow.BUILTINS) {
    assert.equal(js.includes(b.name), false, `内置预设名「${b.name}」被抄进了界面`);
  }
  assert.match(js, /workflow:\s*showWorkflowPanel,/, '页签在 TABS 里而面板没挂上：这一点就是「切到章节去了」');
});

test('预设写库只交 core 算出来的补丁，且过完闸才谈应用', () => {
  const { all, apply, imported, builtin } = wfFns();
  assert.match(all, /NWWorkflow\.patchOf\(APP\.novel, n\.fields\)/, '不是整句就是第二份字段清单 —— 写死一格也照样能过');
  assert.match(apply, /NWWorkflow\.diffFields\(APP\.novel, n\.fields\)/, '「会不会变」是界面自己比的，core 那个 changed 成了摆设');
  assert.equal(apply.includes('r.changed'), true, '确认框得按 core 的 changed 说话');
  for (const [name, src] of [['导入', imported], ['内置', builtin]]) {
    assert.match(src, /if \(!n\.ok\)/, `${name}那一路没看过闸就把 fields 交出去，坏预设会被应用半份`);
  }
  assert.doesNotMatch(all, /novels\.update\(APP\.novel\.id, \{\s*(?:format|target_words|stylePack)/, '手挑字段写库：core 的 changed 判定就被绕过了');
  assert.doesNotMatch(all, /\.filter\(\(r\) => r\.key ===/, '界面按格名自己筛一遍，等于不信任 diffFields');
  assert.doesNotMatch(all, /style="color/, '箭头那抹红是几何，该住 app.css，不该内联在拼串里');
  // 箭头是「这一格会写进库」的记号。core 说落不下的那一格不许借用它：画了箭头又没写，
  // 与「说已落地其实没接通」是同一件事，而且这回连「没接通」都看不出来。
  const bIdx = apply.indexOf('r.blocked ?');
  const cIdx = apply.indexOf(': r.changed ? ` → <b>');
  assert.ok(bIdx !== -1, '界面对 core 报的「落不下」没有反应，那一格会被画成要改');
  assert.ok(cIdx !== -1 && bIdx < cIdx, '箭头那一支要排在「落不下」之后，否则落不下的那一格照样画箭头');
  // 那一格不能只画一句「预设要的是 X」：原因也得在场，否则作者只看到「要 5000 字」，不知道为什么要不上
  assert.match(apply, /\$\{esc\(r\.blocked\)\}/, '确认框没把 core 那句原因画出来，落不下就成了没头没尾的一句话');
  // 「没动」的两种原因也要说得分开：本来就是这套 / 这一格在这本书里落不下
  assert.match(apply, /blocked\.length \? `一格都没动：\$\{blocked\[0\]\.blocked\}`/, '落不下却被报成「已经就是这套工作流」，作者以为不用改了');
  // 反方向那一格（换长篇时要清掉的字数目标）由 core 的 changed 带着走箭头，
  // 界面要是为它另开一支，就是第二份「这一格会不会写库」的判断。
  assert.equal(apply.includes('clears'), false, '界面自己认了「清掉」这一类行，core 那份 changed 就不再是唯一的口径');
});

test('两份 schema 与建书弹窗都对着 core 那几个数，谁改了另一个人就得红', () => {
  const wf = JSON.parse(readFileSync(repoPath('schemas', 'workflow.v1.json'), 'utf8'));
  const bible = JSON.parse(readFileSync(repoPath('schemas', 'story-bible.v1.json'), 'utf8'));
  assert.deepEqual(Object.keys(wf.$defs.fields.properties).sort(), [...NWWorkflow.FIELDS].sort(),
    'schema 里的可分享格与 NWWorkflow.FIELDS 不是同一份清单');
  assert.equal(wf.additionalProperties, false, '顶层放开未知键：一份带新阶设置的文件过了 schema、却被 core 拒收，两处口径就分家了');
  assert.equal(wf.$defs.fields.additionalProperties, false, 'schema 允许未知键，就等于承认「认不出的键照用半份」');
  assert.equal(wf.$defs.fields.properties.stylePack.additionalProperties, false, '规则包子键放开未知键，core 那句「认不出的子键」就成了一句话');
  assert.deepEqual(wf.properties.version.enum, [NWWorkflow.FILE_VERSION]);
  assert.deepEqual([...wf.$defs.fields.properties.format.enum].sort(), [...NWWorkflow.FORMATS].sort());
  assert.equal(wf.$defs.fields.properties.target_words.minimum, NWWorkflow.TARGET_MIN,
    '预设的下限与书存档的下限是同一个数，两处不同就会出现「导得出去、进不来」');
  assert.equal(bible.$defs.book.properties.target_words.minimum, NWWorkflow.TARGET_MIN,
    'book 那一份的下限变了，预设这边也得跟着变');
  assert.deepEqual([...bible.$defs.book.properties.format.enum].sort(), [...NWWorkflow.FORMATS].sort());
  // 界面上填得出的篇幅档，就是 core 认的那几个值
  const sel = read('src/app.js').match(/<select[^>]*id="inp-novel-format"[\s\S]*?<\/select>/)?.[0] || '';
  assert.ok(sel, '建书弹窗里没有篇幅档那个下拉，这条守卫的形状变了');
  const opts = [...sel.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(opts, [...NWWorkflow.FORMATS].sort(), '下拉里的档位与 NWWorkflow.FORMATS 对不上：预设会被自己的界面判成坏值');
});

test('假 DOM 下 workflowRows 真画得出行，多的那一格不许出现', () => {
  const { rows } = wfFns();
  const run = new Function('esc', `${rows} return workflowRows;`)(NWText.esc);
  const html = run({ format: 'short', target_words: 8000, stylePack: { enabled: true, disabled: ['aphorism'], extraBanned: [] } });
  assert.deepEqual([...html.matchAll(/class="workflow-row"/g)].length, NWWorkflow.FIELDS.length, '行数不是三格');
  assert.equal(html.indexOf('篇幅档') < html.indexOf('全篇字数目标'), true, html);
  assert.ok(html.includes('8000 字'), html);
  assert.ok(html.includes('关掉 1 组：段尾金句'), html);
  // 不该画的别画：预设没带的格给一句「没设」，混进来的外来键一行都不许出现
  const sparse = run({ format: 'long' });
  assert.equal(sparse.includes('全篇字数目标'), true, '三格都得有一行，作者要知道哪格没设');
  assert.ok(sparse.includes(NWWorkflow.valueText('target_words', undefined)), sparse);
  assert.equal(sparse.includes('ch_7'), false, '把 styleAnchor 之类的外来键画进来了');
  const css = read('src/styles/app.css');
  for (const cls of ['workflow-row', 'workflow-row-label', 'workflow-row-value', 'workflow-preset', 'workflow-bar', 'workflow-reasons']) {
    assert.match(css, new RegExp(`\\.${cls}\\s*\\{`), `.workflow 系「${cls}」没有样式，行会被挤歪`);
  }
  assert.match(css, /\.workflow-row\.is-changed \.workflow-row-value b\s*\{/, '变了的那一格没有颜色，作者看不出要改的是哪几行');
});

test('nw-workflow.mjs 只搬运 core 的判据，而且它只看不改', () => {
  const cli = read('scripts/nw-workflow.mjs');
  assert.match(cli, /NWWorkflow\.FIELDS\.map/, '可分享的格不是现取的，加一格 CLI 就少一格');
  assert.match(cli, /NWWorkflow\.TARGET_MIN/, 'CLI 自己写一份下限，两处就会各判各的');
  assert.match(cli, /NWWorkflow\.NOT_SHARED/, '「为什么不共享基准章」那句变成 CLI 自己编的第二份');
  assert.match(cli, /NWWorkflow\.pack\(input\.book/, '打包不是 core 那个 pack，导出的形状就会与过闸的口径分家');
  assert.match(cli, /NWWorkflow\.normalize\(preset\)/, '打完不自检一遍，「导得出去、进不来」就没人看得见');
  assert.match(cli, /NWWorkflow\.diffFields\(input\.book, n\.fields\)/, '「会改哪几格」是 CLI 自己比的，与界面那张框就不是同一个答案');
  assert.match(cli, /NWWorkflow\.fileName\(/, '文件名前缀是 core 给的，抄第二份就会导出两种名字');
  // 那个下限只有一个出处：CLI 要念出来，也只能从 core 念
  assert.equal(cli.includes(String(NWWorkflow.TARGET_MIN)), false, 'CLI 里出现了裸数字，它就是第二份下限');
  // 只看不改：写库那一路要逐格确认，命令行没有作者的点头
  assert.doesNotMatch(cli, /book\.json/, 'CLI 直接写书存档：那张逐格确认框就被绕过去了');
  assert.doesNotMatch(cli, /novels\.update|writeJsonAtomic\(path\.join\(bookDir/, 'CLI 落盘到某本书，退出码再对也是先斩后奏');
  // 坏预设不许配一张逐格清单：读的人只记得住清单
  assert.match(cli, /n\.ok && input \? NWWorkflow\.diffFields/, '过不了闸也照样列「会改这两格」，原因就是没人看了');
  assert.match(cli, /blockedRows\.length/, '落不下那一格被报成「已经就是这套工作流」，作者以为不用管了');
  // 那句「已经就是这套」必须有逐格清单当依据：预设没过闸、或根本没有对照的书时，
  // 它凭什么说这本书是对的
  assert.match(cli, /const noneLine = !rows \? ''/, '没有逐格清单也照样输出「一格都不用改」');
  // 反方向那一格：它会被清走，所以不许出现在「你书里那几格照旧」里
  assert.match(cli, /!clearing\.has\(k\)/, '一句「照旧」配一行「要清掉」，读的人只会记住一句，而两句是相反的');
});

test('工作流预设这条路在技能文档里找得到，文档里的数不出自文档自己', () => {
  const skill = read('skills/novelweave/SKILL.md');
  assert.match(skill, /nw-workflow\.mjs check/, 'SKILL.md 没点这份 CLI，agent 手上就只有网页那一条路');
  assert.match(skill, /nw-workflow\.mjs pack/, '分享的那一半（从磁盘上的书打包）没人写');
  assert.match(skill, /references\/workflow-preset\.md/, '预设文件的形状没有参考文档，读到外来预设就只能猜');
  assert.match(skill, /只看不改/, '文档没交代 CLI 不写库，agent 会以为 check 就把它应用了');
  const ref = read('skills/novelweave/references/workflow-preset.md');
  assert.ok(ref.includes(NWWorkflow.NOT_SHARED[0].why), '为什么不共享基准章那句要出自 core，不是文档自己另写一遍');
  assert.equal(ref.includes(String(NWWorkflow.TARGET_MIN)), false, '文档写死了下限，core 一改它就悄悄过期');
  assert.match(ref, /book\.target_words\.minimum/, '下限要指向那一个出处');
  assert.match(ref, /`clears`/, '文档只写了「落不下」那一面，反方向（换长篇时清掉目标）没人说，读到「照旧」的人会以为那个数还在');
  assert.match(read('README.md'), /schemas\/workflow\.v1\.json/, 'README 的格式定义少了一份对外格式，作者与 agent 都不知道有它');
  assert.match(read('schemas/workflow.v1.json'), /src\/core\/workflow\.js/, 'schema 没说判据在哪，读到它的人只会去猜另一份实现');
});

// ═══════════════ W 族：单章字数那一份数字 ═══════════════

test('单章字数那三个数只写在 tension.js：数组字面量不许有第二处', () => {
  // 「3000-5000 / 1200-4000 / 界面另一档」写过三遍的代价是：模型照 prompt 的上限写满，
  // 机检按另一档报它超上限，两边各自的测试都绿。现在数字只有一个家。
  const files = [...readdirSync(repoPath('src/core')).filter((f) => f.endsWith('.js')).map((f) => `src/core/${f}`),
    'src/app.js',
    ...readdirSync(repoPath('scripts')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`)];
  const re = /\[\s*1200\s*,\s*4000\s*\]|\[\s*400\s*,\s*(?:4000|null)\s*\]/;
  const hits = files.filter((f) => f !== 'src/core/tension.js' && re.test(read(f)));
  assert.deepEqual(hits, [], `这几份文件里抄了字数区间：${hits.join('、')}`);
  assert.deepEqual(NWTension.CHAPTER_RANGE, { long: [1200, 4000], short: [400, null] },
    '改了档位就得把这条与它的下游（prompt / R35 / 评分卡）一起改口');
  assert.equal(NWTension.CHAPTER_RANGE.short[1], null,
    '短篇这一档的上限必须是 null：界面自己承诺「微型 6k 字 1 章」「盐选 5 万 / 6-10 章」，写个数就是天天报作者照着向导选的规划');
});

test('规则里不许有第二份「算不算短篇」，也不许有第二份评审门槛', () => {
  const rules = read('src/core/rules.js');
  assert.doesNotMatch(rules, /format\s*===\s*'short'/,
    '换挡判断在规则里再写一遍，就会出现「R23 按短篇档、R17 按长篇档」这种同书两档');
  assert.doesNotMatch(rules, /isShort\s*\?\s*\d+\s*:\s*\d+/, '门槛数字抄进规则就与 QUOTAS 分家');
  assert.doesNotMatch(rules, /body\.length\s*<\s*\w*[Mm]in/,
    '按字符数评门槛会把标点算成字，对话密的章被凭空抬进评审');
  assert.match(rules, /const isShort = Tension\.isShort\(ctx\.book\);/);
  assert.match(rules, /if \(T\.countWords\(body\) < q\.minBody\) continue;/);
  assert.match(rules, /const \[lo, hi\] = Tension\.chapterRange\(ctx\.book\);/);
  assert.match(rules, /hi != null && words > hi/, '上限可能是 null（短篇不封顶），直接比较会把 null 当 0 判成超标');
  // 动笔前那句承诺是这一串判据的上游：它一旦写死数字，模型照它写满、机检照另一档报超标，
  // 两条测试各绿各的。
  const llm = read('src/core/llm.js');
  assert.match(llm, /const \[lo, hi\] = Tension\.chapterRange\(book\);/,
    'prompt 那句字数要求没问同一份区间');
  assert.doesNotMatch(llm, /单章正文 \d/, '字数直接写在 prompt 里就是第三份区间');
});

test('评分卡那份区间与 core 是同一个对象：别名可以，抄表不行', () => {
  // CLI 的人读文案念的是 NWPitch.LENGTH_RANGE；它一旦是另拼的一份字面量，
  // 「评分卡说合理、机检说超长」就回来了。
  assert.equal(NWPitch.LENGTH_RANGE, NWTension.CHAPTER_RANGE, '不是同一个对象就是抄了一份');
  assert.doesNotMatch(read('src/core/pitch.js'), /LENGTH_RANGE\[/,
    '拿别名自己按 format 挑档，就是在 core 的换挡之外另算一遍');
  assert.match(read('src/core/pitch.js'), /Tension\.chapterRange\(\{ format: v\.format \}\)/);
});

test('两份文档里那句单章区间跟着 core 走，不写自己的数', () => {
  const R = NWTension.CHAPTER_RANGE;
  const long = NWTension.rangeLabel('long').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const short = NWTension.rangeLabel('short').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const doc = read('skills/novelweave-continuity/references/rules.md');
  assert.match(doc, new RegExp(`长篇那一档 ${long}；短篇那一档 ${short}`),
    'rules.md 里那句区间与 core 那份不是同一个数（或话术没跟着 rangeLabel 走）');
  assert.ok(NWPitch.LENGTH_LABEL.short === NWTension.rangeLabel('short')
    && NWPitch.LENGTH_LABEL.long === NWTension.rangeLabel('long'),
    '评分卡那份话术不是从 CHAPTER_RANGE 算出来的');
  const card = read('skills/novelweave/references/pitch-card.md');
  assert.match(card, new RegExp(`long: \\[${R.long[0]}, ${R.long[1]}\\], short: \\[${R.short[0]}, ${R.short[1]}\\]`),
    'pitch-card.md 写死了自己的档位数字');
});

// ═══════════════ X 族：篇幅档那一格 ═══════════════

const X_CODE = (() => {
  const list = [];
  const walk = (d) => {
    for (const e of readdirSync(repoPath(d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) list.push(p);
    }
  };
  ['src', 'scripts', 'tools'].forEach(walk);
  return list.filter((f) => f !== 'src/core/tension.js');
})();

test('「认不出算长篇」与「这本书算不算短篇」只写在 tension.js：全仓扫第二处', () => {
  // X 之前这一格在 19 处各归一遍：九处手写那个三元、九处直接比字面量、CLI 再认一遍档一处。它们当时恰好同义，
  // 所以没出事；这一条守的是下一处 —— 19 份抄本里改一份，规则与桥两头就会各认一档。
  const ternary = X_CODE.filter((f) => /'short'\s*:\s*'long'/.test(read(f)));
  assert.deepEqual(ternary, [], `换挡的三元表达式有了第二处：${ternary.join('、')}`);
  const cmp = X_CODE.filter((f) => /\.format\s*[!=]==\s*'short'/.test(read(f)));
  assert.deepEqual(cmp, [], `还在拿原始 format 跟 'short' 比字面量：${cmp.join('、')}`);
  const copy = X_CODE.filter((f) => /\[\s*'?(?:short|long)'?\s*,\s*'?(?:short|long)'?\s*\]/.test(read(f)));
  assert.deepEqual(copy, [], `档位清单被另抄了一遍：${copy.join('、')}`);
});

test('档位清单那一份只有一个家：workflow 引它，缺档必须落在清单里', () => {
  assert.equal(NWWorkflow.FORMATS, NWTension.FORMATS, '不是同一个数组就是抄了一份清单：加一档时预设闸与评分卡会各认一半');
  assert.deepEqual([...NWTension.FORMATS].sort(), ['long', 'short'],
    '这一格只有两个值；要添第三档，得先把每一路的换挡落点一起想清楚');
  assert.ok(NWTension.FORMATS.includes(NWTension.DEFAULT_FORMAT), '归一的落点不在清单里：脏值会变成一个谁都认不出的档');
  assert.equal(NWTension.DEFAULT_FORMAT, 'long', '缺档改成短篇等于把所有没写档的老书一起换档');
});

test('界面不许用「不等于长篇」代替「等于短篇」', () => {
  // 改之前界面那五处比的也是 'short'（脏值按长篇，与规则一致），这一条守的是别改口：
  // 界面读的是库行原值，谁写成「不是 long」（干净数据上等价、还少打两个字），'zhong' 就会
  // 让时间线与状态矩阵两栏凭空消失，而同一本书在规则那边还是长篇。
  const app = read('src/app.js');
  assert.doesNotMatch(app, /\.format\s*[!=]==\s*'long'/, '脏档会被当成短篇，这一句要换成 NWTension.isShort(…)');
  assert.equal((app.match(/NWTension\.isShort\(/g) || []).length, 4,
    '书封、短篇标记、侧栏折叠、连续生成各一处（目标进度条那一处 Y 起改问 targetOf，它连档带数一起答）；'
    + '多一处少一处都先说清是哪一路');
});

test('每一条路都过同一句归一：落库、列表投影、导出、建上下文、预设打包', () => {
  const db = read('src/core/db.js');
  assert.match(db, /const fmt = NWTension\.formatKey\(format\);/, '建档那一路没归一，脏档先进了库');
  assert.match(db, /format: NWTension\.formatKey\(n\.format\)/, '列表不投影，界面就照脏档换挡');
  assert.match(read('src/core/project.js'), /format: Tension\.formatKey\(ctx\.book\.format\)/,
    '导出跟着库行原值走，脏档就出了门，下一本书从导入开始带着它');
  const story = read('src/core/story.js');
  assert.match(story, /const format = Tension\.formatKey\(b\.format\);/, '导入建档没归一');
  assert.match(story, /format: Tension\.formatKey\(rows\.novel\.format\)/, 'buildCtx 没归一，规则与上下文就各拿原始值比');
  assert.equal((read('src/core/context.js').match(/const isShort = Tension\.isShort\(ctx\.book\);/g) || []).length, 2,
    '分层前情与上下文分段各判一次档：短篇就会一边喂卷、一边不召回旧章');
  // 这两处各有行为测试盯着，但行为测试只挑得出「打过一本脏档的书」那种差异，
  // 而脏档书在测试与真实使用里都少见 —— 句子本身也钉住。
  assert.match(read('src/core/workflow.js'), /const fields = \{ format: Tension\.fmtOf\(b\) \};/,
    '预设打包那一路不再问归一，脏档会被装进预设里');
  assert.match(read('src/core/pitch.js'), /format: Tension\.minFormat\(\[book, src\]\),/,
    '评分卡不再把本书与梗概/对照书一起算档');
});

test('打包与对照那两份逐格文案各只有一处：pack 不许手拼「格名：当前值」', () => {
  // 以前 pack 自己拼了一遍「这一格现在写着什么」，于是长篇库里那个遗留字数目标被报成
  // 「全篇字数目标：8000 字」，而打出来的预设根本没有这一格 —— 面板说的与库里做的两样。
  const cli = read('scripts/nw-workflow.mjs');
  assert.match(cli, /\.\.\.NWWorkflow\.diffFields\(input\.book, preset\.fields\)\.map\(rowLine\)/,
    '打包那一路不再问 core 的逐格 diff，就会把「现在写着什么」说成「预设带了什么」');
  assert.equal((cli.match(/FIELD_LABEL\[\w+\]\}：/g) || []).length, 0, 'CLI 里手拼了一遍格名，等于有了第二份逐格文案');
  assert.equal((cli.match(/const rowLine = /g) || []).length, 1, '一行格的画法出现两处，pack 与 check 就会各说各的');
});

test('R35 那句档名跟在归一后面；CLI 与技能文档的档位清单跟在 FORMATS 后面', () => {
  const rules = read('src/core/rules.js');
  assert.match(rules, /const fmt = Tension\.fmtOf\(ctx\.book\);/, 'R35 的档名是从没归一的值来的');
  assert.match(rules, /本书按\$\{zh\}那一档 \$\{Tension\.rangeLabel\(fmt\)\}/,
    '机检报的那句区间不是 core 那份，评分卡与机检就又会各说一个数');
  const needle = `--format ${NWTension.FORMATS.join('|')}`;
  const cli = read('scripts/nw-pitch.mjs');
  assert.equal(cli.split(needle).length - 1, 2, '注释里那句用法与报错文案对不上，或清单不是从 FORMATS 算的');
  assert.ok(read('skills/novelweave/references/pitch-card.md').includes(needle),
    'pitch-card.md 的 --format 参数说明不跟 FORMATS 走');
  assert.match(cli, /NWTension\.FORMATS\.includes\(fmtWanted\)/, 'CLI 认档不认清单，脏值会被当成一档去评分');
});

test('三份文档都点名 core 那个出处，不各留一份规矩', () => {
  const schema = read('skills/novelweave/references/schema-v1.md');
  assert.match(schema, /归一那一句是 `NWTension\.formatKey`/, 'schema 文档没点名归一那一句，读者只能按字面猜');
  assert.doesNotMatch(schema, /别让读的一方猜|必须显式写 `"long"`/,
    '旧话术还在教人「别让读的一方猜」，而 core 已经明写了缺档落哪一档');
  const wf = read('skills/novelweave/references/workflow-preset.md');
  assert.match(wf, /`NWTension\.FORMATS`/, '预设文档没点名档位清单的出处，加一档时它会被改成第二份清单');
  assert.match(wf, /预设\*\*里写一个认不出的档，过闸当场判坏/, '文档没分清「预设拒绝」与「书归一」两种规矩');
  assert.match(wf, /`NWTension\.formatKey` 归成长篇/);
  const rules = read('skills/novelweave-continuity/references/rules.md');
  assert.match(rules, /## X 族：篇幅档那一格/, '换挡的共用前提没有规格段，W 那句「都从 isShort 走」就没人核对');
  assert.match(rules, /不 trim、不改大小写、不猜/);
  assert.match(rules, /行为变化只有两处可见/, '改了行为不写下来，下一批就会把差异当遗留');
  assert.match(rules, /`nw-workflow\.mjs pack` 的人读输出/, 'pack 那一行的改口没记进规格，读文档的人会以为预设带着遗留目标');
});

// ═══════════════ Y 族：这一档有没有字数目标那一格 ═══════════════

test('「这个数算不算一个目标」与「这一档有没有那一格」各只有一句：全仓扫第二处', () => {
  // X 之前那一句换挡在 19 处各归一遍；这一格更安静 —— 建档按「非空就算」存、打包按「≥ 下限」读、
  // 评分卡拿原值就算，三处自认为说的是同一句话，于是同一个数在界面是「没设」、在这张卡是「目标 8000 字」。
  const second = (re, why) => {
    const hits = X_CODE.filter((f) => f !== 'src/core/tension.js' && re.test(read(f)));
    assert.deepEqual(hits, [], `${why}：${hits.join('、')}`);
  };
  second(/TARGET_MIN\s*=\s*\d/, '下限被另写成一个字面量');
  second(/[<>]=?\s*(?:Tension\.)?TARGET_MIN/, '有人在自己这边比这个下限');
  second(/Number\.isInteger\([^)]*target/i, '「得是整数」那一句被抄了第二遍');
  second(/isShort\([^)]*\)\s*&&[^&]*target/i, '问过档之后又自己判一次「这一档有没有目标」');
  second(/\.target_words\s*(?:\|\||\?|\s*>=\s*)/, '拿库行原值判有没有目标：这三处各判各的就是这么开始的');
});

test('目标那一格的六个读写点各自点名 core 那一句，绕过它就要说清是哪一路', () => {
  const n = (f, re) => (read(f).match(new RegExp(re.source, 'g')) || []).length;
  assert.equal(n('src/core/db.js', /Tension\.targetOf\(/), 1, '建档那一格不再问 core，库里就会存进这一档不该有的数');
  assert.equal(n('src/core/story.js', /Tension\.targetOf\(/), 2, '导入建档与装配 ctx 各一处：少一处就是桥的一头不判');
  assert.equal(n('src/app.js', /NWTension\.targetOf\(/), 1, '进度条那一处改读原值就是第二份判据');
  assert.equal(n('src/core/pitch.js', /Tension\.targetOf\(/), 1, '评分卡的 ctx 那一头不再问这一句，就会按遗留数给分');
  assert.equal(n('src/core/workflow.js', /Tension\.targetOf\(/), 1, '打包那一处');
  // 这两处问的都是与档无关的那一句：一处判这份文件写的数，一处判库里还躺着那个数没有
  assert.equal(n('src/core/workflow.js', /Tension\.targetValue\(/), 2, '过闸与逐格 diff 各一处');
  // 评分卡的 concept 那一头读的是「作者当场打算写多少」，不是库里那一格，所以它不归 targetOf 管
  assert.match(read('src/core/pitch.js'), /isCtx \? Tension\.targetOf\(book\) : Number\(src\.targetWords \?\? src\.target_words\)/,
    '两种入参混成一句：要么把长篇的规划数判死，要么把库里的遗留数当目标用');
});

test('下限只有一个数：workflow 那份是别名，schema 与 CLI 念的都是它', () => {
  assert.equal(NWWorkflow.TARGET_MIN, NWTension.TARGET_MIN,
    '不是同一个数就是抄了一遍下限：core 一改，预设那道闸还在按旧的拦');
  assert.equal(NWTension.TARGET_MIN, 1000, '这个数一改，两份 schema 的 minimum 与全部夹具都要跟着想清楚');
  assert.match(read('scripts/nw-workflow.mjs'), /NWWorkflow\.TARGET_MIN/, 'CLI 自己写一份下限');
});

test('Y 的规格写进了文档，且点名 core 那两句', () => {
  const rules = read('skills/novelweave-continuity/references/rules.md');
  assert.match(rules, /## Y 族：这一档有没有字数目标/, '换挡的共用前提只写了档，没写「这一档有没有那一格」');
  assert.match(rules, /`NWTension\.targetOf\(?/, '打包那一句的出处没点名，加一档时它会跟着抄一份门槛');
  assert.match(rules, /`NWTension\.targetValue\(?/, '两处与档无关的判据没点名出处，就会长成第三份「算不算设过」');
  const wf = read('skills/novelweave/references/workflow-preset.md');
  assert.match(wf, /`NWTension\.targetOf`/, '预设文档没点名打包那一句，加一档时它会跟着抄一份门槛');
  const schema = read('skills/novelweave/references/schema-v1.md');
  assert.match(schema, /`NWTension\.TARGET_MIN`/, 'schema 文档里的下限没点名出处');
});

// ═══════════════ Z 族：那一档对人叫什么 ═══════════════

test('档名只有一个说法：src、scripts、schemas 里不许再出现「长篇连载」，也不许手抄档名三元', () => {
  const files = ['src/core/tension.js', 'src/core/workflow.js', 'src/core/rules.js', 'src/core/llm.js',
    'src/core/pitch.js', 'src/core/context.js', 'src/core/project.js', 'src/core/story.js', 'src/core/db.js',
    'src/core/stylepack.js', 'src/core/volumes.js', 'src/core/relationgraph.js', 'src/core/statescope.js',
    'src/core/stylefit.js', 'src/core/text.js', 'src/app.js', 'src/demo.js',
    'scripts/nw-workflow.mjs', 'scripts/nw-pitch.mjs', 'scripts/nw-continuity.mjs', 'scripts/nw-context.mjs',
    'scripts/nw-validate.mjs', 'scripts/nw-style.mjs', 'scripts/nw-prose.mjs', 'scripts/nw-io.mjs', 'scripts/nw-changes.mjs',
    'schemas/story-bible.v1.json', 'schemas/workflow.v1.json'];
  // README 那句「长篇连载与短篇」是产品宣传语，不是某一本书的档名，刻意不在扫描范围里。
  const hits = files.filter((f) => /长篇连载/.test(read(f)));
  assert.deepEqual(hits, [], `同一档三个名字就是这么长回来的（FORMAT_LABEL 一个、R35 一个、schema 一个）：${hits.join('、')}`);
  const ternary = files.filter((f) => f !== 'src/core/tension.js'
    && /['"]短篇['"]\s*:\s*['"]长篇['"]|['"]长篇['"]\s*:\s*['"]短篇['"]/.test(read(f)));
  assert.deepEqual(ternary, [], `档名话术被抄了第二份（X 之前九处换挡的表亲）：${ternary.join('、')}`);
});

test('读档名的四处各自点名 core 那张表，绕过它就是让同一本书换一个名字', () => {
  const n = (f, re) => (read(f).match(new RegExp(re.source, 'g')) || []).length;
  const wf = read('src/core/workflow.js');
  assert.equal(n('src/core/rules.js', /Tension\.formatLabel\(/), 1, 'R35 那一句的 zh 不许再自己写三元');
  assert.equal(n('src/core/workflow.js', /Tension\.formatLabel/), 1, '工作流那份必须是指向 core 的别名，不许自起一份');
  assert.match(wf, /return formatLabel\(v\);/, '逐格 diff 的 format 行不许 String(v) 原样回显脏值');
  assert.equal(n('src/app.js', /NWTension\.formatLabel\(/), 3, '书封标记一枚 + 建档下拉两个 option，全在 core 那张表上');
  assert.doesNotMatch(wf, /FORMAT_LABEL\s*=/, '工作流不许再有自己的话术表 —— 别名也不行，那是第二份表的第一步');
});

test('schema 的 format description 与 core 那张表说的是同一对名字（改名字要连声明一起改）', () => {
  const schema = JSON.parse(read('schemas/story-bible.v1.json'));
  const desc = schema.$defs.book.properties.format.description;
  assert.ok(desc.includes(NWTension.FORMAT_LABEL.long), 'description 必须含 core 的长篇档名');
  assert.ok(desc.includes(NWTension.FORMAT_LABEL.short), 'description 必须含 core 的短篇档名');
});

test('「题材不限」那一路不许再把档名塞进 genre 这一格', () => {
  // 短篇/长篇向导都曾把档名写进题材表 —— 档名有自己的家（FORMAT_LABEL），genre 是另一张表。
  assert.doesNotMatch(read('src/app.js'), /'不限's*?s*'(短篇|长篇)'/,
    'genre 存档名，书卡与评分卡就会把档当成题材念出来');
});

test('Z 的规格写进了文档并点名 formatLabel', () => {
  assert.match(read('skills/novelweave-continuity/references/rules.md'), /`NWTension\.formatLabel\(?/,
    '档名话术的出处没点名，下一个界面就会照旧手抄');
  assert.match(read('skills/novelweave/references/workflow-preset.md'), /`NWTension\.formatLabel\(?/,
    '预设那份文档还在念旧名');
});
