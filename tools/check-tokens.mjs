#!/usr/bin/env node
/**
 * check-tokens.mjs —— 设计令牌双源守护。
 *
 * app.css 刻意不引用官网的 /shared.css（引了破坏离线 PWA 与单独 clone），
 * 令牌是照抄一份的。抄的东西会漂，而漂了没人看得见 —— 这个脚本就是那句「跟着改」。
 *
 * 用法：node tools/check-tokens.mjs [--site <shared.css>] [--app <app.css>] [--json]
 * 退出码：0 没有未处理的漂移 / 1 有漂移、内部不一致或过期条目 / 2 没找到对照文件（跳过不算通过）
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 织文以子模块嵌在官网里时，shared.css 就在上一级；本机两份并列检出时是 site-fix 那份。 */
export const SITE_CANDIDATES = ['../shared.css', '../site-fix/shared.css', '../../shared.css'];

/**
 * 已知漂移表。每条都要写 why —— 理由得是「这一枚在两个用途里本来就该不同」，
 * 或者老实登记成待决。漂没了的条目会被报成过期，逼着回来删，免得当免死金牌用。
 */
export const KNOWN_DRIFT = [
  { key: 'dark:--serif', why: '应用单独 clone 时没有官网那份 @font-face，多列一个本地安装名「霞鹜文楷」' },
  { key: 'dark:--ease', why: '应用没有引入官网的弹簧动效族（--spring-* 一枚都没定义），沿用标准缓动' },
  { key: 'dark:--warn-soft', why: '待决：应用这一档比官网重（.12 对 .07），改不改要对着警告条真看一遍，本批只登记' },
];

const LIGHT_HINT = /prefers-color-scheme\s*:\s*light|\[data-theme\s*=\s*"light"\]/;
const COLOR_SCHEME = /prefers-color-scheme/;
const ROOT_SCOPE = /^:root\b|^:root:not\(|^\[data-theme\s*=\s*"/;

/** 注释、多余空白、逗号后的空格都不算漂移，所以比较前一律归一。 */
export function normalizeValue(raw) {
  return String(raw).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/,\s+/g, ',').trim();
}

/**
 * 只收根作用域里的自定义属性：`:root`、`[data-theme="…"]`，以及
 * `@media (prefers-color-scheme: light)` 里那个 `:root:not([data-theme="dark"])`。
 * 返回 [{ theme, scope, name, value, where, line }]，同一枚可以出现多次（两份浅色块是故意的）。
 * scope 是**非配色**的媒体条件（窄屏改 --page-pad 那一类），它是正当的响应式覆盖，
 * 跨文件不拿来比，但同作用域内自重定义不同值就是事故。
 */
export function parseTokens(css) {
  const body = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let cur = '';
  let line = 1;
  for (const ch of body) {
    if (ch === '\n') line++;
    if (ch === '{') {
      stack.push({ sel: cur.trim(), line });
      cur = '';
    } else if (ch === '}' || ch === ';') {
      const decl = cur.trim();
      cur = '';
      const innermost = stack[stack.length - 1];
      if (decl && innermost && ROOT_SCOPE.test(innermost.sel)) {
        const colon = decl.indexOf(':');
        if (colon >= 0 && decl.startsWith('--')) {
          out.push({
            theme: stack.some((f) => LIGHT_HINT.test(f.sel)) ? 'light' : 'dark',
            scope: stack.filter((f) => /^@media/.test(f.sel) && !COLOR_SCHEME.test(f.sel))
              .map((f) => normalizeValue(f.sel.replace(/^@media\s*/, ''))).join(' 和 '),
            name: decl.slice(0, colon).trim(),
            value: normalizeValue(decl.slice(colon + 1)),
            where: innermost.sel,
            line: innermost.line,
          });
        }
      }
      if (ch === '}') stack.pop();
    } else cur += ch;
  }
  return out;
}

/** 按「主题 | 响应式作用域 | 令牌名」收摊；同值重复并成一条，异值留着报内部不一致。 */
function index(tokens) {
  const map = new Map();
  for (const t of tokens) {
    const key = `${t.theme} | ${t.scope} | ${t.name}`;
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).some((v) => v.value === t.value)) map.get(key).push(t);
  }
  return map;
}

/** 跨文件只比基础作用域（scope 为空）的那批令牌。 */
function baseOnly(map) {
  const out = new Map();
  for (const [key, vals] of map) {
    const [theme, scope, name] = key.split(' | ');
    if (scope) continue;
    out.set(`${theme}:${name}`, vals);
  }
  return out;
}

/** 两份 CSS 文本 → 报告。不动文件，只说哪里对不上。 */
export function check(appCss, siteCss, known = KNOWN_DRIFT) {
  const appAll = index(parseTokens(appCss));
  const siteAll = index(parseTokens(siteCss));
  const app = baseOnly(appAll);
  const site = baseOnly(siteAll);
  const report = { drift: [], accepted: [], internal: [], stale: [], only: { app: 0, site: 0 }, responsive: { app: 0, site: 0 } };

  for (const [side, map] of [['app.css', appAll], ['shared.css', siteAll]]) {
    for (const [key, vals] of map) {
      if (vals.length > 1) {
        report.internal.push({ key, side, values: vals.map((v) => `${v.value}（${v.where}，${v.line} 行起）`) });
      }
      if (key.split(' | ')[1]) report.responsive[side === 'app.css' ? 'app' : 'site']++;
    }
  }

  for (const [key, appVals] of app) {
    const siteVals = site.get(key);
    if (!siteVals) { report.only.app++; continue; }
    const a = appVals[0].value;
    const s = siteVals[0].value;
    if (a === s) continue;
    const hit = known.find((k) => k.key === key);
    if (hit) {
      report.accepted.push({ key, app: a, site: s, why: hit.why });
    } else {
      report.drift.push({ key, app: a, site: s, at: appVals[0].line });
    }
  }
  for (const key of site.keys()) if (!app.has(key)) report.only.site++;
  // 过期条目：只在「两边都有这一枚、而且值已经一样了」时报。
  // 令牌整个不见了走的是「单边独有」那个计数，不重复报一遍。
  for (const k of known) {
    const a = app.get(k.key);
    const s = site.get(k.key);
    if (a && s && a[0].value === s[0].value) report.stale.push(k);
  }
  return report;
}

export function render(report) {
  const lines = [];
  for (const d of report.drift) lines.push(`漂移 ${d.key} —— app.css ${d.app}（${d.at} 行） / shared.css ${d.site}`);
  for (const d of report.accepted) lines.push(`已知 ${d.key} —— app.css ${d.app} / shared.css ${d.site}：${d.why}`);
  for (const i of report.internal) {
    lines.push(`内部不一致 ${i.key} 在 ${i.side} 里有 ${i.values.length} 种值：${i.values.join(' 、')}`);
  }
  for (const s of report.stale) lines.push(`已知漂移表里 ${s.key} 已经不漂了 —— 删掉这条，否则它下次真漂没人报`);
  lines.push(
    `小结：未处理漂移 ${report.drift.length} 条、内部不一致 ${report.internal.length} 条、过期条目 ${report.stale.length} 条、` +
    `已认可 ${report.accepted.length} 条；基础令牌单边独有 app.css ${report.only.app} 枚 / shared.css ${report.only.site} 枚，` +
    `响应式覆盖 app.css ${report.responsive.app} 处 / shared.css ${report.responsive.site} 处（这几类都不算漂移）`
  );
  return lines;
}

/**
 * 显式给的路径**不许偷偷换成别的**：--site 指错了就说指错了，
 * 不然写错一个字母就得到「比对了另一份文件」的假绿。
 */
export function resolveSite(flag) {
  if (flag) return existsSync(flag) ? path.resolve(flag) : null;
  for (const c of [process.env.NW_SITE_SHARED_CSS, ...SITE_CANDIDATES.map((x) => path.join(REPO, x))]) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--site' || a === '--app') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        console.error(`${a} 后面要接一个路径`);
        return { __bad: 2 };
      }
      opts[a.slice(2)] = v;
      continue;
    }
    console.error(`不认识这个开关：${a}\n用法：node tools/check-tokens.mjs [--site <shared.css>] [--app <app.css>] [--json]`);
    return { __bad: 2 };
  }
  return opts;
}

export function run(argv) {
  const opts = parseArgs(argv);
  if (opts.__bad) return opts.__bad;
  const appPath = opts.app ? path.resolve(opts.app) : path.join(REPO, 'src/styles/app.css');
  const sitePath = resolveSite(opts.site);
  if (!sitePath) {
    const tried = opts.site ? `你给的那条不存在：${opts.site}`
      : `找过：${[process.env.NW_SITE_SHARED_CSS, ...SITE_CANDIDATES.map((c) => path.join(REPO, c))].filter(Boolean).join(' 、')}`;
    console.error(`!! 没找到官网的 shared.css，本次没有比对。跳过不等于通过。\n   ${tried}\n` +
      `   单独 clone 时给它指路：--site <shared.css> 或环境变量 NW_SITE_SHARED_CSS`);
    return 2;
  }
  const report = check(readFileSync(appPath, 'utf8'), readFileSync(sitePath, 'utf8'));
  // --json 是给机器读的（CI、别的 agent 调这个工具），stdout 里不能混进一行中文。
  // 比对的是哪一份文件得跟着结果走，所以 json 模式下它进对象，不另起一行。
  if (opts.json) console.log(JSON.stringify({ ...report, site: sitePath }, null, 2));
  else {
    for (const l of render(report)) console.log(l);
    console.log(`对照：${sitePath}`);
  }
  return report.drift.length + report.internal.length + report.stale.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
