/**
 * NovelWeave · 织文 — Router（真 hash 路由）
 *
 * 旧版只切换 .active class，从不读写 location.hash，因此刷新即回首页、
 * 无法深链、且页面状态全靠模块级变量隐式传递。
 *
 * URL 形态：
 *   #/home
 *   #/settings
 *   #/novel/<novelId>
 *   #/novel/<novelId>/chapter/<chapterId>
 *
 * 路由参数是唯一权威：页面自己按 id 去数据层取，不再依赖 APP.currentNovel。
 */
(function (root) {
  'use strict'

  const ROUTES = [
    { page: 'workspace', re: /^novel\/([^/]+)(?:\/chapter\/([^/]+))?$/ },
    { page: 'settings',  re: /^settings$/ },
    { page: 'home',      re: /^(?:|home)$/ },
  ]

  function parse(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '')
    const [pathPart, queryPart] = raw.split('?')
    for (const r of ROUTES) {
      const m = pathPart.match(r.re)
      if (!m) continue
      const params = {}
      if (r.page === 'workspace') {
        params.novelId = decode(m[1])
        if (m[2]) params.chapterId = decode(m[2])
      }
      if (queryPart) {
        for (const pair of queryPart.split('&')) {
          if (!pair) continue
          const [k, v] = pair.split('=')
          params[decode(k)] = decode(v || '')
        }
      }
      return { page: r.page, params }
    }
    return null
  }

  function decode(s) {
    try { return decodeURIComponent(s) } catch { return s }
  }

  function toHash(page, params) {
    if (page === 'workspace' && params?.novelId) {
      return params.chapterId
        ? `#/novel/${encodeURIComponent(params.novelId)}/chapter/${encodeURIComponent(params.chapterId)}`
        : `#/novel/${encodeURIComponent(params.novelId)}`
    }
    if (page === 'settings') return '#/settings'
    return '#/home'
  }

  const router = {
    current: 'home',
    params: {},
    onPage: null,

    /** 只解析不导航，供 start() 和测试用。 */
    parse,

    go(page, params = {}) {
      const target = toHash(page, params)
      // hash 相同则不会触发 hashchange，需手动应用，否则「回到当前页」会变成空操作后状态漂移
      if (location.hash === target || (target === '#/home' && location.hash === '')) {
        this.apply(target)
        return
      }
      location.hash = target
    },

    /** 替换当前历史条目（用于修正非法 id 之类的重定向，不留垃圾历史）。 */
    replace(page, params = {}) {
      const target = toHash(page, params)
      const cur = location.hash || '#/home'
      if (cur === target) return
      if (history.replaceState) history.replaceState(null, '', target)
      else location.hash = target
      this.apply(target)
    },

    /** 只更新地址栏，不重新渲染。用于编辑器内切换章节：
     *  走 apply() 会重入 enterWorkspace → openChapter，形成回环。 */
    sync(page, params = {}) {
      const target = toHash(page, params);
      if ((location.hash || '#/home') === target) return;
      if (history.replaceState) history.replaceState(null, '', target);
      else location.hash = target;
      this.current = page;
      this.params = params;
    },

    currentKey() {
      return location.hash || '#/home'
    },

    apply(hash) {
      const parsed = parse(hash)
      if (!parsed) { this.replace('home', {}); return }

      document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'))
      const el = document.getElementById(`page-${parsed.page}`)
      if (!el) { this.replace('home', {}); return }
      el.classList.add('active')

      this.current = parsed.page
      this.params = parsed.params
      if (typeof this.onPage === 'function') this.onPage(parsed.page, parsed.params)
    },

    start() {
      window.addEventListener('hashchange', () => this.apply(location.hash))
      this.apply(location.hash || '#/home')
    },
  }

  root.router = router
  if (typeof module === 'object' && module.exports) module.exports = { parse, toHash }
})(typeof globalThis !== 'undefined' ? globalThis : this)
