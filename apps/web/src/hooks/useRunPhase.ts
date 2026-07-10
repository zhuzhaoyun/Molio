// apps/web/src/hooks/useRunPhase.ts
import { useState, useEffect, useRef, useMemo } from 'react';
import type { ChatMessage } from './useChatCore';

export type RunPhase =
  | { type: 'idle' }
  | { type: 'thinking' }
  | { type: 'tool'; toolName: string }
  | { type: 'generating' };

/**
 * 从最后一条 assistant 消息推导当前 run 的阶段。
 * 纯函数，不依赖任何外部状态，便于测试。
 */
export function derivePhase(messages: ChatMessage[], isRunning: boolean): RunPhase {
  if (!isRunning) return { type: 'idle' };

  // 倒序查找最后一条 assistant 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') continue;
    if (!msg.streaming) return { type: 'idle' };

    // 有 running 状态的 tool → 工具执行中
    const runningTool = msg.tools?.find((t) => t.status === 'running');
    if (runningTool) return { type: 'tool', toolName: runningTool.name };

    // 有 thinking 内容，无 text 内容 → 思考中
    if (msg.thinking && !msg.content) return { type: 'thinking' };

    // 有 text 内容，仍在 streaming → 生成回复中
    if (msg.content) return { type: 'generating' };

    // streaming 但还没收到任何内容事件 → 等待首个事件，视为思考中
    return { type: 'thinking' };
  }

  return { type: 'idle' };
}

/**
 * 从 messages 和 isRunning 推导当前阶段 + 全局耗时。
 * - phase 从 messages 推导（纯计算）
 * - elapsedMs 从 isRunning 变为 true 的时刻起算，每秒更新
 */
export function useRunPhase(
  messages: ChatMessage[],
  isRunning: boolean,
): { phase: RunPhase; elapsedMs: number } {
  const phase = useMemo(() => derivePhase(messages, isRunning), [messages, isRunning]);

  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isRunning) {
      startRef.current = Date.now();
      setElapsedMs(0);
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startRef.current);
      }, 200); // 200ms 刷新足够平滑，比 1000ms 更实时
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setElapsedMs(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning]);

  return { phase, elapsedMs };
}
