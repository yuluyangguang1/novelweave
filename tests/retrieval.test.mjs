// 测试:retrieval.js 纯计算部分(不依赖网络)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NWRetrieval } from './_load.mjs';

test('chunkChapters：按段落聚合切块，块带章 id 与标题', () => {
  const chapters = [
    { id: 'ch-001', title: '山门', body: '第一段。' + '甲'.repeat(300) + '\n\n' + '第二段。' + '乙'.repeat(300) },
    { id: 'ch-002', title: '夜行', body: '短章' },
  ];
  const chunks = NWRetrieval.chunkChapters(chapters);
  assert.ok(chunks.length >= 2, '长章要切成多块');
  assert.ok(chunks.every((c) => c.chapterId === 'ch-001'), '短章(<80字)不进索引');
  assert.equal(chunks[0].chapterTitle, '山门');
  assert.ok(chunks[0].text.length <= 700, '块不超过约 500 字上限(段落容差)');
});

test('cosine：同向为 1，正交为 0，长度不等安全返回 0', () => {
  assert.equal(NWRetrieval.cosine([1, 0], [1, 0]), 1);
  assert.equal(NWRetrieval.cosine([1, 0], [0, 1]), 0);
  assert.equal(NWRetrieval.cosine([1, 2, 3], [2, 4, 6]), 1); // 归一化无关
  assert.equal(NWRetrieval.cosine([1], [1, 2]), 0);
  assert.equal(NWRetrieval.cosine(null, [1]), 0);
});

test('rankByVector：按分数降序截 topK，低于阈值丢弃，无向量返回 null', () => {
  const chunks = [
    { chapterId: 'a', chapterTitle: 'A', idx: 0, text: 'x', vector: [1, 0] },
    { chapterId: 'b', chapterTitle: 'B', idx: 0, text: 'y', vector: [0.9, 0.1] },
    { chapterId: 'c', chapterTitle: 'C', idx: 0, text: 'z', vector: [0, 1] },
    { chapterId: 'd', chapterTitle: 'D', idx: 0, text: 'w' }, // 无向量
  ];
  const out = NWRetrieval.rankByVector([1, 0], chunks, { topK: 2, minScore: 0.9 });
  assert.equal(out.length, 2);
  assert.equal(out[0].chapterId, 'a');
  assert.equal(out[1].chapterId, 'b');
  assert.ok(out[0].score >= out[1].score);
  assert.equal(NWRetrieval.rankByVector(null, chunks), null);
});
