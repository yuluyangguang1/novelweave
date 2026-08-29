# 规则规格

实现只有一份：`src/core/rules.js`（浏览器与 Node 共用）。本文件解释**为什么这样判**
以及**误报是怎么控制的**。用 `nw-continuity.mjs explain --rule <代号>` 拿机器可读版本。

`rule-crashed` 是引擎内部异常自保护，出现即说明引擎有 bug，应反馈而不是照办。

## machine 规则

### R1 `dead-character-on-stage`（error）
**输入**：`characters[].status/died-in`、`chapters[].characters/flags`、正文。
**判定**：对 `status=deceased` 且章号大于 `died-in` 的每一章——
① 该章 frontmatter 的 `characters` 含此人 → error（作者亲口声明他出场）；
② 否则扫描正文，名字/别名出现点之后 30 字内命中动作词表 → error。
**误报控制**：
- 该章带 `flashback`/`dream`/`quoted`/`offscreen` 标记 → 完全跳过；
- 名字紧跟「的」（跳过标点与引号后）→ 视为领属提及（"明长老的说法"），不算行动；
- 出现点前 60 字含回忆标记词（当年/那时/生前/记忆里/幻影/识海…）→ 降为 `info`，
  而不是闭嘴不报，让作者自己决定要不要加 flag；
- `suppressions.json` 命中 `fingerprint` → 标 `suppressedBy`，仍保留在报告里。
**为什么动作词表这么长**：只判"名字出现"会把 90% 的正常提及报成矛盾，
那种检查器一周内就会被作者关掉。

### R2 `status-declared-contradiction`（error / missing 为 warn）
角色卡 `status`、`died-in`、分章状态快照三者任二者互斥即报。
`deceased` 但没有 `died-in` 单独成条（代号 `missing-died-in`），因为它会让 R1 全线静默——
不知道死亡章号，就无法判断"之后"的出场。

### R3 `promise-unpaid`（warn，翻倍阈值升 error）
`weight=major` 埋设后 ≥10 章未收报 warn，≥20 章升 error；`minor` 阈值为 25/50。
**不报的情况**：`weight=candidate`（脚本自动登记、作者尚未确认的，不该打扰作者）；
设了 `payoff.due` 的（交给 R3b，避免同一伏笔报两条）。每书最多输出 8 条，按紧迫度截断。

### R3b `promise-overdue`（error）
最新章号已超过 `payoff.due` 但状态不是 `paid-off`/`dropped`。

### R4 `payoff-before-setup`（error）
`payoff.chapter` 的号 ≤ `setup.chapter`；或状态已是 `planted`/`paid-off` 却没有登记埋设章。
后者是最隐蔽的一类：伏笔实际上从未被埋过，读者只会觉得"这事哪来的"。

### R7 `appearance-token-violation`（until 违规 error / since 之前 warn）
靠 `appearance.tokens[].{since,until}` 判定：
- `until` 之后正文仍出现该特征 → "断臂长回来了"，error；
- `since` 之前出现 → 特征提前存在，warn。
**误报控制**：出现点前 80 字含"想起/仿佛/好像/像从前"→ 降 `info`；
`allowIn` 白名单章跳过；token 少于 2 字不判；每个 token 最多报 3 条，不刷屏。
这个字段是我们加的，Character Card V2 与 story-skills 都没有——
它是把外貌连续性变成机器可判的唯一办法。

### R9 `unregistered-entity`（info，confidence 0.5）
候选抽取：「常见姓 + 1~2 字」与「2~4 字 + 称谓后缀（长老/宗主/仙子/公子/前辈…）」两式。
**误报控制**：姓氏式要过一道虚词闸 —— 候选里含「他/们/了/的/是/在…即弃」，因为「路他已」「经看了」
这类是普通词恰好从姓字开始；称谓式**不过滤**，那本身就带信息（林夫人、张道人都含「人」）。
三重闸之后才报：出现 ≥2 次、跨 ≥2 章、且不在 `lexicon.names`、角色本名与别名、
世界条目名与 `keys`、`allowlist` 之中。**聚合成一条**列出 top 15。
它的作用是养 lexicon，不是骂作者，所以永远是 info。
抽取器 `NWRules.entityCandidates` 与 `nw-io.mjs adopt` 共用一份 —— 建档时看得见的名字
和检查时报出来的名字必须是同一批。

### R6 `timeline-regression`（error；`implied` 只出 info）
按章序遍历带 `day` 的锚点，为每条 `thread` 维护至今的最大时间戳（`day + 时辰折算`），
后来的锚点时间戳更小即判**时间倒流**。
**误报控制**：
- 不同 `thread` 之间**永不比较** —— 多线并行是合法叙事，放一起比必然误报；
- 锚点所在章带 `flashback`/`dream`/`quoted`/`offscreen` 标记 → 跳过该锚点；
- `confidence: implied`（从"三天后"这类叙述推出来的）一律降 `info`：推断的时间不可靠，
  让它报错只会逼作者关掉检查器；
- 判出回退后**不回写最大值**，避免一个填错的锚点引发后续连锁误报。

时辰必须参与比较（黎明 < 晨 < 午 < 暮 < 夜 < 三更），否则「第 1 章夜里发生、
第 2 章写当天清晨」这种真回退会被漏掉。

### R14 `structure-invalid`（error，slug 重复与缺号为 warn）
章号非 ≥0 整数（`0` = 前置章，楔子/序）、重复、id 重复、slug 冲突、status 非枚举、章号有洞。
优先级最高：章序一乱，所有依赖 `number` 比较的规则都会产出假诊断。

### R15 `dangling-reference`（error）
扫描章 frontmatter 的 `characters/mentions/locations/pov/time_anchor`、角色卡的
`first/died-in`、伏笔登记表的 `setup/payoff/due/characters`。
断链必须显式报出，否则相关规则会**静默失效**——那比报错危险得多。

### R16 `derived-field-touched`（warn）
`x-words`、`_derived.words` 与重算值不符。说明有人手改了派生字段，或写完正文没重算。

## schema-invalid 与执行顺序

`nw-validate.mjs` / `nw-continuity.mjs` 先跑 schema 校验；**不通过则其余规则全部不跑**，
只输出结构违规。这是刻意的：一份字段类型都错的书能派生出几十条假矛盾，
把真问题埋在里面。

## llm: 规则（机器做不了，需模型判断）

这些**不实现**在 `rules.js` 里，由 agent 自己判断，但必须守
`SKILL.md` 里的三条（`llm:` 前缀、`evidence.quote` 可字面回查、`confidence<0.7` 降 info、
永不计入退出码）。

| 名字 | 场景 |
|---|---|
| `llm:motivation-drift` | 角色行动与已确立的目标/性格矛盾，但不是事实错误 |
| `llm:voice-break` | 对白口吻跳出该角色已建立的说话方式 |
| `llm:semantic-payoff-match` | 某处描写看起来算某条伏笔的回收，建议回填 `payoff.chapter` |
| `llm:world-rule-violation` | 情节与 `constant` 类世界规则隐性冲突 |
| `llm:timeline-implicit` | 从"三天后""入夜"等叙述推断时间流逝，只能产 `implied` 置信度 |

不许自创规则名。超出上表的问题，用自然语言写在报告里，不要伪装成规则。

## 尚未实现的机器规则

写在这里以免被误认为"检查过了"：

- `location-teleport`（同刻瞬移）：需要最小行程表，v1 未做。
- `relation-contradiction`（初见却互知姓名）：需要 `relations.json` 进规则层，v1 未做。
- `item-state-contradiction`（失而复得的物品）：需要更完整的物品登记，v1 未做。
- `restricted-address-term`（称谓越界）：需要可靠的说话人归属，误报率高，v1 未做。
- 世界书 `recursive_scanning`（触发出的内容再触发别的）：只做单层扫描。

R6 已实现，但它只在锚点填了 `day` 之后才生效：没登记时间的章节它看不见。
锚点稀疏时覆盖面小，这是能力边界而不是缺陷——宁可少报也不要凭猜报错。
