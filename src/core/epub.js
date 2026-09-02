/**
 * NovelWeave · 织文 — EPUB 导出(UMD:浏览器与 Node 共用)
 *
 * 为什么:盐选/个人存档场景需要交付稿。零依赖自实现 zip(store 模式,无压缩)
 * + CRC32,浏览器与 Node 输出字节一致的合法 EPUB 3 容器。
 *
 * EPUB 3 结构:
 *   mimetype            (必须第一个,不压缩,无 extra 字段)
 *   META-INF/container.xml
 *   OEBPS/content.opf   (打包元数据+阅读顺序)
 *   OEBPS/nav.xhtml      (EPUB 3 目录)
 *   OEBPS/chapter-N.xhtml
 *   OEBPS/style.css
 */
(function (root, factory) {
  const mod = factory(root.NWText);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWEpub = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T) {
  'use strict';

  // ── CRC32(zip 标准) ──
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const enc = new TextEncoder();

  /** store 模式(不压缩)打包多文件为合法 zip 字节流。files:[{name, data:Uint8Array}] */
  function zipStore(files) {
    const localParts = [], centralParts = [];
    let offset = 0;
    for (const f of files) {
      const nameB = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      // local file header
      const lh = new Uint8Array(30 + nameB.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);          // version needed
      dv.setUint16(6, 0x0800, true);      // UTF-8 names
      dv.setUint16(8, 0, true);           // store
      dv.setUint16(10, 0, true); dv.setUint16(12, 0, true); // time/date: 0(固定,确定性输出)
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameB.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameB, 30);
      localParts.push(lh, data);
      // central directory entry
      const ch = new Uint8Array(46 + nameB.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameB, 46);
      centralParts.push(ch);
      offset += lh.length + data.length;
    }
    const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of [...localParts, ...centralParts, eocd]) { out.set(p, pos); pos += p.length; }
    return out;
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** 拼装 EPUB 字节流。book:{title,author};chapters:[{title,body}] */
  function buildEpub(book, chapters) {
    const title = String(book?.title || '未命名').slice(0, 100);
    const author = String(book?.author || 'yu.ai 织文');
    const style = 'body{margin:1em;font-family:serif;line-height:1.9}h2{font-size:1.3em;margin:1.2em 0 .8em}p{text-indent:2em;margin:.4em 0}';
    const chXhtml = (ch, i) => `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>${esc(ch.title)}</title><link rel="stylesheet" href="style.css"/></head><body><h2>${esc(ch.title)}</h2>${String(ch.body || '').split(/\n\s*\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p.trim())}</p>`).join('\n') || '<p>（空章）</p>'}</body></html>`;
    const files = [{ name: 'mimetype', data: enc.encode('application/epub+zip') }];
    // 注意:mimetype 必须无 extra、store、首位 —— 我们的 zipStore 天然满足
    files.push({ name: 'META-INF/container.xml', data: enc.encode('<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') });
    files.push({ name: 'OEBPS/style.css', data: enc.encode(style) });
    const spine = [];
    (chapters || []).forEach((ch, i) => {
      const id = 'chap' + (i + 1);
      files.push({ name: `OEBPS/${id}.xhtml`, data: enc.encode(chXhtml(ch, i)) });
      spine.push({ id, href: `${id}.xhtml`, title: ch.title || `第${i + 1}章` });
    });
    if (!spine.length) spine.push({ id: 'chap1', href: 'chap1.xhtml', title: '空书' });
    if (!chapters || !chapters.length) files.push({ name: 'OEBPS/chap1.xhtml', data: enc.encode('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>空书</title></head><body><p>（空书）</p></body></html>') });
    files.push({ name: 'OEBPS/nav.xhtml', data: enc.encode(`<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${spine.map((s) => `<li><a href="${s.href}">${esc(s.title)}</a></li>`).join('')}</ol></nav></body></html>`) });
    files.push({ name: 'OEBPS/content.opf', data: enc.encode(`<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:novelweave-${Date.now()}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><dc:language>zh-CN</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${spine.map((s) => `<item id="${s.id}" href="${s.href}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${spine.map((s) => `<itemref idref="${s.id}"/>`).join('')}</spine></package>`) });
    return zipStore(files);
  }

  return { crc32, zipStore, buildEpub };
});
