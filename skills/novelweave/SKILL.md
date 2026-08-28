---
name: novelweave
description: >-
  在已有 .novelweave/ 项目目录的中文长篇小说上工作：续写与修订章节、维护角色/世界/时间线/伏笔的
  结构化 Story Bible、按 ---CHANGES--- 协议提案状态变更、与织文 Web 端导入导出同一本书。
  当用户说"继续写第N章""接上文""更新人物状态""这条伏笔回收了""记一下伏笔""同步/导出/校验这本书"，
  或当前目录及其祖先存在 .novelweave/project.json 时使用。
  NOT for：从零批量产出整本书、去除 AI 痕迹、句子级文笔诊断（弱动词/陈词滥调/被动语态）、
  PDF/EPUB 成品排版、多智能体任务分派、不是 NovelWeave 格式的散稿。这些需求见下方 Scope Boundaries。
license: MIT
metadata:
  version: "1.0.0"
  category: writing
  subcategory: long-fiction-state
compatibility: 需要 Node ≥ 18。scripts/ 只用 Node 内置模块，无 npm 依赖、无网络依赖。
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# NovelWeave — Story Bible 主编排

本 skill 的唯一价值主张：**把长篇的一致性变成可序列化、可机器校验的数据**，
并且让命令行 agent 与浏览器写作端读写同一本书，不需要任何服务器。

## Scope Boundaries（先读这段，避免和已装的小说 skill 抢活）

如果本机装有 `chinese-novelist` / `novelcraft` / `novelwriter` / `novel-writer` /
`ironprose` / `novel-coordinator`，它们在各自方向上比本 skill 强。**默认让位**，按下面的仲裁走。

触发仲裁（同一请求两边都能接时）：
- 目标是**产出一批新正文**（"帮我写一本 20 章的悬疑小说"）→ 交给批量成稿类 skill，本 skill 不参与。
- 目标是**维护或校验已有状态**（"这章有没有前后矛盾""把林烟火的状态更新一下"）→ 本 skill 承担。
- 目标是**改文字质感**（去 AI 味、弱动词、句式）→ 交给文体分析类 skill；本 skill 的润色只改连续性事实。
- 目标是**排版出书**（PDF/EPUB）→ 交给出版类 skill。

本 skill **不做**的事，无论用户怎么问：
- 不从零起稿整本书，不做"一键生成 50 章"。
- 不判断文笔好坏，不承诺"去 AI 痕迹"。
- 不发明第二套状态文件格式（只认 `.novelweave/`，见 `references/schema-v1.md`）。
- 不在作者确认前改写任何既定事实（见 Hard Constraints 第 5 条）。

散稿要用的话，先建档：`node scripts/nw-io.mjs init --title <书名>`，再把正文放进 `manuscript/chapters/`。

## When to Use

| 用户原话 | 第一个动作 |
|---|---|
| "继续写第三章" | First Steps 全跑一遍，再动笔 |
| "接着上文写" | 同上（先定位书、校验、取上下文文档） |
| "这章有没有矛盾 / 查一下人设有没有崩" | 转 `novelweave-continuity` |
| "林烟火这章受了重伤，记一下状态" | `nw-changes.mjs stage` 提案，等作者 apply |
| "这条伏笔回收了" | 同上（`promise.payoff`） |
| "把这本书导出给织文网页 / 从网页备份导入" | `references/io.md` |
| "这是什么格式？字段什么意思" | 读 `references/schema-v1.md` |

## Hard Constraints（逐条编号，交付前自检）

1. **结构化状态文件是唯一权威**（`book.json` / `bible/*.json` / 章节 frontmatter）。
   正文与状态冲突时，以正文为准修状态，但**必须走 pending 提案**，不许静默改。
2. **状态文件与快照绝不整份进 prompt。** 正文写作只允许消费
   `node scripts/nw-context.mjs --chapter <id> --budget 12288` 产出的那份派生文档。
   长篇必爆的第一原因就是无脑塞全文。
3. **每章状态记录 ≤ 3072 字节**，整份上下文文档 ≤ 12288 字节。超了不是报错，是要
   **如实报告裁掉了什么**（`nw-context.mjs` 的 `droppedSections` / `loreDropped`）。
4. **正文落盘前必须有 `---CHANGES---` 声明。** 缺协议的草稿只允许写到
   `manuscript/drafts/`，不允许直接进 `manuscript/chapters/`。
5. **任何写入前跑 `nw-validate.mjs`；schema 不通过即停**，不得"先写了再修"。
6. **派生字段（`x-*`、`_derived`）只能由脚本写。** 手改会被 `derived-field-touched` 抓到。
7. **不删作者内容。** 冲突时把被覆盖一方写进 `conflicts/`，宁可留垃圾也不丢字。
8. **每条诊断与建议都要引用原文。** 没有原文依据的结论不许输出。

## First Steps（每次被触发都跑这五步）

```bash
# 1. 定位书。找不到就停，告诉用户怎么 init
node scripts/nw-io.mjs locate --json
# 2. 结构校验。退出码非 0 就先修结构，不进写作
node scripts/nw-validate.mjs <bookDir> --json
# 3. 取上下文文档（这是唯一允许喂给模型的长文）
node scripts/nw-context.mjs <bookDir> --chapter next --budget 12288 --write
# 4. 读 manuscript/outline.md 与上一章 frontmatter，确认本章目标
# 5. 写完 → stage → 校验 → 作者 apply
```

第 5 步展开：

```bash
node scripts/nw-changes.mjs stage --file manuscript/chapters/ch-0NN-<slug>.md
node scripts/nw-continuity.mjs <bookDir> --from ch-0NN --json   # 无 error 才继续
node scripts/nw-changes.mjs list                                 # 给作者看提案
node scripts/nw-changes.mjs apply --all                          # 只有作者点头才执行
```

## 章节文件格式

`manuscript/chapters/ch-003-xiashan.md`：

```markdown
---
id: ch-003
number: 3
slug: xiashan
title: 下山
status: draft
pov: char-lin-yanhuo
characters: [char-lin-yanhuo]
mentions: [char-ming-zhang-lao]
locations: [loc-qingwu-shan]
flags: []
summary: 林烟火违师命下山，遇袭失左臂
---
正文……

---CHANGES---
{"chapter":"ch-003","changes":[
  {"op":"state.set","chapter":"ch-003","entity":"char-lin-yanhuo","dim":"injury","to":["左臂断裂"],"evidence":"左臂软软地垂着"},
  {"op":"promise.plant","title":"半枚铜印","setup":"ch-003","weight":"major","evidence":"师父把这半枚印塞给我"}
]}
```

`characters` 与 `mentions` 的区分**不是格式洁癖**：已死角色被"提到"完全正常，
被写成"正在行动"才是矛盾。这个区分就是 `dead-character-on-stage` 能低误报的前提。

## Workflows

### A. 续写一章
1. 跑 First Steps 1–4。
2. 只用「上下文文档 + 上一章尾部 2000 字」写作，**不要**回读更早的全文。
3. 写 `manuscript/chapters/ch-0NN-<slug>.md`，frontmatter 用 `assets/templates/chapter.md.tmpl`。
4. 结尾追加 `---CHANGES---`。没有状态变化也要写 `"changes": []`，表示"本章不改任何既定事实"。
5. stage → continuity → 交给作者 apply。

### B. 修订既有章节
改完必须重跑该章及其后所有章的 `dead-character-on-stage`、`appearance-token-violation`、
`promise-*`（改一处可能牵动后面全部）。

```bash
node scripts/nw-continuity.mjs <bookDir> --from <被改章> --json
```

### C. 登记伏笔 / 角色死亡 / 新增世界条目
一律走 `---CHANGES---` 提案。手工直写 json 只用于**建档**（新建实体），不用于修改已确立的事实。

### D. 与 Web 端交接
见 `references/io.md`。要点：Web 端导出的是单 JSON，`nw-io.mjs import --web` 转成目录树；
反向走 `export`。冲突处理永不覆盖作者内容。

## Reading Map（每条都带加载条件，别无谓消耗上下文）

- 要新增/修改任何字段、或用户问某字段含义 → 读 `references/schema-v1.md`
- 要构造/压缩上下文文档、或抱怨"AI 记不住前文" → 读 `references/context-budget.md`
- 涉及导入导出、双向同步、冲突 → 读 `references/io.md`
- 要写 `---CHANGES---` 但 op 不熟、或某条变更被拒 → 读 `references/changes-protocol.md`
- 用户质疑某条诊断、或要求解释规则 → 读 `../novelweave-continuity/references/rules.md`
- 需要新建文件 → 用 `assets/templates/` 下的模板，别手搓字段
- `locate` 报 `needsMigrate: true` → 立即读 `references/schema-v1.md` 的 Migration 段，停止其他操作

## Scripts 速查

| 命令 | 何时用 | 退出码 |
|---|---|---|
| `nw-io.mjs locate` | 每次开头，确认在哪本书上工作 | 0 找到 / 2 没找到 |
| `nw-io.mjs init` / `import` / `export` / `recount` / `migrate` | 建档、交接、重算派生字段 | 0 / 4 需迁移 / 6 已存在 |
| `nw-validate.mjs` | 任何写入之前 | 0 / 1 有 error / 3 schema 挂 |
| `nw-continuity.mjs` | 每章写完、修订后、以及用户质疑时 | 0 / 1 达阈值 |
| `nw-continuity.mjs explain --rule R1` | 需要向用户解释某条规则 | 0 |
| `nw-context.mjs` | 每次写作前取上下文 | 0 |
| `nw-changes.mjs stage/list/apply/reject` | 状态变更提案闭环 | 0 / 1 有拒 / 6 待确认 |

统一约定：`--json` 走 stdout 纯结果，人类日志走 stderr。**不要解析 stderr。**

## Anti-Patterns

| 错误做法 | 正确做法 |
|---|---|
| 把 `bible/characters/*.json` 全文贴进 prompt | 只贴 `nw-context.mjs` 产出的那份 ≤12KB 文档 |
| 直接改 `character.json` 把 status 改成 deceased | 在草稿末尾发 `character.status` 变更提案 |
| 发现矛盾后顺手改写正文"帮作者修一下" | 报告诊断 + 建议，改不改是作者的决定 |
| 看到 `promise-unpaid` 就自己判定已回收 | 回收判定是语义问题，发 `semantic-payoff-match` 提案让作者确认 |
| 字数用 `content.length` | 用 `NWText.countWords`（中文按字、标点空白不计） |
| 手填 `x-words` / `_derived` | 派生字段只能由脚本重算 |
| 给未建档的人名直接写 `character.status` | 门禁会以"未登记实体"拒绝；先建档 |

## Output Contract（每次交付必须回报这六项）

1. 改了哪些文件（路径）+ 新增的实体 id
2. `nw-continuity` 的诊断计数：error / warn / info / 已豁免
3. `pending.json` 里还有几条等作者确认
4. 本次上下文实际用量与是否发生裁切
5. 章号与字数变动（前 → 后）
6. 下一步建议动作（只提一个最重要的）

不要把诊断原文全部粘进回复；超过 5 条就给计数 + 最严重的 5 条 + 让用户跑 `--json` 看全量。
