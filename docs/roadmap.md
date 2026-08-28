# 路线图

README 只写已经能用的一切；这个文件写还没做的。

## 已完成

**阶段一 — 止血 + 定契约**

- 共享实现层 `src/core/text.js`、`src/core/bible.js`（UMD，浏览器与 Node 同一份代码）
- Story Bible v1：`schemas/story-bible.v1.json` + `skills/novelweave/references/schema-v1.md`
- 前端主流程修通：AI 工具箱、创建作品、四个侧栏面板、章节深链与刷新恢复、
  字数统计、注入面收口
- 续写的上下文召回：前文结尾 + 本章已写正文 + 按关键词触发的世界设定，带字节预算
- 零依赖测试：`node --test tests/*.test.mjs`

**阶段二 — 技能与连续性引擎**

- `src/core/rules.js`：10 条机器规则（死人出场、状态矛盾、伏笔未回收/逾期未收、
  payoff-before-setup、外貌区间违规、未登记实体、结构非法、引用断链、派生字段被手改、
  schema 非法先全停）与 LLM 补充诊断共用同一个 diagnostic 信封，但只有机器规则计入退出码
- `skills/novelweave/`（主编排）与 `skills/novelweave-continuity/`（只读校验），
  各带 `references/` 与 `assets/templates/`
- `scripts/nw-*.mjs`：io / validate / continuity / context / changes 五个零依赖 Node CLI，
  统一 stdout 出结果、stderr 出日志，退出码约定一致
- `---CHANGES---` 变更声明协议：解析 → 六道门禁 → 写 `pending.json` → **作者确认才落地**
- `tools/install.mjs` 表驱动分发：Claude Code、Qoder、OpenClaw、Hermes、WorkBuddy、
  Codex CLI、Cursor。仓库内不放任何 agent 镜像目录（有测试钉住）
- 验证：`node --test` 84 项全绿；装进 `~/.qoder/skills/` 后，在**另一个会话**里用自然语言
  提"帮我看看有没有前后矛盾"即被正确触发，只读跑通并准确报出"明长老死于 ch-001
  却在 ch-002 推门进内堂"，且未修改任何文件

## 阶段三 — Web 端接上同一套状态

- Story Bible 面板：时间线、伏笔登记表、角色状态矩阵；诊断可点击跳到正文对应位置
- 导入/导出 `.novelweave/`：优先 File System Access API，退化为单 JSON 导出 / 目录导入
- 三方合并与 `conflicts/`：以较新者为主，但被覆盖一方必先留存 —— 正文不可再生
- 上下文预算可视化：本次注入了哪些条目、多少字节、裁掉了什么
- 流式可用性：中断、失败重试、temperature 可调、token 用量提示
- PWA：`manifest.webmanifest` + `sw.js` + 图标。**做完之前，README 不写「PWA 可安装」**

## 已知未解

- **WorkBuddy**：本机实测布局为 `~/.workbuddy/skills/<name>/{SKILL.md,scripts/}`，
  frontmatter 顶层带 `version`，分发表已按此对齐。但它的格式文档没找到公开来源，
  置信度标的是 `observed-locally` 而不是 `verified`——换台机器可能要重看。
- **ZCode**：本机 `~/.zcode` 下没有用户级 skills 目录，技能只出现在
  `~/.zcode/cli/plugins/cache/<publisher>/<plugin>/<version>/skills/<skill>/` 这种插件路径里。
  伪造 publisher/version 目录属于猜测，所以安装脚本对它**只打印手动指引、不写文件**。
- 还有四条机器规则未实现（跨章瞬移、关系矛盾、物品失而复得、称谓越界），
  以及时间线单调性检查因锚点密度不足而暂缓 —— 清单见
  `skills/novelweave-continuity/references/rules.md` 末尾「尚未实现的机器规则」。
  别把这些当成"检查过了没问题"。
- 语义级矛盾（动机漂移、对白口吻跳人）只能靠 LLM，标 `source:"llm"` 且不进 CI 门禁。
- 世界书的 `recursive_scanning`（触发出的内容再触发别的内容）未实现，当前只做单层扫描。
- Web 端目前还不能读写 `.novelweave/`，双向同步要等阶段三；现在只有
  「Web 导出 JSON → `nw-io import`」这一个方向是通的。
