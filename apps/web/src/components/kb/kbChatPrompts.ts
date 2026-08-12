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

export { WIKI_PROMPTS, WIKI_INGEST_PROMPT, WIKI_QUERY_TRIGGER };
