// apps/web/src/utils/messageText.ts
// 把助手消息文本拆成「过程叙事」与「最终答案」两部分。
// 判定依据：消息里最终有多少个工具（finalTools）；某段文本到达时若已完成
// 全部工具（done >= finalTools），它就是最后一个工具之后产出的最终答案，
// 否则是执行过程中的自言自语（进工作块的过程流）。
import type { ChatMessage } from '../hooks/useChat';

/** 一段实时文本增量 + 到达时已完成的工具数（work-block 叙事交错的插入锚点）。 */
export interface MessageSegment {
  text: string;
  done: number;
}

export function splitMessageText(
  message: ChatMessage,
  rawText: string = message.content,
): { process: string; answer: string } {
  return splitMessageParts(message, rawText);
}

/** 同 splitMessageText，但额外保留叙事的分段（含 done 锚点）供工作块交错渲染。 */
export function splitMessageParts(
  message: ChatMessage,
  rawText: string = message.content,
): { processSegs: MessageSegment[]; process: string; answer: string } {
  // 运行中：最终答案的边界未知，全部进过程流（运行态工作块内渐进展示），正文留空。
  if (message.streaming) {
    return { processSegs: message.segments ?? [], process: rawText, answer: '' };
  }

  const finalTools = message.tools?.length ?? 0;
  const segs = message.segments;
  // 无分段（重载/历史会话，segments 未持久化）→ 全文当答案，与现状一致。
  if (!segs || segs.length === 0) return { processSegs: [], process: '', answer: rawText };

  const processSegs = segs.filter((s) => finalTools > 0 && s.done < finalTools);
  const answerSegs = segs.filter((s) => !(finalTools > 0 && s.done < finalTools));
  return {
    processSegs,
    process: processSegs.map((s) => s.text).join(''),
    answer: answerSegs.map((s) => s.text).join(''),
  };
}

/**
 * 把叙事段按锚点分桶，供工作块把叙事穿插进工具行之间（Codex 式交错）。
 * seg.done = 该段到达时已完成的工具数（message.tools 全序）→ 语义上它发生在
 * 「第 done-1 个工具之后、fullIdx >= done 的第一个条目之前」。anchors 必须
 * 按渲染顺序升序传入（每个条目首工具的 fullIdx）；返回 buckets[i] = 插在第
 * i 个条目之前的叙事（相邻同位段已拼接），trailing = 超出全部锚点的末尾叙事。
 */
export function bucketSegmentsByDone(
  segs: MessageSegment[],
  anchors: number[],
): { buckets: string[]; trailing: string } {
  const buckets: string[] = anchors.map(() => '');
  let trailing = '';
  for (const s of segs) {
    const idx = anchors.findIndex((a) => a >= s.done);
    if (idx === -1) trailing += s.text;
    else buckets[idx] += s.text;
  }
  return { buckets, trailing };
}
