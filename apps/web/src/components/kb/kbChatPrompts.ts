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
 * qa 模式确定性触发：KB 问答面板里用户输入的问题是知识库问题，包一层显式触发语，
 * 确保 agent 走 wiki-query skill 检索而非凭记忆作答。
 *
 * 只在会话首轮包裹（见 send）：后续多轮 follow-up（「再详细点」「继续」）的上下文
 * 里已经有首轮触发语 + agent 正在执行的 wiki-query 流程，每轮重复包裹只会让消息都
 * 顶着「（知识库问答：…）」前缀、污染对话历史。
 *
 * 这是主界面的双保险——vault 的 .claude/CLAUDE.md 还有一条常驻 wiki-query 规则
 * （skill-installer 注入）覆盖通用/微信场景；此处针对专用 KB 问答面板再加确定性触发。
 */
function WIKI_QUERY_TRIGGER(question: string): string {
  return `（知识库问答：请用 wiki-query skill，先读 wiki/INDEX.md 检索相关页面再回答，不要凭训练记忆作答）\n${question}`;
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
 * 从首条消息派生会话标签标题：取末行非空内容（wiki-query 触发语 / 附件前缀 / 选中上下文
 * 都以换行结尾，实际问题在末行），collapse 内部空白，截断 24。空则回退「新会话」。
 */
function deriveChatTitle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const collapsed = last.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, 24) || '新会话';
}

export { WIKI_PROMPTS, WIKI_INGEST_PROMPT, WIKI_QUERY_TRIGGER, deriveChatTitle };
