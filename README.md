# NovelWeave · 织文

AI 驱动的网文创作辅助工具。

## 定位
不是"一键生成"的玩具，而是**严肃的写作工作台**。帮助网文作者：
- 管理庞大的世界观（角色/势力/地点）
- 维护长篇一致性（防止人设崩塌、前文矛盾）
- 辅助日常写作（续写卡壳、润色、风格统一）

## 定位补充
- **语义检索(可选)** —— 配置 embeddings 端点后,相关旧章按语义召回(硅基流动 bge 系列免费);未配置自动降级词频方案,写作永不因检索失败而中断。
- **信息控制与决策记录** —— 每章可声明"读者知道/主角知道/必须隐瞒/只能暗示"，隐瞒项自动成为续写硬禁令；创作决策当场记档、推翻留痕。

- **长短皆织** —— 长篇连载与短篇（3k–30k 字）同一套工作台；短篇模式自动换挡上下文与规则阈值，前情全量注入、钩子检查按"屏"评估。

## 核心原则
- **作者掌控** — AI 只提供建议，作者决定最终文字
- **一致性优先** — 维护角色设定、世界规则、剧情线
- **写作流保护** — 任何 AI 辅助都不打断作者的沉浸感

## 技术路线
- 纯前端，零构建、零依赖 — 用静态服务器托管后打开即用，也可以直接双击 `index.html`
- BYOK（用户自带 API Key，浏览器直连 OpenAI 兼容接口）
- IndexedDB 本地存储（支持大文本）
- PWA：可离线、可安装（`manifest.webmanifest` + `sw.js`，图标由 `tools/make-icons.mjs` 程序生成）

## 本地运行与离线使用

任何静态服务器都行，例如：

```bash
python -m http.server 8080
# 或
npx serve .
```

然后访问 http://localhost:8080 。首次打开会先进设置页让你填入 API Key（Key 只存在本机浏览器）。

## Story Bible：与 agent 共享同一本书

织文的权威存储是浏览器里的 IndexedDB，但作品可以同时以**文件形态**存在
`.novelweave/` 目录里，供命令行 agent 直接读写：正文是 Markdown + frontmatter，
结构化状态（角色/世界/伏笔/时间线/状态快照）是 JSON。

- 格式定义：`schemas/story-bible.v1.json`
- 字段说明与从 IndexedDB 的迁移映射：`skills/novelweave/references/schema-v1.md`
- 双端共用的实现：`src/core/text.js`、`src/core/bible.js`（浏览器与 Node 加载同一份代码）

## Agent 技能

`skills/` 是单一权威技能源，包含两个技能：

- `novelweave` —— 在已有 `.novelweave/` 的书上续写、修订、维护 Story Bible、走 `---CHANGES---` 提案
- `novelweave-continuity` —— 只读连续性检查，不改任何文件

安装（表驱动落位，仓库内不保存任何 agent 镜像目录）：

```bash
node tools/install.mjs --all --dry-run     # 先看会做什么
node tools/install.mjs --only=qoder        # 或 --all
node tools/install.mjs --status --json     # 查已装状态
node tools/install.mjs --uninstall         # 只删自己装的，指针块精确切除
```

权威源先物化到 `~/.novelweave/skills/`，再落位到各 agent 的官方目录；每个技能装完
自带 `scripts/`、`src/core/`、`schemas/`，可独立运行。

| Agent | 落位 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/skills/` + `CLAUDE.md` 指针块 | 指针只追加，不动你原有内容 |
| Qoder | `~/.qoder/skills/` | |
| OpenClaw | `~/.openclaw/skills/` | 与 Claude Code 同规范 |
| Hermes | `~/.hermes/skills/writing/<skill>/` | 该 agent 要求 `category/` 嵌套与顶层 `version` |
| Codex CLI | `~/.codex/AGENTS.md` 指针块 | 无 skill 载体 |
| Cursor | 项目内 `.cursor/rules/novelweave.mdc` | 需在你的书项目目录下运行；在本仓库内运行会被拒绝 |
| WorkBuddy | `~/.workbuddy/skills/` | 布局按本机实测对齐；格式文档未公开，置信度标为 observed |
| ZCode | **不自动安装** | 本机未见用户级 skills 目录，只打印手动指引，不凭猜测写文件 |

## 状态与路线图

README 只描述**已经能用**的能力。计划在做什么、还缺什么，统一写在 `docs/roadmap.md`，
避免文档和实现各说各话。

## 测试

```bash
node --test tests/*.test.mjs
```

零依赖，只用 Node 内置模块。
