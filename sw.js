/**
 * NovelWeave · 织文 — Service Worker
 *
 * 三条硬规矩：
 * 1. 跨域请求一律不碰。API Key 是用户自带的，聊天请求必须原样直达服务商，
 *    缓存或改写它都是不可接受的。
 * 2. 导航用 network-first。发版后用户必须能拿到新壳，否则配合边缘缓存的
 *    max-age 会出现「新 HTML + 旧 JS」的混排故障。
 * 3. 预缓存清单与实际加载的文件必须一致 —— 由 tests/guards.test.mjs 比对，
 *    漏一个文件离线就会白屏。
 */

const VERSION = 'nw-v3'; // v3: activate 时向页面广播 sw-updated(横幅)
const CACHE = `${VERSION}-shell`;
const BASE = new URL('./', self.location).href;

const PRECACHE = [
  '',                              // 目录本身 → index.html
  'index.html',
  'manifest.webmanifest',
  'src/styles/app.css',
  'src/core/text.js',
  'src/core/bible.js',
  'src/core/rules.js',
  'src/core/story.js',
  'src/core/context.js',
  'src/core/selfcheck.js',
  'src/core/retrieval.js',
  'src/core/project.js',
  'src/core/db.js',
  'src/demo.js',
  'src/core/llm.js',
  'src/router.js',
  'src/app.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个添加：一个文件 404 不该拖垮整次安装
    await Promise.allSettled(PRECACHE.map((p) => cache.add(new Request(BASE + p, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('nw-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
    const cl = await self.clients.matchAll({ type: "window" });
    for (const c of cl) c.postMessage({ type: "sw-updated" });
  })());
});

function isSameOrigin(url) {
  try { return new URL(url).origin === self.location.origin; } catch { return false; }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // POST 直达，绝不缓存（含所有 LLM 调用）
  if (!isSameOrigin(req.url)) return;                  // 跨域一律放行：BYOK 请求不进缓存

  const url = new URL(req.url);
  if (!url.pathname.startsWith(new URL(BASE).pathname)) return;   // 只管本应用作用域内

  // 导航：网络优先，离线才回落到缓存的壳
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('index.html')) || (await caches.match('')) || Response.error();
      }
    })());
    return;
  }

  // 静态资源：网络优先，离线回落。
  // 不用 cache-first —— app.css 的 ?v=1 永不变化，cache-first 会让改过的样式长期是旧的。
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      return (await caches.match(req)) || Response.error();
    }
  })());
});
