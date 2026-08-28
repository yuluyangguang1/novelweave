/**
 * 分发表：唯一一个「哪个 agent 的 skill 放哪儿」的数据源。
 *
 * 三条设计约束：
 * 1. 仓库里**不放任何 agent 镜像目录**（不建 .claude-plugin / .cursor-plugin 等）。
 *    跨 agent 的适配发生在安装时、落在各 agent 自己的目录里。
 * 2. 权威源先物化到 ~/.novelweave/skills/，各 agent 目录从它复制或放指针 ——
 *    这样卸载与升级有单一落点，也不会出现多份正文各自腐烂。
 * 3. 没有公开格式文档的 agent（workbuddy / zcode）只做探测，探不到就打印
 *    手动指引。**不假装支持**。
 */
export const SKILLS = ['novelweave', 'novelweave-continuity'];
export const STAGED_DIR = '~/.novelweave/skills';
export const MANIFEST_FILE = '~/.novelweave/manifest.json';

export const POINTER_MARK_BEGIN = '<!-- BEGIN novelweave -->';
export const POINTER_MARK_END = '<!-- END novelweave -->';

/** 指针块：不复制正文，只给路径 + 触发条件。 */
export const POINTER_BLOCK = (staged) => [
  POINTER_MARK_BEGIN + ' (managed by novelweave install)',
  '## NovelWeave 长篇小说 Story Bible',
  '',
  '仅当当前目录或其祖先存在 `.novelweave/project.json` 时才启用本技能；',
  '其余写作类请求（批量成稿、去 AI 痕迹、文笔诊断、排版出书）不要使用它。',
  '',
  `1. 先读：${staged}/novelweave/SKILL.md`,
  `2. 连续性校验：${staged}/novelweave-continuity/SKILL.md（只读，不改文件）`,
  `3. 脚本在 ${staged}/novelweave/scripts/，需要 Node ≥ 18`,
  '',
  '不要复制上述文件内容到别处，也不要为一本书发明第二套状态文件格式。',
  POINTER_MARK_END,
].join('\n');

export const CURSOR_RULE = (staged) => [
  '---',
  'description: 在已存在 .novelweave/ 的中文长篇小说项目上续写、修订、维护 Story Bible 与连续性校验。不用于批量从零成书、去 AI 痕迹、句子级文笔诊断、PDF/EPUB 排版。',
  'globs: .novelweave/**,**/manuscript/chapters/*.md',
  'alwaysApply: false',
  '---',
  '',
  `本仓库使用 NovelWeave Story Bible 格式。开始任何写作或校验前，先读：`,
  '',
  `- \`${staged}/novelweave/SKILL.md\`（主编排：First Steps 与 Hard Constraints）`,
  `- \`${staged}/novelweave-continuity/SKILL.md\`（连续性检查，只读）`,
  '',
  '硬约束：结构化状态文件是唯一权威；状态文件不得整份进 prompt；',
  '任何状态变更必须走 `---CHANGES---` 提案并由作者确认，不得静默改写既定事实。',
  '仅当本仓库存在 `.novelweave/project.json` 时适用。',
  '',
].join('\n');

/**
 * kind:
 *   skill-dir — 把 skill 目录复制到 target/[category/]<skill>/
 *   pointer   — 只写指针（AGENTS.md 标记块 或 .mdc 规则文件）
 *   probe     — 无公开格式，探测到合规布局才装，否则只给指引
 *
 * frontmatter.needsTopLevel — 该 agent 要求顶层存在的键（Hermes 要 version）
 * scope: user（装进 HOME）| project（装进当前仓库）
 */
export const AGENTS = [
  {
    key: 'claude', label: 'Claude Code', confidence: 'verified',
    detect: ['~/.claude'],
    kind: 'skill-dir', scope: 'user', target: '~/.claude/skills', layout: 'flat',
    pointer: { file: '~/.claude/CLAUDE.md', mode: 'block' },
  },
  {
    key: 'qoder', label: 'Qoder', confidence: 'verified',
    detect: ['~/.qoder'],
    kind: 'skill-dir', scope: 'user', target: '~/.qoder/skills', layout: 'flat',
  },
  {
    key: 'openclaw', label: 'OpenClaw', confidence: 'verified',
    detect: ['~/.openclaw'],
    kind: 'skill-dir', scope: 'user', target: '~/.openclaw/skills', layout: 'flat',
  },
  {
    key: 'hermes', label: 'Hermes', confidence: 'documented',
    detect: ['~/.hermes'],
    kind: 'skill-dir', scope: 'user', target: '~/.hermes/skills', layout: 'category', category: 'writing',
    frontmatter: { needsTopLevel: { version: '1.0.0' } },
  },
  {
    key: 'codex', label: 'Codex CLI', confidence: 'verified',
    detect: ['~/.codex'],
    kind: 'pointer', scope: 'user',
    pointer: { file: '~/.codex/AGENTS.md', mode: 'block' },
    note: 'Codex 没有 skill 载体，靠 AGENTS.md 指令发现',
  },
  {
    key: 'cursor', label: 'Cursor', confidence: 'verified',
    detect: ['~/.cursor', '.cursor'],
    kind: 'pointer', scope: 'project',
    pointer: { file: '.cursor/rules/novelweave.mdc', mode: 'file' },
    note: '规则只认 alwaysApply / description / globs 三个键',
  },
  {
    key: 'workbuddy', label: 'WorkBuddy', confidence: 'observed-locally',
    // 实测：~/.workbuddy/skills/<name>/{SKILL.md,_skillhub_meta.json,scripts/}
    // frontmatter 顶层直接写 version，与 Hermes 一样需要该键
    detect: ['~/.workbuddy/skills'],
    kind: 'skill-dir', scope: 'user', target: '~/.workbuddy/skills', layout: 'flat',
    frontmatter: { needsTopLevel: { version: '1.0.0' } },
    note: '商店安装另有 _skillhub_meta.json 侧车文件，手动安装不需要',
  },
  {
    // 实测：~/.zcode 下没有用户级 skills 目录；技能只出现在插件缓存
    // ~/.zcode/cli/plugins/cache/<publisher>/<plugin>/<version>/skills/<skill>/
    // 手工伪造 publisher/version 目录属于猜测，因此不自动写入，只给指引
    key: 'zcode', label: 'ZCode', confidence: 'unverified',
    detect: ['~/.zcode/cli/plugins/cache', '~/.zcode/skills', '~/.zcode'],
    kind: 'probe', scope: 'user',
    note: '技能似以 plugin/<插件>/<版本>/skills/<技能> 形式分发，缺少公开格式文档，故不自动写入',
  },
];

export function agentByKey(key) {
  return AGENTS.find((a) => a.key === key);
}
