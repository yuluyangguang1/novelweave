# 上下文预算

长篇写作翻车的第一原因不是模型不行，而是**喂给模型的上下文失控**：
要么塞进全书把窗口撑爆，要么只给一句"继续写"让它自己编前文。

织文的做法：状态文件是唯一权威，但**永远不整份进 prompt**；写作只消费一份
按固定优先级拼出来、有字节上限的派生文档。

## 硬上限

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_CONTEXT_BYTES` | 12288 | 整份派生上下文文档 |
| `budgetPerChapter` | 3072 | 每章状态快照 |
| `loreBytes` | 4096（默认额度的 1/3） | 其中分给世界设定的部分 |

按**字节**而非字符计算：一个汉字 3 字节，按字数控制会让中文书的实际体积超三倍。

## 节序与优先级

`nw-context.mjs` 按固定顺序拼，越靠前越不容许被裁：

1. `书目` —— 书名、类型、概述、叙事人称与笔法
2. `出场角色` —— 含 `⚠️ 已死亡，只可被提及，不得行动` 这类警示
3. `分章状态快照` —— 上一章结束时每个人的位置/生死/伤/持有物/已知/目标
4. `未结线索` —— 未回收伏笔与开放悬念
5. `相关世界设定` —— 关键词触发命中的条目
6. `上章尾部` —— 最后 1200 字
7. `本章已有正文` —— 最后 1500 字

第 2 位放角色卡并把死亡警示写进去，是有意的：模型不知道"这个人不能行动"，
就会让他自然地走出来。这是 R1 类矛盾最常见的产生方式。

## 裁切必须可见

超额时不是静默丢弃。`--json` 返回：

```json
{ "bytes": 11840,
  "sections": [{"name":"书目","bytes":96}, …],
  "droppedSections": [{"name":"本章已有正文","bytes":4410}],
  "loreIncluded": ["wb-qingwu"], "loreDropped": ["wb-heishui"],
  "truncated": true }
```

**看到 `truncated: true` 就要告诉作者**：本次写作没看到被裁掉的那部分，
产出可能与前文脱节。宁可提示，不要假装什么都没发生。

## 世界书关键词触发

`NovelLLM.loreTrigger(text, entries, {loreBytes})`，语义对齐 SillyTavern World Info：

- `enabled` 为 false 的条目不参与；
- `constant: true` 无条件注入（力量体系、世界法则默认如此）；
- `selective: true` 且有 `secondary_keys` 时要求主键与副键同时命中；
- 排序：`priority` 降序 → `insertion_order` 升序；
- 超预算按上述顺序截断，被裁的 id 进 `dropped`。

单独试触发效果（不写任何文件）：

```bash
node scripts/nw-context.mjs <bookDir> --lore --text "林烟火踏入青雾山，山门已破。"
```

## 写新章时的取用方式

```bash
node scripts/nw-context.mjs <bookDir> --chapter next --budget 12288 --write
```

产出 `continuity/context-next.md`。**只读这一份 + 上一章正文尾部**开始写作。
不要为了"保险"再去 cat 一遍 `bible/characters/*.json`——那就把预算机制架空了。
