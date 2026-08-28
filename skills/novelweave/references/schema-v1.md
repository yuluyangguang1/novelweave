# Story Bible v1

织文的**文件形态**书目格式。放在用户工作区的 `.novelweave/` 下，让命令行 agent
与浏览器 Web 端读写同一本书，不需要任何服务器。

机器可读定义：`schemas/story-bible.v1.json`（用 `NWBible.validate` 校验）。
双端共用实现：`src/core/bible.js` + `src/core/text.js`（浏览器与 Node 加载同一份代码，
因此 Web 面板与 agent 脚本产出的字节必然一致，`sync.json` 的哈希才能互通）。

## 三条公理

1. **正文用 Markdown + frontmatter，状态用 JSON。** 正文要给人读、要能被 agent 直接
   `Edit`；状态要机器可校验，必须是 JSON。
2. **作者字段与派生字段物理隔离。** 机器产出只落在 `_derived` 顶层块或 `x-*` 前缀键。
   作者和 agent 手改正文/档案永远不会与脚本产出打架；同步时只需比对作者字段。
3. **稳定 ID 优先于路径。** 每条记录带 `id`（等于 IndexedDB 主键），文件名只是可读别名。
   Web↔文件双向同步靠 `id` 对齐，不靠 slug。

## 目录树

```
.novelweave/
  project.json                    # 书注册表，唯一入口；agent 从 cwd 向上找它
  <book-slug>/
    book.json                     # 书目元数据 + _derived
    _index.md                     # 人读的域注册表
    manuscript/
      outline.md                  # 卷/幕级大纲
      chapters/ch-001-<slug>.md   # 正文 + frontmatter
    bible/
      characters/<id>.json        + _index.json
      world/<id>.json             + _index.json（书级 scan_depth / token_budget）
      promises.json               # 伏笔登记表
      states.json                 # 分章状态快照
      timeline.json               # 时间锚点
      lexicon.json                # 名字 → 实体 id 的唯一判定表
    continuity/
      snapshot.json               # 最近一次校验汇总（派生，可删重建）
      reports/<时间戳>.json        # 历次诊断报告
      suppressions.json           # 作者显式豁免（「这是闪回，别再报」）
      pending.json                # 待作者确认的变更提案队列
    meta/
      sync.json                   # 三方合并的祖先指纹表
      changelog.jsonl             # 追加式变更记录
conflicts/                        # 仅在有冲突时生成；Web 与 agent 都只写不删
```

## frontmatter 子集

只用 YAML 的一个极小子集，**不支持嵌套映射**（章节头不需要它，加了只会让双端各写一套解析器）：

- `key: 标量` — 字符串、整数、布尔、`null`
- `key: [a, b]` — flow 序列
- `key:` 换行后 `  - 项` — 块序列

需要结构化的地方一律拆成扁平键：时间锚点用 `time_anchor: ev-003`（字符串），
不用 `time: { anchor: ... }`。

## 章节 frontmatter

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | `ch-NNN` 或迁移过来的 `ch_<老主键>` |
| `number` | ✓ | 正整数，全书唯一且连续 |
| `title` | ✓ | |
| `status` | ✓ | `outline` / `draft` / `revised` / `final` / `complete` |
| `slug` | | kebab-case，用于文件名 |
| `pov` | | 视角角色的 id，可空 |
| `time_anchor` | | 指向 `timeline.json` 的锚点 id，可空 |
| `characters` | | **本章实际出场并有行动**的角色 id |
| `mentions` | | 仅被提及、未出场的角色 id |
| `locations` | | 本章涉及的世界条目 id |
| `flags` | | `flashback` / `dream` / `quoted` / `offscreen` / `montage` |
| `summary` | | ≤400 字，供后续召回；「总结本章」的结果写在这里 |
| `x-words` | | 派生，勿手改 |
| `x-updated` | | 派生，勿手改 |

`characters` 与 `mentions` 的区分是**「死人出场」规则能低误报的前提**：已死角色被
「提到」是正常的，被「写到正在行动」才是问题。`flags` 里的 `flashback`/`dream`
是连续性检查的豁免开关。

## 上游标准对齐

- **角色卡**的 `role` / `status` / `died-in` 取自 story-skills 的 `story.schema.json`
  枚举（`protagonist|antagonist|deuteragonist|supporting|minor|narrator`，
  `alive|deceased|unknown|missing`）。
- **世界条目**的字段名严格超集于 Character Card V2 的 `character_book.entries[]`
  （`keys` / `secondary_keys` / `selective` / `constant` / `position` /
  `insertion_order` / `priority` / `enabled` / `case_sensitive`）加书级的
  `scan_depth` / `token_budget` / `recursive_scanning`。**故意不改名**，
  这样「导出为 lorebook」就是纯字段搬运。
- 我们自己加的字段：`appearance.tokens[].{since,until}`。上游没有这个，但它是把
  「断臂在第 4 章断了、第 9 章又写她双手抱胸」变成机器可判的唯一办法。
- 我们自己加的字段：`role_zh`。`role` 是英文枚举，而 Web 界面用中文定位（主角/配角/
  反派/导师/龙套）。不保留原标签的话，导出再导入一次就把作者写的中文标签永久丢掉。
  因此角色卡同时存 `role_zh`，回读时优先用它还原显示值。

## 体积纪律

长篇必爆的第一原因就是无脑把全书塞进 prompt。因此：

- 派生给写作用的上下文文档 ≤ **12288 字节**（`MAX_CONTEXT_BYTES`）
- 每章每实体的状态记录合计 ≤ **3072 字节**（`MAX_STATE_BYTES_PER_CHAPTER`）
- 结构化状态文件**永远不整份进正文 prompt**，只喂派生的上下文文档

超预算不是报错，是**如实上报被裁掉了哪些条目**（`loreTrigger` 返回 `dropped`）。
静默丢上下文的检查器会把作者坑在看不见的位置。

## 从现有 IndexedDB 迁移

Web 端目前的 5 个 store 到新格式的映射。完整字段表在实现导出时以本文件为准，
这里列迁移规则与新增字段的默认值。

### `novels` → `book.json`

| 旧字段 | 新字段 | 处理 |
|---|---|---|
| `id` | `id` | 保留，作为跨端主键锚点 |
| `title` / `genre` / `description` | 同名 | 直接搬 |
| `word_count` / `chapter_count` | `_derived.words` / `.chapters` | **一律重算，不信旧值**（旧版增量记账已经把它弄错过） |
| `created_at` / `updated_at` | `created` / `updated` | 毫秒 → ISO-8601 UTC |
| — | `schemaVersion` | 新，`"1"` |
| — | `slug` | 新，由 `title` 生成；为空则 `book-<id 后 6 位>` |
| — | `language` | 新，默认 `"zh-CN"` |
| — | `audience` / `target` / `voice` | 新，默认 `""` / `{chapters:0,wordsPerChapter:3000}` / 空对象 |

### `chapters` → `manuscript/chapters/*.md`

| 旧字段 | 新字段 | 处理 |
|---|---|---|
| `id` | frontmatter `id` | 保留旧主键（不强制改写成 `ch-001`），`number` 另给 |
| `title` | `title` | 直接搬 |
| `content` | Markdown 正文体 | **原样搬，不转义不重排** |
| `order` | `number` | 先 `resequenceChapters` 去重补洞再落号（旧版 `order = length + 1`，删过首章后新建必撞号） |
| `word_count` | `x-words` | 用 `countWords` 重算（旧口径是 `content.length`，把换行标点都算进去了） |
| `updated_at` | `x-updated` | 毫秒 → ISO；`created_at` 进 `meta/changelog.jsonl` |
| `novel_id` | — | 隐含在目录，不落字段 |
| — | `status` | 新，默认：有正文则 `draft`，否则 `outline` |
| — | `characters` / `mentions` / `locations` / `flags` / `summary` / `pov` / `time_anchor` / `slug` | 新，默认 `[]` / `[]` / `[]` / `[]` / `""` / `null` / `null` / 由 title 生成 |

### `characters` → `bible/characters/<id>.json`

| 旧字段 | 新字段 | 处理 |
|---|---|---|
| `name` / `personality` / `appearance` / `background` / `notes` | 同名 | `appearance` 落到 `appearance.summary`，`tokens` 留 `[]` 需后补（不自动切词，避免脏 token） |
| `role`（中文） | `role`（英文枚举） | 映射：主角→`protagonist`，反派→`antagonist`，配角→`supporting`，导师→`deuteragonist`，龙套→`minor`。未知值→`minor` 并记一条 `mapping-needed` 到 `pending.json`，不静默归类 |
| `id` | `id` | 保留 |
| `created_at` | `created` | 毫秒 → ISO |
| — | `status` | 新，默认 **`alive`**（取 `unknown` 会让「死人出场」规则全线静默，故取保守可用值） |
| — | `died-in` / `first` / `aliases` / `voice` / `gender` / `age` / `goals` | 新，`null` / `null` / `[]` / `{}` / `null` / `null` / `""` |
| — | `enabled` | 新，默认 `true` |
| — | `slug` | 新，ASCII 可转则转，否则 `c-<id 后 6 位>` |

### `worldbuilding` → `bible/world/<id>.json`

| 旧字段 | 新字段 | 处理 |
|---|---|---|
| `name` | `name` + `comment` + `keys[0]` | **一名三写**：显示名、V2 的 comment、主触发词 |
| `description` | `content` | 直接搬 |
| `type` | `type` | 值域已一致（`location`/`faction`/`rule`/`system`），新增 `item`/`creature`/`custom` |
| `details` | `details` | 直接搬（当前是死字段，保留兼容） |
| — | `constant` | 新，默认 `type` 为 `rule` 或 `system` 时为 `true`（力量体系与法则应当无条件在场） |
| — | `selective` / `secondary_keys` / `position` / `insertion_order` / `priority` / `enabled` / `case_sensitive` | 新，`false` / `[]` / `before_character_definition` / `100 + index*10` / `0` / `true` / `false` |
| — | `lifecycle` | 新，`{destroyed-in:null, revealed-in:null}` |

### `notes` → 分流

`tags` 含「伏笔」的笔记 → 生成 `promises.json` 条目，`weight: "candidate"`
（脚本自动登记、等作者确认，不冒充正式登记表）。其余落 `meta/notes/`，
不参与校验，只在 `_index.md` 列出。

### 全新域

`promises.json` / `timeline.json` / `states.json` / `relations.json` / `lexicon.json`
在旧库里**没有对应数据**。导入旧备份时这些文件落成 `{schemaVersion, items:[]}`
之类的空壳，不报错、不猜测。

## 校验器范围

`NWBible.validate` 是手写的 JSON Schema 子集，只实现：
`type` `properties` `required` `additionalProperties`（布尔与对象两种形式）
`enum` `const` `pattern` `minLength` `maxLength` `minimum` `maximum`
`items` `minItems` `uniqueItems` `$ref`（仅本地 `#/…`）`nullable`。

遇到未实现的关键字（如 `oneOf`、`allOf`、`if/then`）会**作为违规报出来**，
而不是静默放过 —— 一份会撒谎的 schema 比没有 schema 更危险。
有条件约束需求（例如 `status=deceased` 时 `died-in` 必填）请写成规则代码，
不要硬塞进 JSON Schema。
