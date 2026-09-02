/**
 * NovelWeave · 织文 — 语义检索(UMD:浏览器与 Node 共用)
 *
 * 为什么:词频召回认不出"换了说法的设定"。这里用 BYOK 的 OpenAI 兼容
 * /embeddings 端点把章块变成向量,余弦检索最相关的历史章。
 *
 * 硬规矩(与 llm.js 同源):
 * - BYOK:embedding 请求直达服务商,Key 只存本机,不经过任何第三方
 * - 零依赖:纯 fetch + 原生 Math,无向量库
 * - 优雅降级:没配 embedding 或调用失败 → 返回 null,调用方回落词频方案
 *
 * 存储:向量缓存在调用方(IndexedDB / 内存),本模块只做纯计算与请求。
 */
(function (root, factory) {
  const mod = factory(root.NWText);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.NWRetrieval = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T) {
  'use strict';

  const CHUNK_CHARS = 500;   // 每块约 500 字,兼顾召回精度与 embedding 成本
  const MAX_CHUNKS = 400;    // 单书上限,防失控(约 20 万字)

  /** 章节正文切块:按段落聚合到 CHUNK_CHARS,块带章 id/序号。 */
  function chunkChapters(chapters) {
    const out = [];
    for (const ch of chapters || []) {
      const body = String(ch.body || '').trim();
      if (body.length < 80) continue;
      const paras = body.split(/\n\s*\n/).filter((p) => p.trim());
      let buf = '';
      let idx = 0;
      const flush = () => {
        if (buf.trim()) out.push({ chapterId: ch.id, chapterTitle: ch.title, idx: idx++, text: buf.trim() });
        buf = '';
      };
      for (const p of paras) {
        if ((buf + p).length > CHUNK_CHARS && buf) flush();
        buf += (buf ? '\n' : '') + p.trim();
      }
      flush();
      if (out.length >= MAX_CHUNKS) return out.slice(0, MAX_CHUNKS);
    }
    return out;
  }

  /** 余弦相似度(纯数学)。向量未归一化也正确。 */
  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d ? dot / d : 0;
  }

  /**
   * 调 OpenAI 兼容 /embeddings。cfg:{ baseURL, apiKey, model } —— 与聊天配置同源但独立字段。
   * 输入数组顺序与输出向量顺序一致(OpenAI 规范)。
   */
  async function embedTexts(texts, cfg, signal) {
    if (!cfg?.baseURL || !cfg?.apiKey || !cfg?.model || !texts?.length) return null;
    const url = `${String(cfg.baseURL).replace(/\/$/, '')}/embeddings`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, input: texts }),
        signal,
      });
      if (!res.ok) return null;
      const j = await res.json();
      const vecs = (j.data || []).map((d) => d.embedding).filter(Array.isArray);
      return vecs.length === texts.length ? vecs : null;
    } catch (_) {
      return null; // 任何失败都降级,绝不阻塞写作主流程
    }
  }

  /**
   * 语义检索入口。
   * @param query     查询文本(通常 = 本章拍点摘要 + 已有正文尾部)
   * @param chunks    chunkChapters 的产物(可带已缓存的 vector 字段)
   * @param queryVec  查询向量(调用方缓存)
   * @param opts { topK = 4, minScore = 0.3 }
   * @returns [{ chapterId, chapterTitle, idx, text, score }] 按 score 降序;无向量返回 null
   */
  function rankByVector(queryVec, chunks, opts = {}) {
    if (!queryVec) return null;
    const topK = opts.topK ?? 4;
    const minScore = opts.minScore ?? 0.3;
    const scored = [];
    for (const c of chunks) {
      if (!Array.isArray(c.vector)) continue;
      const s = cosine(queryVec, c.vector);
      if (s >= minScore) scored.push({ ...c, score: Math.round(s * 1000) / 1000 });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  return { chunkChapters, cosine, embedTexts, rankByVector, CHUNK_CHARS, MAX_CHUNKS };
});
