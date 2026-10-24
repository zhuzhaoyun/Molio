/**
 * 会话标题派生：取首条消息的**末行非空内容**，折叠空白、截断 80。
 *
 * 首条消息常带 Molio 前置装饰——KB 问答首轮的 wiki-query 触发语、文件引用/图片
 * 附件前缀、选中文字引用——它们都以换行结尾，真问题在末行。此前直接
 * `message.slice(0, 80)` 会把固定前缀截成标题，导致 KB 问答的几乎每条历史记录
 * 同名（2026-10-24 用户实测）。取法与 web 端 deriveChatTitle
 * （apps/web/src/components/kb/kbChatPrompts.ts）一致。
 *
 * 返回空串表示派生不出有意义的标题，调用方应落 null（历史页显示「未命名」）。
 */
export function deriveConversationTitle(message: string): string {
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.replace(/\s+/g, ' ').trim().slice(0, 80);
}
