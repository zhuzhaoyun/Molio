// apps/web/src/utils/messageText.ts
// 把助手消息文本拆成「过程叙事」与「最终答案」两部分。
// 判定依据：消息里最终有多少个工具（finalTools）；某段文本到达时若已完成
// 全部工具（done >= finalTools），它就是最后一个工具之后产出的最终答案，
// 否则是执行过程中的自言自语（进工作块的过程流）。
import type { ChatMessage } from '../hooks/useChat';

export function splitMessageText(
  message: ChatMessage,
  rawText: string = message.content,
): { process: string; answer: string } {
  // 运行中：最终答案的边界未知，全部进过程流（运行态工作块内渐进展示），正文留空。
  if (message.streaming) return { process: rawText, answer: '' };

  const finalTools = message.tools?.length ?? 0;
  const segs = message.segments;
  // 无分段（重载/历史会话，segments 未持久化）→ 全文当答案，与现状一致。
  if (!segs || segs.length === 0) return { process: '', answer: rawText };

  let process = '';
  let answer = '';
  for (const s of segs) {
    if (finalTools > 0 && s.done < finalTools) process += s.text;
    else answer += s.text;
  }
  return { process, answer };
}
