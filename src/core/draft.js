/**
 * NovelWeave · 织文 — 散稿建档的解析核心（UMD：浏览器与 Node 共用）
 *
 * 只做一件事：把「一堆没有 frontmatter 的章节文件」判成结构化的章节记录。
 * 判不出来的绝不猜，一律列进 issues 交给人 —— 建档是入口，入口猜错了后面全歪。
 *
 * 为什么不放进脚本：这段逻辑要能被单元测试直接覆盖，将来 Web 端从目录导入也用得上。
 * 文件读写不在此处，这里不碰磁盘。
 */
(function (root, factory) {
  const mod = factory(root.NWText);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWDraft = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T) {
  'use strict';

  const DIGITS = { '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const UNITS = { '十': 10, '百': 100, '千': 1000 };

  /** 中文数字 → 阿拉伯数字。支持到千；「一百零五」「二十一」「十」都对。 */
  function cnToNumber(s) {
    const str = String(s).trim();
    if (/^\d+$/.test(str)) return Number(str);
    let total = 0, current = 0, seen = false;
    for (const ch of str) {
      if (ch in DIGITS) { current = DIGITS[ch]; seen = true; }
      else if (ch in UNITS) {
        // 「十」单独出现按 10 算，「二十三」按 20+3
        total += (current || (seen ? 0 : 1)) * UNITS[ch];
        current = 0; seen = true;
      } else if (ch === '零') { /* 一百零五：占位，不加值 */ }
      else return null;
    }
    const n = total + current;
    return seen && n > 0 ? n : null;
  }

  // 第N章 / 第N回 / 第N节 / 第N幕；也吃「第一章 xxx」「第1章：xxx」
  const CHAPTER_RE = /^[\s#>]*第\s*([0-9〇零一二两三四五六七八九十百千]+)\s*[章节回幕卷]\s*[《『"“「]?\s*([^\n》』”」]{0,40})/;
  // 英文 Chapter 12 / ch.12
  const EN_RE = /^[\s#>]*(?:chapter|ch\.?)\s*([0-9]{1,4})\s*[::]?\s*([^\n]{0,40})/i;
  // 文件名里的 012-、12.、第12章。允许任意前导零：001-/0007- 是草稿最常见的命名
  const FILE_NUM_RE = /(?:^|[^0-9])([0-9]{1,4})(?:[._\-]|$)/;
  // 2024-03-12 草稿.md 里的 2024 不是章号
  const DATE_STEM_RE = /^[0-9]{4}[-.][0-9]{1,2}[-.][0-9]{1,2}/;
  const NAMED = {
    楔子: 'prologue', 序章: 'prologue', 前言: 'prologue', 引子: 'prologue',
    尾声: 'epilogue', 后记: 'epilogue', 终章: 'epilogue',
  };

  /**
   * 判一章的编号与标题。filename 优先于正文首行 —— 作者改标题时通常先改文件名，
   * 而正文首行可能是「本章完」之类噪声。两者都判不出时返回 null，交给调用方决定。
   * @returns {{number: ?number, title: string, named: string|null, source: string}}
   */
  function detect({ filename = '', text = '' } = {}) {
    const stem = String(filename).replace(/\.(md|txt|markdown)$/i, '');
    const head = String(text).split(/\r?\n/).slice(0, 6).join('\n');

    let hit = null;
    for (const [src, line] of [['filename', stem], ['body', head]]) {
      const m = line.match(CHAPTER_RE);
      if (m) {
        const n = cnToNumber(m[1]);
        if (n) { hit = { number: n, title: cleanTitle(m[2], src), named: null, source: src }; break; }
      }
      const en = line.match(EN_RE);
      if (en) { hit = { number: Number(en[1]), title: cleanTitle(en[2], src), named: null, source: src }; break; }
    }
    if (hit) {
      // 「012-夜袭.md」能定编号但标题在正文里；不回填就会把标题行留在正文，
      // 每章多出一行重复标题。编号不一致时宁可不回填。
      if (!hit.title && hit.source === 'filename') {
        const bm = head.match(CHAPTER_RE) || head.match(EN_RE);
        const bn = bm ? cnToNumber(bm[1]) : null;
        if (bn === hit.number) hit.title = cleanTitle(bm[2], 'body');
      }
      return hit;
    }
    for (const [name, kind] of Object.entries(NAMED)) {
      if (stem.includes(name) || head.split(/\r?\n/)[0]?.includes(name)) {
        return { number: null, title: name, named: kind, source: 'filename' };
      }
    }
    const fm = DATE_STEM_RE.test(stem) ? null : stem.match(FILE_NUM_RE);
    if (fm) {
      const rest = stem.replace(FILE_NUM_RE, '').replace(/^[._\-\s]+/, '').trim();
      return { number: Number(fm[1]), title: cleanTitle(rest, 'filename'), named: null, source: 'filename' };
    }
    return { number: null, title: cleanTitle(stem, 'filename'), named: null, source: 'none' };
  }

  function cleanTitle(raw, source) {
    let s = String(raw || '').replace(/^[\s:：·—\-、《『"“「]+/, '').replace(/[\s》』”」]+$/, '').trim();
    if (s.length > 30) s = s.slice(0, 30);
    // 正文首行常常不是标题（「他说完就走了」）；只有文件名来源才允许兜这种噪声
    if (!s && source === 'filename') return '';
    return s;
  }

  /** 去掉重复的标题行：frontmatter 已有 title，正文再留一行会二次导出成两个标题。 */
  function stripTitleLine(body, title) {
    const lines = String(body).split(/\r?\n/);
    if (!title || !lines.length) return String(body);
    const first = lines[0].trim();
    const same = first.replace(CHAPTER_RE, '').trim() === title
      || new RegExp(`^\\s*[#>\\s]*第\\s*[0-9〇零一二两三四五六七八九十百千]+\\s*[章节回幕]\\s*[::]?\\s*${T.escapeRegExp(title)}\\s*$`).test(first);
    if (!same) return String(body);
    // 只吃标题行与紧随其后的空行，正文一个字都不动
    let i = 1;
    while (i < lines.length && lines[i].trim() === '') i++;
    return lines.slice(i).join('\n');
  }

  /**
   * 把一批草稿文件排成章节序列。
   * @param files [{ name, text }]，顺序 = 调用方给的顺序（通常是目录序）
   * @returns {{chapters: Array, issues: Array, stats: object}}
   *   issues 是要人处理的疑问，绝不静默替作者决定：编号缺失、重号、跳号都列出来。
   */
  function planAdopt(files = []) {
    const detected = files.map((f) => ({
      name: f.name,
      text: String(f.text ?? ''),
      ...detect({ filename: f.name, text: f.text }),
    }));
    const issues = [];
    const numbered = detected.filter((d) => d.number !== null && !d.named);
    const maxNum = numbered.length ? Math.max(...numbered.map((d) => d.number)) : 0;

    // 判得出编号的保留原编号；楔子取 0、尾声取 max+1 —— 这两个位置都不平移作者已有的章号。
    // 整批重排看着整齐，实则把「第5章」变成别的东西，而这种错位事后几乎发现不了。
    const resolved = [];
    const unresolved = [];
    for (const d of detected) {
      if (d.number !== null && !d.named) { resolved.push(d); continue; }
      if (d.named === 'prologue') { resolved.push({ ...d, number: 0, positional: true }); continue; }
      if (d.named === 'epilogue') { resolved.push({ ...d, number: maxNum + 1, positional: true }); continue; }
      unresolved.push(d);
      issues.push({ kind: 'no-number', file: d.name, detail: '判不出章号，也不属于楔子/尾声类，未建档' });
    }

    const sorted = resolved.sort((a, b) => a.number - b.number);
    const byNumber = new Map();
    for (const d of sorted) byNumber.set(d.number, [...(byNumber.get(d.number) || []), d.name]);
    for (const [n, list] of [...byNumber.entries()].sort((a, b) => a[0] - b[0])) {
      if (list.length > 1) issues.push({ kind: 'duplicate-number', number: n, files: list });
    }
    if (sorted.length) {
      const nums = sorted.map((d) => d.number);
      for (let n = Math.min(...nums); n <= Math.max(...nums); n++) {
        if (!byNumber.has(n)) issues.push({ kind: 'gap-number', number: n });
      }
    }
    for (const d of sorted) {
      if (!d.title) issues.push({ kind: 'no-title', file: d.name });
      if (T.countWords(d.text) < 50) issues.push({ kind: 'suspiciously-short', file: d.name, words: T.countWords(d.text) });
    }

    const chapters = sorted.map((d) => ({
      number: d.number,
      title: d.title || d.named || `第${d.number}章`,
      body: stripTitleLine(d.text, d.title),
      words: T.countWords(stripTitleLine(d.text, d.title)),
      from: d.name,
      source: d.source,
      positional: !!d.positional,
      named: d.named || null,
    }));
    return {
      chapters,
      unresolved: unresolved.map((d) => d.name),
      issues,
      stats: {
        files: files.length,
        chapters: chapters.length,
        words: chapters.reduce((s, c) => s + c.words, 0),
        detectedByFilename: chapters.filter((c) => c.source === 'filename').length,
        positional: chapters.filter((c) => c.positional).length,
        unresolved: unresolved.length,
      },
    };
  }

  return { cnToNumber, detect, stripTitleLine, planAdopt, CHAPTER_RE };
});
