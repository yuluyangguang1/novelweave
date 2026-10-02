import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot } from './_load.mjs';
import { parseTokens, normalizeValue, check, resolveSite, render, KNOWN_DRIFT } from '../tools/check-tokens.mjs';

const TOOL = path.join(repoRoot, 'tools', 'check-tokens.mjs');

/**
 * 夹具一律自带已知漂移表（NONE 或 bespoke）：仓库那张表讲的是真文件那三处，
 * 夹具碰上同名令牌就会被牵动 —— --warn-soft 既是夹具名也是表里的键。
 */
const NONE = [];

const appOf = (v) => `:root { --pad: ${v}; }`;
const siteOf = (v) => `:root{--pad:${v}}`;

test('令牌只从根作用域收：写在 .card 里的自定义属性不是设计令牌', () => {
  const got = parseTokens(`:root { --a: 1; }\n.card { --b: 2; }\n[data-theme="light"] { --c: 3; }`).map((t) => t.name);
  assert.deepEqual(got, ['--a', '--c'], '收进了组件作用域，等于把局部覆盖当全局令牌比，处处是假漂移');
});

test('最后一条声明不写分号也得收到 —— CSS 允许这么写，漏了就等于那枚令牌没人比', () => {
  assert.deepEqual(parseTokens(':root { --a: 1; --b: 2 }').map((t) => [t.name, t.value]), [['--a', '1'], ['--b', '2']]);
});

test('配色媒体查询算浅色档，不是响应式覆盖：那份 :root:not 里的令牌照样进比对', () => {
  const got = parseTokens(`@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--x:2}}`)[0];
  assert.equal(got.theme, 'light', '没归到浅色档，浅色那一份就没人比了');
  assert.equal(got.scope, '', '被当成响应式覆盖就退出跨文件比对，浅色档从此瞎');
  const direct = parseTokens(`[data-theme="light"]{--x:2}`)[0];
  assert.equal(direct.theme, 'light', '切主题那一整块没归到浅色档，它和 :root 就成了同名不同值的自相矛盾');
  assert.equal(direct.scope, '', '[data-theme="light"] 不是媒体查询，不该被记成响应式覆盖');
});

test('注释、逗号后的空格、空白折叠都不算漂移', () => {
  assert.equal(normalizeValue('rgb(var(--m) / .12)   /* 淡 */'), 'rgb(var(--m) / .12)');
  assert.deepEqual(check(`:root { --sans: system-ui, -apple-system; }`, `:root{--sans:system-ui,-apple-system}`, NONE).drift, [],
    '字体栈里逗号后有没有空格被当成了配色不同');
});

test('两份同源 CSS 值相同就不报，值不同报出主题与行号', () => {
  const same = check(appOf('64px'), siteOf('64px'), NONE);
  assert.deepEqual(same.drift, [], '一致却报了漂移');
  assert.deepEqual(same.stale, [], '一致不该顺手点亮过期条目检查');
  const diff = check(appOf('40px'), siteOf('64px'), NONE);
  assert.equal(diff.drift.length, 1, '漂了一档没报出来');
  assert.equal(diff.drift[0].key, 'dark:--pad', `漂移没带主题：${diff.drift[0].key}`);
  assert.ok(diff.drift[0].at > 0, '没报出 app.css 那一行的行号，改了不知道改哪');
});

test('深浅两档同名不同值是正当的，不叫漂移', () => {
  const r = check(`:root { --x: 1; }\n[data-theme="light"] { --x: 2; }`, `:root{--x:1}`, NONE);
  assert.deepEqual(r.drift, [], '把「浅色另有一档」报成漂移，以后没人看这条输出');
});

test('同一份 CSS、同一作用域里给同一枚令牌两种值 = 内部不一致', () => {
  const r = check(`:root { --x: 1; }\n:root { --x: 2; }`, `:root{--x:1}`, NONE);
  assert.equal(r.internal.length, 1, '一份文件里自打嘴巴没人报，这类比跨文件漂移更难发现');
  assert.match(r.internal[0].key, /--x/, `报错了令牌：${r.internal[0].key}`);
  assert.equal(r.internal[0].side, 'app.css', '得说清自打嘴巴的是哪一份文件');
});

test('窄屏里重定义令牌是响应式覆盖：不比、不算不一致，只计数', () => {
  const site = `:root{--pad:64px}\n@media(max-width:640px){:root{--pad:40px}}\n@media(max-width:480px){:root{--pad:28px}}`;
  const r = check(appOf('64px'), site, NONE);
  assert.deepEqual(r.drift, [], '基础档一致，响应式覆盖被比进来了');
  assert.deepEqual(r.internal, [], '响应式各档不同值被误判成同作用域自打嘴巴');
  assert.equal(r.responsive.site, 2, '响应式覆盖没计数，那就等于悄悄丢了两枚令牌');
});

test('已知漂移表：值不同才叫认可；两边都有且已经一样了才叫过期', () => {
  const known = [{ key: 'dark:--pad', why: '两用途本来就该不同' }];
  const hit = check(appOf('1'), siteOf('2'), known);
  assert.deepEqual(hit.drift, [], '表里有条目却还报未处理漂移');
  assert.equal(hit.accepted.length, 1);
  assert.ok(hit.accepted[0].why, '认可一条漂移得写理由，「界面就是这样」不算理由');
  assert.deepEqual(hit.stale, [], '还在漂的条目被叫成过期，照着提示把表里这条删了，下次真漂就没门了');
  const stale = check(appOf('1'), siteOf('1'), known);
  assert.equal(stale.stale.length, 1, '已经不漂的条目留着，下次真漂就没人报了');
});

test('表里的令牌整个不见了不叫过期 —— 那走的是单边计数，别一处事情报两遍', () => {
  const known = [{ key: 'dark:--pad', why: '官网把这一枚删了' }];
  const r = check(`:root { --pad: 1; --q: 2; }`, `:root{--q:2}`, known);
  assert.deepEqual(r.stale, [], '不见了不等于不漂，报两条会把真信号淹掉');
  assert.equal(r.only.app, 1, '--pad 成了单边独有，得进那个计数');
});

test('单边独有的令牌只计数，不当漂移', () => {
  const r = check(`:root { --only-app: 1; --both: 1; }`, `:root{--only-site:2;--both:1}`, NONE);
  assert.deepEqual(r.drift, []);
  assert.deepEqual(r.only, { app: 1, site: 1 });
});

test('仓库里那三处已认可漂移今天还漂着，且没有新的未处理漂移', () => {
  const site = resolveSite();
  if (!site) {
    console.log('跳过：本机旁边没有官网 shared.css（单独 clone 的正常状态），这条断言今天没跑到');
    return;
  }
  const r = check(fs.readFileSync(path.join(repoRoot, 'src/styles/app.css'), 'utf8'), fs.readFileSync(site, 'utf8'));
  assert.deepEqual(r.drift, [], `官网令牌漂了新的一档，没人登记：${r.drift.map((d) => d.key).join(' 、')}`);
  assert.deepEqual(r.internal, [], '两份 CSS 里有同一作用域的自打嘴巴');
  assert.deepEqual(r.stale, [], `已知漂移表有过期条目：${r.stale.map((s) => s.key).join(' 、')}`);
  assert.equal(r.accepted.length, KNOWN_DRIFT.length, '认可条目数对不上表，说明有条目根本没被点亮');
  for (const k of KNOWN_DRIFT) assert.ok(k.why && k.why.length > 8, `${k.key} 的认可理由太短，等于没写`);
});

test('退出码：一致 0、有漂移 1，实跑一次确认输出真的打出来了', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-tokens-'));
  try {
    const a = path.join(dir, 'a.css'); const b = path.join(dir, 'b.css');
    fs.writeFileSync(a, appOf('64px')); fs.writeFileSync(b, siteOf('64px'));
    const ok = spawnSync(process.execPath, [TOOL, '--app', a, '--site', b], { encoding: 'utf8' });
    assert.equal(ok.status, 0, `一致却退了 ${ok.status}：${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /未处理漂移 0 条/);
    fs.writeFileSync(a, appOf('40px'));
    const bad = spawnSync(process.execPath, [TOOL, '--app', a, '--site', b], { encoding: 'utf8' });
    assert.equal(bad.status, 1, `漂了一档还是退 ${bad.status}，CI 就看不见`);
    assert.match(bad.stdout, /漂移 dark:--pad/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('没找到对照文件是说 2 而不是说 0 —— 跳过不等于通过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-tokens2-'));
  try {
    const a = path.join(dir, 'a.css');
    fs.writeFileSync(a, appOf('64px'));
    const miss = spawnSync(process.execPath, [TOOL, '--app', a, '--site', path.join(dir, '没有这个文件.css')], { encoding: 'utf8' });
    assert.equal(miss.status, 2, `指错路径退的是 ${miss.status}`);
    assert.match(miss.stderr, /跳过不等于通过/);
    assert.doesNotMatch(miss.stderr, /漂移/, '没比对却开始报漂移');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('开关后面漏了路径就说漏了，不接着往下比', () => {
  for (const flag of ['--site', '--app']) {
    const r = spawnSync(process.execPath, [TOOL, flag], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${flag} 没接路径退的是 ${r.status} —— 接着往下跑就是拿默认那两份比了`);
    assert.match(r.stderr, /后面要接一个路径/);
  }
});

test('不认识的开关就说他不认识，不静默当成布尔位', () => {
  const r = spawnSync(process.execPath, [TOOL, '--only', 'dark'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `未知开关退了 ${r.status}，等于它被当成别的用了`);
  assert.match(r.stderr, /不认识这个开关/);
});

test('输出里每一类都真有一行，小结不说反话', () => {
  const text = render(check(appOf('40px'), siteOf('64px'), NONE)).join('\n');
  assert.match(text, /漂移 dark:--pad/);
  assert.match(text, /未处理漂移 1 条/);
  const stale = render(check(appOf('64px'), siteOf('64px'), [{ key: 'dark:--pad', why: '已经一样了' }])).join('\n');
  assert.match(stale, /已经不漂了/, '过期条目没念出来，表就成了免死金牌');
  assert.match(stale, /过期条目 1 条/);
});

test('--json 的 stdout 是一份完整 JSON：给机器读就不能混中文行', () => {
  const r = spawnSync(process.execPath, [TOOL, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `实跑 --json 退了 ${r.status}：${r.stderr}`);
  let doc = null;
  assert.doesNotThrow(() => { doc = JSON.parse(r.stdout); }, '--json 里混进了给人看的那一行，CI / agent 直接读不动');
  assert.ok(doc.site && fs.existsSync(doc.site), '结果没说清比对的是哪一份 shared.css，「比对了别的文件」这种假绿就没人能查');
});
