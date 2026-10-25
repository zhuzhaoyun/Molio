// apps/web/src/components/kb/kbChatPrompts.ts
import type { ChatSessionMode } from '../../stores/kbChatSessionsStore';

const WIKI_PROMPTS: Record<'build' | 'lint', string> = {
  build: '用 wiki-build skill 开始构建 Wiki：扫描 vault 中所有源文件，构建结构化 wiki。',
  lint: '用 wiki-lint skill 检查 Wiki 健康状况：查孤立页/断链/frontmatter 缺失/内容矛盾等，生成 lint 报告。',
};

function WIKI_INGEST_PROMPT(filePath: string, isDirectory = false): string {
  if (isDirectory) {
    return `用 wiki-ingest skill 把这个文件夹下的所有文件加入 Wiki：${filePath}（递归处理所有子文件夹和文件）`;
  }
  return `用 wiki-ingest skill 把这个文件加入 Wiki：${filePath}`;
}

/**
 * qa 模式确定性触发：KB 问答面板里用户输入的问题包一层显式触发语，确保涉及库
 * 内容的问题走 wiki-query skill 检索而非凭记忆作答。
 *
 * 以「本库主题」为锚的条件式（与 vault `.claude/CLAUDE.md` 常驻规则同一措辞策略，
 * skill-installer 的 buildWikiQueryRuleBlock 已注入「本库主题：X」库名片）：只对
 * 涉及本库主题的问题要求检索，明显无关的通用问题（闲聊、天气等）允许直接回答——
 * 无条件「不要凭训练记忆作答」反而有害（2026-10-24 用户反馈）。同时要求答案形状：
 * 直接给内容、不叙述检索过程——通用问题不该被包成一份检索失败报告（2026-10-26
 * 设计 §4B，实测「什么是熵」开头三段检索说明）。
 *
 * 只在会话首轮包裹（见 send）：后续多轮 follow-up（「再详细点」「继续」）的上下文
 * 里已经有首轮触发语 + agent 正在执行的 wiki-query 流程，每轮重复包裹只会让消息都
 * 顶着「（知识库问答：…）」前缀、污染对话历史。
 *
 * 这是主界面的双保险之一——vault 的 .claude/CLAUDE.md 还有一条常驻 wiki-query 规则
 * （skill-installer 注入）覆盖通用/微信场景；此处针对专用 KB 问答面板再加确定性触发。
 */
const WIKI_QUERY_DIRECTIVE =
  '（知识库问答：若问题涉及本库主题，先用 wiki-query skill 检索相关页面再回答；明显无关的通用问题直接回答，无需检索。答案直接给内容，不要以检索过程或「本库没有收录」开场）';

/** 已下线的旧版触发语（按下线时间倒序）。仅用于识别/剥离历史会话消息里的残留前缀。 */
const LEGACY_WIKI_QUERY_DIRECTIVES = [
  // #369（2026-10-26）引入的条件式，本文案替换前的版本
  '（知识库问答：若问题涉及本库内容，请先用 wiki-query skill 读 wiki/INDEX.md 检索相关页面，基于库内材料回答；与本库明显无关的通用问题（如闲聊、天气）可直接回答，无需检索）',
  // 2026-10-24 之前的无条件版
  '（知识库问答：请用 wiki-query skill，先读 wiki/INDEX.md 检索相关页面再回答，不要凭训练记忆作答）',
];

export function WIKI_QUERY_TRIGGER(question: string): string {
  return `${WIKI_QUERY_DIRECTIVE}\n${question}`;
}

/**
 * 展示层剥离：用户气泡/复制/编辑只应见到用户自己的话，触发语是发给 agent 的
 * 指令、不是用户输入。仅精确匹配行首的已知触发语（现行 + 两版旧文案），其余
 * 原样返回。消息体不动——daemon 存的仍是包裹后的原文。
 */
export function stripWikiQueryTrigger(text: string): string {
  for (const directive of [WIKI_QUERY_DIRECTIVE, ...LEGACY_WIKI_QUERY_DIRECTIVES]) {
    if (text.startsWith(`${directive}\n`)) return text.slice(directive.length + 1);
  }
  return text;
}

export const WIKI_TITLES: Record<ChatSessionMode, string> = {
  qa: '新会话',
  build: '构建Wiki',
  lint: '健康检查',
  ingest: '加入Wiki',
};

/**
 * 旧版「标题取首条消息」派生曾把 wiki 任务的自动提示词截成会话标题（如
 * 「用 wiki-build skill 开始构建」），并经 localStorage 跨版本残留——标签栏和
 * 悬浮按钮右键菜单都会把它当名字展示（2026-10-13 用户实测）。现版 wiki 会话
 * 固定用 WIKI_TITLES 且不再派生（controller 只对 qa 派生），这里识别遗留片段：
 * 标题以「用 wiki-build/lint/ingest」开头即按前缀归位规范标题（按前缀而非 mode
 * 字段判——旧数据里 mode 可能缺失）；qa 会话不动（真往 qa 里贴过这段话的，
 * 用户可自行重命名）。用户重命名过的不匹配前缀，天然不动。
 */
export function legacyWikiTitleFix(mode: ChatSessionMode | undefined, title: string): string | null {
  if (mode === 'qa') return null;
  if (!title.startsWith('用 wiki-')) return null;
  if (title.startsWith('用 wiki-build')) return WIKI_TITLES.build;
  if (title.startsWith('用 wiki-lint')) return WIKI_TITLES.lint;
  if (title.startsWith('用 wiki-ingest')) return WIKI_TITLES.ingest;
  return null;
}

/**
 * 发送时 composer 会前置「文件引用 / 图片附件」标记（`@path` token 被
 * composerExpand 展开成 `[📄 name](path)`、粘贴图片是 `![image](path)`）。
 * 这些是上下文、不是用户的问题——标题若照抄会变成
 * `[📄 doc.md](doc.md) 关于 d`，在标签栏里既占宽又读不懂。
 * 只剥行首连续出现的前缀（用户正文里出现的链接不动）。
 */
const LEADING_REF_RE = /^(?:!?\[[^\]]*\]\([^)]*\)\s*)+/;
const LEADING_AT_RE = /^(?:@\S+\s*)+/;

/** 剥掉行首的引用/附件前缀；全是前缀时返回空串。 */
export function stripLeadingRefs(line: string): string {
  return line.replace(LEADING_REF_RE, '').replace(LEADING_AT_RE, '').trim();
}

/**
 * 从首条消息派生会话标签标题：取末行非空内容（wiki-query 触发语 / 附件前缀 / 选中上下文
 * 都以换行结尾，实际问题在末行），剥掉行首引用前缀，collapse 内部空白，截断 24。
 * 空则回退「新会话」。
 */
function deriveChatTitle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const collapsed = stripLeadingRefs(last).replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, 24) || '新会话';
}

export { WIKI_PROMPTS, WIKI_INGEST_PROMPT, deriveChatTitle };
