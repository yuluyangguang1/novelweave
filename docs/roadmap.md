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

**阶段三 — Web 端接上同一套状态**

已做到：

- IndexedDB 升到 v2：角色卡加 `status / died-in / first / aliases / appearance_tokens / enabled`，
  新增 `promises` / `timeline` / `suppressions` 三张表。老库就地升级，不破坏性迁移，
  缺字段在读取时补默认值
- 连续性面板：浏览器里跑**同一份** `rules.js`，诊断按严重度列出，点击可跳到该章并选中依据句；
  「豁免」按 fingerprint 写库留痕，之后不再重复提示但报告里仍计数
- 伏笔登记表：状态 / 分量 / 埋设章 / 回收章 / 期限 / 原文依据，是 promise 两条规则的数据来源
- 角色表单补齐 R1 与 R7 的输入：死亡章节、首次出场、别称、外貌特征区间
  （`特征词 | 从第N章 | 到第M章` 行式编辑）
- `.novelweave/` 导出与导入：优先 File System Access API，不支持时退回单文件目录树 JSON。
  导入走逐条三方比较（base 取自导出时写的 `meta/sync.json`），
  **两侧都改过的记录不自动选边**，本地版保留、文件版连同本地版落到 `conflicts/` 并额外下载一份
- 上下文用量可视化：每次续写显示注入/未注入哪几节、多少字节，被裁掉时给黄标警告；
  失败给「重试」按钮；写作温度可调并持久化
- 备份导入补齐（原先只有导出），且备份表清单改由数据层推导，避免加表时静默漏备份
- PWA：`manifest.webmanifest` + `sw.js` + 程序生成的图标。静态资源用 network-first
  （`app.css?v=1` 是个永不变化的参数，cache-first 会让改过的样式长期是旧的）；
  跨域与非 GET 请求一律不碰，BYOK 调用必须直达服务商

**补齐（阶段三之后）**

- 时间线面板：锚点的增删改（章 / 第几天 / 时辰 / 所属线 / 置信度）
- R6 `timeline-regression`：同一叙事线时间倒流。不同 `thread` 永不互比，
  `implied` 只出 info，闪回章跳过，回退后不回写最大值以免连锁误报
- 章节「出场 / 仅提及 / 地点」声明面板（编辑器 🎭）。此前 R1 最强的那个信号
  只能由 agent 通过 `---CHANGES---` 写，作者自己反而声明不了
- 两处数据保真修复：导入按正文重算字数（不照抄文件里过期的 `x-words`，
  Web 端没有 `recount` 命令可修）；启动 self-heal 连每章 `word_count` 一起修
  （原先只修总数，漂移的章节会让 R16 长期误报、列表显示错数字）
- 状态矩阵（`states`）：IDB v3 一行一个「章节×实体」，主键 `章节|实体` 以便按记录
  合并；矩阵总览 + 分章六维编辑，字节数随输入实时刷新，超 3072 黄标。
  R2 的「快照与角色卡互斥」这一半此前在 Web 端从未被触发，现在有界面能填了
- 测试补了一条语法守卫：把 `index.html` 加载的每个脚本用 `vm.Script` 解析一遍。
  起因是 app.js 里多一个右括号让整页函数消失，而当时 110 项测试全绿——
  因为没有任何测试会把 app.js 当脚本解析

**界面设计对齐官网（yu.ai / shared.css）**

- 令牌照抄官网一份：纸墨黑 `21 14 7`、宣纸白 `243 237 226`、淡墨、朱砂 `242 99 78`、
  藤黄、胭脂；浅色主题走宣纸底 + 浓墨字 + 印泥红，跟随 `prefers-color-scheme`
- 语言：方角（圆角最多 2px）、发丝分隔线、无阴影；标题与正文用霞鹜文楷（衬线），
  导航与标签用等宽小字 + 字距 + 大写；列表用发丝线分隔的整块可点区域
- **代价（已知并接受）**：令牌是复制的，不是引用 `../shared.css`。因为本仓库是独立
  子模块，要能单独 clone 与离线当 PWA 用，引用官网根路径会两边都坏。
  官网改配色时这里要跟着改一次。
- 图标：界面**全面去除 emoji**，改为一期内联的 SVG sprite（`index.html` 里一组 24×24
  描线 `symbol`，`app.js` 用 `<use>` 引用）。emoji 是彩色位图字形，压在墨色配色上必然跳；
  图标不带颜色属性，描线由 CSS `stroke: currentColor` 继承，因此自动跟随主题与强调色。
  **刻意不引外部图标库**（同级 linger 用了 unpkg 的 lucide）——那会破坏离线 PWA 与零依赖。
- 新增守卫测试：`index.html` / `app.js` / `app.css` 里不允许出现 emoji 字形
- 样式自洽测试同时生效：每个用到的 class 必须有定义（图标相关的 `.icon` / `.sev-*` /
  `.usage-*` 等十来个新类都被它盯着）
- `theme-color` 按官网做法拆成深/浅两条，随系统切换，不再写死一个值

没做到（下一步）：

- 跨章瞬移、关系矛盾、物品失而复得、称谓越界四条规则仍未实现
- 矩阵在极窄屏下要横向滚动；章节很多时列会很长，没做「只看最近 N 章」的收敛

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
