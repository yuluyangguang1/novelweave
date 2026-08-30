#!/usr/bin/env node
/**
 * make-icons.mjs — 生成 PWA 图标（零依赖，只用 node:zlib）
 *
 * 图标是程序画的「织纹」图案（织文 = 编织文字），不是外部素材：
 * 避免往仓库塞来路不明的二进制，也让图标能随配色一次重生。
 *
 * 用法：node tools/make-icons.mjs [--out icons]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 最小 PNG 编码器（RGBA / 8bit / 无 interlace） ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                        // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 图案 ──
// 配色取站点设计令牌。原先的 #edff45 是界面改版时被淘汰的荧光黄，
// 图标是唯一漏掉的地方 —— 浏览器标签里一直和整页对不上。
const PALETTE = {
  bg: [0x15, 0x0e, 0x07],        // 纸墨黑
  threadA: [0xf2, 0x63, 0x4e],   // 朱砂（经线）
  threadB: [0xf3, 0xed, 0xe2],   // 宣纸白（纬线）
  shadow: [0x2a, 0x1c, 0x12],    // 经纬叠压处：比底略亮的墨
};

function px(buf, size, x, y, [r, g, b], a = 255) {
  const i = (y * size + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

/**
 * 织纹：经纬线交替压在彼此上方，形成 plain weave。
 * radius 给圆角；maskable 版本满铺、内容缩到中心 80% 安全区内。
 */
function draw(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const inset = maskable ? Math.round(size * 0.1) : Math.round(size * 0.06);
  const inner = size - inset * 2;
  const cell = Math.max(10, Math.round(inner / 5));
  const radius = maskable ? 0 : Math.round(size * 0.18);

  const inRounded = (x, y) => {
    if (radius === 0) return x >= inset && y >= inset && x < size - inset && y < size - inset;
    const cx = Math.min(Math.max(x, inset + radius), size - inset - radius);
    const cy = Math.min(Math.max(y, inset + radius), size - inset - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y)) continue;
      const lx = x - inset, ly = y - inset;
      const over = (Math.floor(lx / cell) + Math.floor(ly / cell)) % 2 === 0;
      const inWarp = lx % cell < cell * 0.55;
      const inWeft = ly % cell < cell * 0.55;
      let color = PALETTE.bg;
      if (over && inWarp) color = PALETTE.threadA;
      else if (!over && inWeft) color = PALETTE.threadB;
      else if (inWarp && inWeft) color = PALETTE.shadow;
      px(buf, size, x, y, color);
    }
  }
  return buf;
}

const outDir = path.resolve(process.argv.find((a, i) => process.argv[i - 1] === '--out') || path.join(repoRoot, 'icons'));
fs.mkdirSync(outDir, { recursive: true });

const specs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, opts] of specs) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, encodePng(size, draw(size, opts)));
  process.stdout.write(`写入 ${file} (${size}x${size})\n`);
}
