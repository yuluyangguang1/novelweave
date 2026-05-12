/**
 * NovelWeave · 织文 — Router
 * SPA navigation between pages
 */

const router = {
  current: 'home',
  params: {},
  go(page, params = {}) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const el = document.getElementById(`page-${page}`);
    if (!el) return;
    el.classList.add('active');
    this.current = page;
    this.params = params;
    if (typeof this.onPage === 'function') {
      this.onPage(page, params);
    }
  },
  // Hook for page load callbacks
  onPage: null,
};

// Make global
window.router = router;
