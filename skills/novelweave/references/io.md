# 导入导出与双向同步

织文有两个存储：浏览器里的 IndexedDB（写作时的权威），和磁盘上的 `.novelweave/`
目录树（agent 读写、可进 git）。两者靠**单文件备份 JSON** 与**目录树**互转。

## 已有散稿 → 建档（adopt）

手上已经有一堆 `.md` / `.txt` 章节的人，从这里进来：

```bash
node scripts/nw-io.mjs adopt <草稿目录> --title 书名 [--genre 仙侠] [--dir 项目根] [--dry-run]
```

三条保证：

1. **草稿只读**。源文件一个字节都不改，写出去的全在新书目录，整目录删掉即可重来。
   先跑 `--dry-run` 看报告，确认无误再落盘（`--dry-run` 真的不写盘，有测试钉着）。
2. **章号不被平移**。`第N章` / `001-` / `Chapter 7` 都认；`楔子/序章/引子` 取 `number 0`，
   `尾声/后记` 取 `max+1` —— 这两个位置不动作者已有的编号。
3. **判不出来的不猜**。没有章号又不是楔子/尾声的文件直接**拒绝建档**（退出码 2）；
   重号也拒 —— 章号就是 id，重号等于两章抢同一个 id 互相覆盖。
   报告里的 `待人工确认` 项（跳号、短到可疑、无标题）会让命令以退出码 6 结束，逼人来处理。

产物除了章节文件，还有 `meta/adopt-report.json`：统计、issues、以及**人名候选**
（与 R9 共用 `NWRules.entityCandidates`）。候选只是线索，不等于角色 —— 地名没有可靠
抽取器（门/城/山 与普通名词高度重叠），需自行补进 `bible/world`。

建完立刻要做：处理 issues → 补角色卡与世界条目 → 每章填 `summary` →
`nw-validate.mjs` 与 `nw-continuity.mjs` 各跑一遍。

## Web → agent

设置页「导出全部作品备份」产出一个 JSON：

```json
{ "app": "novelweave", "schemaVersion": 1, "exportedAt": "…",
  "data": { "novels": […], "chapters": […], "characters": […],
            "worldbuilding": […], "notes": […] } }
```

转成目录树：

```bash
node scripts/nw-io.mjs import --web --file novelweave-backup-2026-08-28.json --dir <项目根>
```

迁移时做了这些事，**agent 不需要也不该重做**：

- 章号按旧库 `order` 重排为连续 `number`（旧版 `order = length + 1`，删过首章后必然撞号）
- `word_count` 一律重算，不信旧值（旧版增量记账把总数弄错过）；`_derived` 由 `recomputeDerived` 统一产出
- 角色 `role` 中文→英文枚举（主角→protagonist 等）；映射不到的落 `minor` 并记 `_derived.role-mapping-needed`，**不静默归类**
- `appearance` 文本落 `appearance.summary`，`tokens` 留空待补（不自动切词，避免脏 token）
- 世界条目 `name` 一名三写：`name` / `comment` / `keys[0]`；`type` 为 `rule`/`system` 的默认 `constant: true`
- 带「伏笔」标签的笔记 → `promises.json` 里 `weight: "candidate"` 的条目，等作者确认；其余落 `meta/notes/` 不参与校验
- `promises/timeline/states/relations/lexicon` 这些旧库没有的域，落成空壳，不猜测

导入后立即校验：

```bash
node scripts/nw-validate.mjs <bookDir> --json
```

## agent → Web

```bash
node scripts/nw-io.mjs export --book <bookDir> --out ./exports
```

产出带日期后缀的目录副本与 `treeHash`。导回浏览器需要 Web 端的导入 UI（阶段三）。
在那之前，Web 与 agent 之间的**唯一交汇点**是：Web 导出 → `nw-io import` → agent 干活。

## 冲突处理：永不覆盖作者内容

场景：agent 改了 `ch-007` 的文件，而浏览器里 `ch-007` 也有更新的版本。

策略（写死在实现里，不要临场发挥）：
1. 以 `updated_at` 较新的一方为主；
2. **但被覆盖的那一方先落 `conflicts/<记录id>-<web|agent>.json`**；
3. Web 端顶部提示"有 N 处冲突待处理"。

理由：正文是不可再生资产，宁可留一份垃圾，也不能丢一个字。

`meta/sync.json` 里每条记录存 `hash = sha256(canonicalJson(authorFields(record)))`。
只哈希作者字段（剔除 `x-*`、`_derived`、`schemaVersion`、`updated`），这样脚本重算派生值
不算冲突。`canonicalJson` 与字段切分在 `src/core/text.js` / `src/core/bible.js`，
**浏览器和 Node 跑的是同一份代码**，所以两边产出的哈希字节一致。

## 目录必须保持的形状

```
.novelweave/project.json          ← 唯一入口，agent 从 cwd 向上找它
.novelweave/<slug>/book.json
.novelweave/<slug>/manuscript/chapters/ch-001-<slug>.md
.novelweave/<slug>/bible/{characters,world}/*.json + _index.json
.novelweave/<slug>/bible/{promises,states,timeline,lexicon,relations}.json
.novelweave/<slug>/continuity/{snapshot,suppressions,pending}.json + reports/
.novelweave/<slug>/meta/{sync.json,changelog.jsonl}
```

- 文件名里的 slug 只是可读别名，**对齐靠 `id`**，不要靠文件名猜。
- `_index.json` 是派生索引，手改无意义（会被 `refreshIndex` 覆盖）。
- 所有写操作走原子写（tmp + rename），中途崩溃不会留下半个文件毁掉一本书。
