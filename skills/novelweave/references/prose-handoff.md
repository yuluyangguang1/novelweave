# 文体交接（nw-prose）

## 为什么要有它

本 skill 不判断文笔，这条边界从来没变过。变的是**"不判断"不等于"不管"**：
以前 SKILL.md 只写了一句"文笔诊断让位给文体分析类 skill"，没有任何机制，
实际结果是续写完一章没人看文字质感，那一章带着 AI 味就进稿了，而且事后
没有任何地方能回答"这几章到底查过没有"。

`nw-prose` 补的是那段缺失的管道：**探测 → 交接 → 记录**。它自己不做任何文体判断。

## 四个子命令

```bash
node scripts/nw-prose.mjs probe                       # 本机有什么引擎可用，不可用的说清为什么
node scripts/nw-prose.mjs packet --chapter ch-007     # 取这一章的交接包
node scripts/nw-prose.mjs record --chapter ch-007 \
     --engine story-deslop --result issues --findings 6
node scripts/nw-prose.mjs status                      # 台账：哪些章查过、结论是否还成立
```

`--home DIR` 把探测指向别的 HOME（测试与多账户机器用），不影响别的子命令。

## 探测的判据：有名字不算有

`probe` 只看两类证据：

- **CLI**：PATH 上真找得到那个可执行文件。
- **技能**：技能目录存在**并且**它声明的清单文件至少有一个在盘上。

第二条是刻意设计的。实测这个生态里"技能目录在、能力不在"非常常见——
某技能自称集成了去痕引擎与风格库，包内却只有一个 `SKILL.md` 和一份 manifest，
声称的四个目录一个都不存在。按名字判断就会把交接交给一个空壳。
这类结果会带 `usable: false` 和 `why: 技能目录在，但声明的清单文件一个都不存在…`。

技能根按 `~/.qoder|.claude|.codex|.openclaw|.hermes|.workbuddy|.cursor|.zcode/skills` 扫，
深度 2，因此 Hermes 的 `skills/<类别>/<技能>/` 嵌套布局也探得到。
清单里标了 `network: true` 的引擎默认要连远端 API，离线机器上不要指望它。

## 交接包里有什么

`packet --json`：`file`（章节正文路径，不内联正文）、`engine`（选中的引擎与它的用法和清单文件）、
`boundary`（四条边界）、以及跑完该怎么 record 的确切命令。

选引擎规则：`--engine <id>` 指定就用指定的，**即使它不可用也不换一个顶上**——
作者点名要的那个失败，比悄悄换成另一个更有用。没指定时取第一个可用的；一个都没有则
`engine: null`，输出直接引导你记一条 `skipped`。

四条边界（`BOUNDARY`，唯一一处定义）：

1. 只诊断，不替作者改写正文；要改由作者点头。
2. 本 skill 不判断文笔好坏，清单来自被交接的引擎。
3. 改完必须重跑 `nw-continuity` —— 换句子会挪动证据偏移，R1/R7 的定位跟着失效。
4. 结论必须 `record` 回台账。

## 台账 `continuity/prose.json`

```json
{ "schemaVersion": "1",
  "byChapter": { "ch-007": {
    "contentHash": "sha256:…", "engine": "story-deslop",
    "result": "issues", "findings": 6, "note": "", "at": "2026-08-29T…" } } }
```

- **每章只留最新一条**。历史交给 Web 端的正文版本与 git，这里不重复造一套。
- `contentHash` 用 `NWProject.hashRecord('chapter', …)`，与同步基线同一算法。
  所以正文一改，`status` 立刻把该章判成 `stale`（"正文已改，结论过期"）——
  查完之后又重写，旧结论不能再算数。
- 不足 200 字的章节不进台账：大纲章没有文字可查。
- `record` 的入参是硬的要跳过得留原因：`--result skipped` 必须带 `--note`；
  `--result issues` 必须带 `--findings N`。跳过和有问题都是要能被追问的事实。

## 它不是门禁

`status` **恒退 0**，即使有章查出问题。门禁仍然是 `nw-continuity` 的机器规则。
把文体状态接进退出码会让 CI 因为"这台机器没装第三方技能"而变红，那是假失败。

同理，`prose.json` **不进导出树**、也不参与作者内容哈希（有测试钉住这两点）。
一旦它进了同步基线，每次跑文体检查都会给所有相关章节造出幻影冲突。

## Web 端目前看不到这个台账

织文界面读的是 IndexedDB，`prose.json` 只在目录侧。作者要在网页里看文体状态，
目前只能把 `status` 的输出贴过去。补齐需要一个新的库表与面板，已记在
`docs/roadmap.md` 未解项。
