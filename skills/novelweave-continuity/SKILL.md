---
name: novelweave-continuity
description: >-
  只读检查中文长篇小说的连续性矛盾：死人出场、人设与状态快照互斥、伏笔未回收或逾期、
  payoff 早于 setup、外貌特征区间违规、引用断链、章号结构非法、未建档人名。
  当用户问"这章有没有前后矛盾""人设崩了吗""还有没收的伏笔""检查一下一致性"，
  或在写完一章后需要门禁时使用。只报告有原文依据的问题，不改写正文，不修改任何文件。
  NOT for：判断文笔好坏、去 AI 痕迹、建议情节走向、做语义润色、批量生成新章节。
license: MIT
metadata:
  version: "1.0.0"
  category: writing
  subcategory: continuity-check
compatibility: 需要 Node ≥ 18。零依赖、零网络。
allowed-tools: Read, Bash, Glob, Grep
---

# NovelWeave · 连续性检查（只读）

**本 skill 永不修改文件**（除非用户明确要求把报告落盘，那才用 `--write`）。
它的职责是把矛盾找出来并给出可执行的修法；改不改是作者的决定。

与 `novelweave` 的分工：那个负责写与维护状态，这个负责挑刺。可以在没装主编排
skill 的情况下单独使用本 skill。

## 怎么跑

```bash
# 全书
node scripts/nw-continuity.mjs <bookDir>
# 只看某几章（写完新章后的门禁）
node scripts/nw-continuity.mjs <bookDir> --from ch-013 --json
# 只跑指定规则
node scripts/nw-continuity.mjs <bookDir> --rules R1,R3,R7
# CI 里不让 LLM 补充项阻断
node scripts/nw-continuity.mjs <bookDir> --fail-on error
# 查规则本身的判定逻辑与误报控制
node scripts/nw-continuity.mjs explain --rule R1
```

退出码：`0` 无阻断问题 · `1` 存在 machine error（或 `--fail-on warn` 时的 warn）·
`2` 用法错 · `3` schema 不通过。`--json` 时全量诊断在 stdout，人类日志在 stderr。

## 报告之后怎么做

按 severity 决策，**不要**把所有诊断一次性倒给用户：

| severity | 含义 | 你的动作 |
|---|---|---|
| `error` | 事实互斥，不可能同时成立 | 最多列 5 条，逐条给 `evidence.quote` 与 `suggestion`，问作者要改正文还是改设定 |
| `warn` | 可疑，或长期未处理 | 只报计数 + 最需要看的 2 条 |
| `info` | 提示级（含回忆语境降级、未建档候选名） | 默认不提，除非用户问"还有什么" |
| `suppressedBy` 非空 | 作者此前豁免过 | **不要重复提**，可在末尾一句带过"另有 N 条已被豁免" |

## 报告格式

```
《烟火纪》13 章 · 引擎 1.0.0
❌ [R1] dead-character-on-stage · ch-011
   明长老于 ch-004 死亡，但在 ch-011 被写成正在行动。
   「明长老推开山门，径直走到林烟火面前。」
   → 确认是否为闪回；若是给 ch-011 加 flags:[flashback]，否则改写该段。
```

必须引用 `evidence.quote`。没有原文依据的结论不许输出——这条是反幻觉的硬要求。

## 补充语义级检查（机器做不了的）

机器规则覆盖不到的语义矛盾（动机漂移、对白口吻跳人、设定与情节的隐性冲突、
"这处算不算某伏笔的回收"），你可以自己判断，但必须守三条：

1. `source` 标 `"llm"`，**不写进机器规则的名字表**，用 `llm:` 前缀
   （如 `llm:motivation-drift`）。
2. 每条必须带 `evidence.quote`，且该句能在指定章正文里**字面找到**。找不到就别报——
   这条是防止你发明事实的唯一硬闸。
3. `confidence < 0.7` 一律降为 `info`，且始终 `needsReview: true`。
   LLM 诊断**永不计入退出码**，CI 只数 machine。

可用的 `llm:` 规则名与适用场景见 `references/rules.md` 末尾。不要自创新规则名。

## 反模式

| 不要 | 要 |
|---|---|
| "建议加强人物塑造"这类无依据评价 | 只报有 `evidence.quote` 支撑的具体矛盾 |
| 把 30 条诊断全倒出来 | 计数 + 最严重 5 条 + 让用户跑 `--json` |
| 直接改正文 | 给改法，让作者决定 |
| 因为"看起来像闪回"就不报 R1 | 该报就报，作者可以用 `flags:[flashback]` 或 `suppressions.json` 豁免 |
| 自己新编一个 rule 名 | 只用规则表里的名字；确实超出范围就用 `llm:` 前缀并说明 |
| 拿 `unregistered-entity` 当错误吓用户 | 它是 info，作用是提示"这人该建档了" |

## 豁免的正确做法

作者确认某条是有意为之（闪回、不可靠叙述者、伏笔故意悬置）时，写进
`continuity/suppressions.json`，而不是删掉诊断：

```json
{ "schemaVersion": "1", "items": [
  { "fingerprint": "dead-character-on-stage:ch-011:char-ming",
    "reason": "闪回段，作者确认", "by": "author", "at": "2026-08-28T12:00:00Z" }
] }
```

`fingerprint` 从诊断里原样取。这样豁免**留痕且可撤销**，报告里会以
`suppressedBy` 出现而不是消失。

## 阅读地图

- 想知道某条规则为什么这样判 → 读 `references/rules.md`
- 想批量接入 CI → 读 `references/severity-actions.md`
