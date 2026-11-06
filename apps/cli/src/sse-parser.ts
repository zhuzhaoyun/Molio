/**
 * 手写 SSE 帧解析 — Node 20 没有可靠的全局 EventSource（WorkBuddy 托管
 * 运行时是 Node 20 系），因此直接从 fetch response body 的 ReadableStream
 * 解析 SSE 帧。
 *
 * daemon 侧帧格式（apps/daemon/src/sse.ts）：
 *   id: <seq>\n
 *   data: {"seq":<n>,"runId":"...","event":{...}}\n
 *   \n
 * keepalive（每 15s，无 id 行，不入回放缓冲）：
 *   data: ping\n
 *   \n
 *
 * 解析器必须处理：帧跨 chunk 切断、单 chunk 多帧、CRLF 行尾、UTF-8 多字节
 * 字符跨 chunk 切断（TextDecoder stream 模式兜底）。
 */
import type { SSEEnvelope } from '@molio/contracts';

/** 按空行切帧的增量分割器。feed 返回本次完整的原始帧（不含结尾空行）。 */
export function createFrameSplitter(): {
  feed: (chunk: string) => string[];
  /** 流结束时取出残留（无结尾空行的最后一帧）。 */
  flush: () => string | null;
} {
  let buf = '';
  return {
    feed(chunk: string): string[] {
      buf += chunk;
      const frames: string[] = [];
      for (;;) {
        // 统一按 \n\n 找帧边界；先归一化 CRLF。末尾孤立 \r 可能是下个
        // chunk 的 \r\n 前半，挂起不处理。
        const normalized = buf.replace(/\r\n/g, '\n');
        const heldCR = normalized.endsWith('\r');
        const work = heldCR ? normalized.slice(0, -1) : normalized;
        const idx = work.indexOf('\n\n');
        if (idx === -1) {
          buf = work;
          break;
        }
        frames.push(work.slice(0, idx));
        buf = work.slice(idx + 2);
      }
      return frames;
    },
    flush(): string | null {
      const rest = buf.replace(/\r\n/g, '\n').trim();
      buf = '';
      return rest.length > 0 ? rest : null;
    },
  };
}

/**
 * 解析单个原始帧 → SSEEnvelope。
 * 非事件帧（ping keepalive、无法解析、缺 event 字段）返回 null。
 * 按 SSE 规范聚合多行 data:（daemon 目前只发单行，但按规范实现更稳）。
 */
export function parseFrame(raw: string): SSEEnvelope | null {
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // id:/event:/retry:/注释行(:) 均忽略 — envelope JSON 里已带 seq/runId
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  if (data === 'ping') return null; // keepalive
  try {
    const parsed = JSON.parse(data) as Partial<SSEEnvelope>;
    if (parsed && typeof parsed === 'object' && parsed.event) {
      return parsed as SSEEnvelope;
    }
    return null;
  } catch {
    return null; // 非 JSON data（防御，不中断流）
  }
}

/**
 * 消费 fetch body 流，产出 SSEEnvelope。流关闭（run 终止）时自然结束。
 * caller 负责 AbortSignal（超时控制）。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEnvelope> {
  const decoder = new TextDecoder('utf-8');
  const splitter = createFrameSplitter();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const frame of splitter.feed(text)) {
        const envelope = parseFrame(frame);
        if (envelope) yield envelope;
      }
    }
    const tail = decoder.decode(); // 冲刷多字节残留
    for (const frame of splitter.feed(tail)) {
      const envelope = parseFrame(frame);
      if (envelope) yield envelope;
    }
    const rest = splitter.flush();
    if (rest) {
      const envelope = parseFrame(rest);
      if (envelope) yield envelope;
    }
  } finally {
    // 提前 break（看到 turn_end/status 完成信号）时，必须 cancel reader 真正关闭
    // HTTP 连接——releaseLock 只释放锁不关流，会让 SSE 连接悬挂到 daemon 侧
    // stall-close（~60s）才断。cancel 幂等：流已 EOF/出错时为 no-op。
    try {
      await reader.cancel();
    } catch {
      /* 流已关闭，忽略 */
    }
  }
}
