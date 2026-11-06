// apps/web/src/components/SessionWriteKinds.tsx
// 写入的「新建 / 更新」判据需要**会话级上下文**（写之前该路径出现过没有）：单条消息的
// tools 里没有这个信息，逐消息视图（产物横幅）自己判不出来 —— 先前它按工具名判
// （Write=新建 / Edit=更新），于是同一条 hot.md 在概览里标「新建」、在变更里标「覆写」。
// 会话容器（ChatSessionView）算一次下发，产出面板与横幅共用同一真值源。
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ChatMessage } from '../hooks/useChatCore';
import { buildWriteKindMap } from '../utils/workSteps';
import { writeKey, type WriteKind } from '../utils/toolRefs';
import { useActiveVault } from '../stores/vaultStore';

const WriteKindContext = createContext<Map<string, WriteKind> | null>(null);

export function SessionWriteKindsProvider({ messages, children }: { messages: ChatMessage[]; children: ReactNode }) {
  const vaultPath = useActiveVault()?.path;
  const kinds = useMemo(() => buildWriteKindMap(messages, vaultPath), [messages, vaultPath]);
  return <WriteKindContext.Provider value={kinds}>{children}</WriteKindContext.Provider>;
}

/**
 * 本次会话的 writeKey → kind 映射。返回整个 Map 而非单个查询 —— 调用方在循环里
 * 遍历渲染，钩子不能在循环里调。无 provider 时返回 null（判据未知，调用方不要硬猜）。
 */
export function useSessionWriteKinds(): Map<string, WriteKind> | null {
  return useContext(WriteKindContext);
}

/** 按上报的原始路径取 kind（内部用 writeKey 归一化，与聚合层同一个 key 空间）。 */
export function writeKindOf(
  kinds: Map<string, WriteKind> | null,
  rawPath: string,
  vaultPath?: string,
): WriteKind | undefined {
  return kinds?.get(writeKey(rawPath, vaultPath)) ?? undefined;
}
