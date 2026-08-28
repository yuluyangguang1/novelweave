# severity → 动作，以及接 CI

## 决策表

| 情况 | 你的动作 | 话术要点 |
|---|---|---|
| 0 条 error/warn | 直接说"没发现矛盾"，可以顺带一句 info 的数量 | 不要为了显得干了活而编建议 |
| 有 error | 停手。不写完下一章，先解决 error | 每条给 `evidence.quote` + `suggestion`，问作者要改正文还是改设定 |
| 只有 warn | 报计数 + 最值得看的 2 条 | 明确说这些是可疑不是错误 |
| 只有 info | 默认不提 | 用户问"还有什么"时才说 |
| `suppressedBy` 非空 | 不重复提 | 末尾一句"另有 N 条此前已豁免" |
| `schema-invalid` | 其余诊断都不可信，先修结构 | 说明为什么现在不谈连续性 |
| `rule-crashed` | 当 bug 反馈，不要照它的字面意思行动 | 引擎自身异常 |

## 一条原则

error 的处置权在作者，不在你。你能做的是**定位 + 给出两种改法**（改正文 / 改设定），
不是替他选。特别是改设定——那会牵动之后所有章节。

## 接 CI

```yaml
- run: node scripts/nw-validate.mjs .novelweave/<slug>
- run: node scripts/nw-continuity.mjs .novelweave/<slug> --fail-on error --write
```

退出码语义：

| 码 | 含义 | CI 建议 |
|---|---|---|
| 0 | 通过（或 `--fail-on never` 的纯报告模式） | 绿 |
| 1 | 达到 `fail-on` 阈值 | 红 |
| 2 | 用法错误 | 红，且是你的脚本写错了 |
| 3 | schema 不通过 | 红，优先修 |
| 5 | IO 错误 | 红，通常是路径或权限 |
| 6 | 有 pending 待作者确认 | **黄，不是失败** |

要点：
- `--write` 会把报告落进 `continuity/reports/<时间戳>.json`，可以当构建产物存档、
  也可以在 PR 里 diff 出"这个 PR 新增了几条矛盾"。
- LLM 来源的诊断**永不计入非零退出码**（`--fail-on` 只数 `source: "machine"`）。
  模型判断不该让流水线变红。
- 想按规则子集设不同门禁：`--rules R1,R14,R15 --fail-on error` 卡硬事实，
  `--rules R3,R9 --fail-on never` 只出报表。
