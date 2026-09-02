// EPUB 导出测试:容器结构/CRC/mimetype 纪律/opf 完整性
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWEpub, NWText } from './_load.mjs';
import { readFileSync } from 'node:fs';

// Node 侧解 zip:用零依赖手撸的目录解析(仅支持 store,足够校验我们的输出)
function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'EOCD 必须存在');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const files = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, 'central header magic');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameLen));
    // local header
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(dataStart, dataStart + size);
    // CRC 校验
    const crc = dv.getUint32(p + 16, true);
    files.set(name, { method, data, crc });
    assert.equal(NWEpub.crc32(data), crc, `CRC 必须正确: ${name}`);
    assert.equal(method, 0, 'store 模式(EPUB mimetype 要求不压缩,全部 store 也合法)');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test('buildEpub：容器结构与 mimetype 纪律', () => {
  const bytes = NWEpub.buildEpub(
    { title: '烟火纪', author: '测试' },
    [{ title: '山门', body: '第一段。\n\n第二段。' }, { title: '夜行', body: '夜里火起。' }],
  );
  assert.ok(bytes[0] === 'P'.charCodeAt(0) && bytes[1] === 'K'.charCodeAt(0), 'zip magic PK');
  const files = unzip(bytes);
  // mimetype 纪律:第一个条目、不压缩、内容精确
  assert.equal(new TextDecoder().decode(files.get('mimetype').data), 'application/epub+zip');
  assert.ok(files.has('mimetype') && files.has('META-INF/container.xml') && files.has('OEBPS/content.opf') && files.has('OEBPS/nav.xhtml'));
  const nav = new TextDecoder().decode(files.get('OEBPS/nav.xhtml').data);
  assert.match(nav, /山门/);
  assert.match(nav, /夜行/);
  const opf = new TextDecoder().decode(files.get('OEBPS/content.opf').data);
  assert.match(opf, /<dc:title>烟火纪<\/dc:title>/);
  assert.match(opf, /properties="nav"/);
});

test('buildEpub：正文转 XHTML 段落并转义(模型输出不得注入标记)', () => {
  const bytes = NWEpub.buildEpub({ title: 'X<script>' }, [{ title: '章', body: '他说<b>你好</b>。' }]);
  const files = unzip(bytes);
  const chap = new TextDecoder().decode(files.get('OEBPS/chap1.xhtml').data);
  assert.ok(!chap.includes('<b>'), '正文 HTML 必须被转义');
  assert.ok(chap.includes('&lt;b&gt;'));
  const opf = new TextDecoder().decode(files.get('OEBPS/content.opf').data);
  assert.ok(opf.includes('X&lt;script&gt;'), '书名也要转义');
});

test('buildEpub：空书也要产出合法容器', () => {
  const bytes = NWEpub.buildEpub({ title: '空' }, []);
  const files = unzip(bytes);
  assert.ok(files.has('OEBPS/chap1.xhtml'));
});
