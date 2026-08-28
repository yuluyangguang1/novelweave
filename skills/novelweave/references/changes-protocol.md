# `---CHANGES---` 变更声明协议

模型写完正文后，在文件末尾追加一段结构化声明，描述**这一章改变了哪些既定事实**。
`nw-changes.mjs` 负责解析、过门禁、排队，等作者确认后 `apply` 才写进状态文件。

## 为什么要这么绕

两个需求天然冲突：
- 长篇一致性要求状态被及时更新，否则下一章写作看不到"左臂断了"这个事实；
- "作者掌控"要求 AI 不能自行改写既定事实。

提案制是唯一同时满足两者的做法：**AI 自动发现并提议，作者一键确认**。
`apply` 之前状态文件不动，所以模型判断错了也不会污染书。

## 格式

正文之后，独占一行 `---CHANGES---`，紧跟一个 JSON 对象：

```
---CHANGES---
{"chapter":"ch-003","changes":[ … ]}
```

没有状态变化时也要写 `"changes": []` —— 这表示"我检查过了，本章不改任何既定事实"，
与"忘了写"是可区分的。

## 支持的 op

| op | 必填 | 可选 | 效果 |
|---|---|---|---|
| `character.status` | `id`,`to`,`evidence` | `died-in` | 改角色状态；`to:"deceased"` 时自动补 `died-in` |
| `character.alias.add` | `id`,`text`,`evidence` | `kind`,`who`,`note` | 加别称（含"仅某人可这样称呼"） |
| `promise.plant` | `title`,`setup`,`evidence` | `weight`,`due` | 埋一条伏笔，status 自动 `planted` |
| `promise.payoff` | `id`,`chapter`,`evidence` | — | 标记回收 |
| `promise.drop` | `id`,`evidence` | `reason` | 明确弃用 |
| `state.set` | `chapter`,`entity`,`dim`,`to`,`evidence` | `remove` | 写分章状态快照某维度 |
| `world.destroy` | `id`,`chapter`,`evidence` | — | 地点被摧毁/消失 |

`evidence` **每条都必填**，必须是正文里能找到的一句原话。它既给作者核对用，
也是防止模型凭空制造事实的闸。

`state.set` 的 `dim` 只允许 v1 六维：`loc` / `alive` / `injury` / `items` / `knows` / `goal`。
`injury` / `items` / `knows` 是列表，配 `remove: true` 可移除元素。

## 六道门禁（`stage` 与 `apply` 各跑一次）

1. **协议可解析** —— 有标记、JSON 合法、`changes` 是数组。
2. **op 名已知** —— 不在上表里的直接拒。
3. **引用存在** —— `id` / `chapter` / `setup` / `entity` 必须指向已存在的实体或章节。
   模型最爱犯的错就是顺手编一个 `char-xxx`。
4. **值域合法** —— `to` 必须在枚举里；`dim` 必须在六维里。
5. **必须有 evidence** —— 缺依据句的变更拒收。
6. **apply 前复检** —— stage 与 apply 之间书可能被人改过，所以再过一遍；
   复检不过就 `skipped` 并说明原因，不会写坏。

## 命令

```bash
node scripts/nw-changes.mjs stage --file manuscript/chapters/ch-003-x.md [--book DIR]
node scripts/nw-changes.mjs list [--json]
node scripts/nw-changes.mjs apply --all | --id ch-003-x.md#0,ch-003-x.md#2 [--dry-run]
node scripts/nw-changes.mjs reject --id <id> --reason "不是死亡，是假死"
```

退出码：`0` 全部通过且无待确认 · `1` 有被拒/被跳过 · `6` 有 staged 项等作者决定。

## 作者视角该看到什么

给作者看提案时，**必须**同时给出：这条变更的 `evidence` 原句、以及它将改动哪个字段。
不要只说"我更新了人物状态"。示例：

```
待确认 2 条：
· ch-003#0 state.set 林烟火.injury += 左臂断裂
    依据：「左臂软软地垂着，握不住剑。」
· ch-003#1 promise.plant「涧底的钟声」weight=major
    依据：「钟声只响了一次，就再没有第二声。」
被拒 1 条：
· ch-003#2 character.status char-ghost → 角色「char-ghost」未登记
```
