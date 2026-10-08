// apps/web/src/components/kb/KbChatSessionsProvider.tsx
//
// App 层常驻的会话 Provider：为每个会话标签持有**唯一一个**无 DOM 的
// `KbChatSessionController`（useChatCore + 历史加载 + resumeRun），把它的状态经一个
// 极简外部存储广播给消费者（悬浮面板 / `/chat`），imperative API 经 `getApi` 交出去。
//
// 为什么必须上移到 App 层：状态生命周期从此与 DOM 无关 —— 面板是否渲染（以及 `/chat`
// 是否渲染面板）不再决定会话是否存活，面板 DOM 缺席也不等于后台标签的流式订阅停摆。
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  useSyncExternalStore, type ReactNode,
} from 'react';
import { kbChatSessionsStore, useKbChatSessions } from '../../stores/kbChatSessionsStore';
import { useCurrentContext } from '../../stores/currentContextStore';
import {
  KbChatSessionController, type KbChatSessionApi, type KbChatSessionState,
} from './KbChatSessionController';

interface Props {
  agentId: string | null;
  /** App 内容（`<Routes>` + 悬浮面板）—— 必须是本 Provider 的后代才能真正消费 context。 */
  children?: ReactNode;
}

/** 面板与 /chat 都从这里取；`getApi` 用于 openConversation / runWikiOp 触发加载。 */
export interface KbChatSessionsContextValue {
  getApi: (id: string) => KbChatSessionApi | undefined;
  runningMap: Record<string, boolean>;
  subscribe: (cb: () => void) => () => void;
  getState: (id: string) => KbChatSessionState | undefined;
  publish: (id: string, s: KbChatSessionState) => void;
  revoke: (id: string) => void;
  /** 历史加载失败（标签已被关闭 + runningMap 已清）→ 面板据此弹提示。
   *  nonce 让同一会话连续两次失败也能再次通知。Provider 无 DOM，提示由消费者渲染。 */
  loadError: { id: string; nonce: number } | null;
}

const KbChatSessionsContext = createContext<KbChatSessionsContextValue | null>(null);

/** 面板用它拿 imperative API（同今天的 KbChatSessionsPanelHandle 语义）。 */
export function useKbChatSessionApi(): KbChatSessionsContextValue {
  const ctx = useContext(KbChatSessionsContext);
  if (!ctx) throw new Error('useKbChatSessionApi 必须在 KbChatSessionsProvider 内使用');
  return ctx;
}

/**
 * `/chat` 与面板 view 都用它取状态；sessionId 为 null 或无标签时返回 null。
 *
 * 快照引用稳定：`getState` 只返回存储里那个对象（`publish` 时才换引用），
 * `useSyncExternalStore` 的 `getSnapshot` 因此不会因每次调用新建对象而无限重渲染。
 */
export function useKbChatSessionState(sessionId: string | null): KbChatSessionState | null {
  const ctx = useContext(KbChatSessionsContext);
  if (!ctx) throw new Error('useKbChatSessionState 必须在 KbChatSessionsProvider 内使用');
  const { subscribe, getState } = ctx;
  const snap = useSyncExternalStore(
    subscribe,
    () => (sessionId ? getState(sessionId) : undefined),
  );
  return snap ?? null;
}

export function KbChatSessionsProvider({ agentId, children }: Props) {
  const sessions = useKbChatSessions();
  const { vault } = useCurrentContext();
  const vaultPath = vault?.path ?? null;
  const vaultId = vault?.id ?? null;

  const apiRef = useRef(new Map<string, KbChatSessionApi>());
  const stateRef = useRef(new Map<string, KbChatSessionState>());
  const listenersRef = useRef(new Set<() => void>());
  const [runningMap, setRunningMap] = useState<Record<string, boolean>>({});
  // 历史加载失败通知（Provider 无 DOM → 经 context 交给面板弹 toast）。
  const [loadError, setLoadError] = useState<{ id: string; nonce: number } | null>(null);

  // —— 极简外部存储：state 快照放 ref，变更时通知订阅者（避免 render 期写 state）——
  const subscribe = useCallback((cb: () => void) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);
  const getState = useCallback(
    (id: string) => stateRef.current.get(id),
    [], // 快照引用稳定：publish 时才换引用，getSnapshot 必须原样返回同一对象
  );
  const publish = useCallback((id: string, s: KbChatSessionState) => {
    stateRef.current.set(id, s);
    for (const cb of listenersRef.current) cb();
  }, []);
  const revoke = useCallback((id: string) => {
    stateRef.current.delete(id);
    for (const cb of listenersRef.current) cb();
  }, []);

  const registerApi = useCallback((id: string, a: KbChatSessionApi) => {
    apiRef.current.set(id, a);
  }, []);
  const unregisterApi = useCallback((id: string) => {
    apiRef.current.delete(id);
  }, []);
  const handleRunningChange = useCallback((id: string, running: boolean) => {
    setRunningMap((prev) => (prev[id] === running ? prev : { ...prev, [id]: running }));
  }, []);
  const handleLoadError = useCallback((sessionId: string) => {
    // 原样搬自 KbChatSessionsPanel 的 handleLoadError（#2：只关报错的那个标签），
    // 并把「已关闭」的用户反馈经 context 交给面板渲染（Provider 自身无 DOM）。
    if (kbChatSessionsStore.getSessions().some((s) => s.id === sessionId)) {
      kbChatSessionsStore.closeSession(sessionId);
      setRunningMap((prev) => { const n = { ...prev }; delete n[sessionId]; return n; });
    }
    setLoadError({ id: sessionId, nonce: Date.now() });
  }, []);
  const handleComplete = useCallback(() => kbChatSessionsStore.notifyWikiComplete(), []);

  // 会话关闭 → 清掉它的 runningMap 残留（旧面板的 pruneRunning，现由标签清单变化驱动）。
  const sessionIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  useEffect(() => {
    setRunningMap((prev) => {
      const keys = Object.keys(prev);
      if (keys.every((k) => sessionIds.has(k))) return prev;
      const next: Record<string, boolean> = {};
      for (const k of keys) if (sessionIds.has(k)) next[k] = prev[k]!;
      return next;
    });
  }, [sessionIds]);

  const value = useMemo<KbChatSessionsContextValue>(() => ({
    getApi: (id) => apiRef.current.get(id),
    subscribe, getState, publish, revoke, runningMap, loadError,
  }), [subscribe, getState, publish, revoke, runningMap, loadError]);

  return (
    <KbChatSessionsContext.Provider value={value}>
      {sessions.map((s) => (
        <KbChatSessionController
          key={s.id}
          session={s}
          agentId={agentId}
          vaultPath={vaultPath}
          vaultId={vaultId}
          onRunningChange={handleRunningChange}
          onComplete={handleComplete}
          onLoadError={handleLoadError}
          registerApi={registerApi}
          unregisterApi={unregisterApi}
        >
          {(state) => <KbChatStateBridge id={s.id} state={state} publish={publish} revoke={revoke} />}
        </KbChatSessionController>
      ))}
      {/* controllers 渲染在 children 之前 —— 同一 commit 内它们的 registerApi / publish
          effect 先于消费者（面板补发 pending 自动发送）的 effect 执行。 */}
      {children}
    </KbChatSessionsContext.Provider>
  );
}

/**
 * 极薄的中转：把 controller 的 state 在 effect 里上报，绝不在 render 期写存储
 * （React 19 下 render 期写外部存储会直接抛错）。
 */
function KbChatStateBridge({ id, state, publish, revoke }: {
  id: string; state: KbChatSessionState;
  publish: (id: string, s: KbChatSessionState) => void;
  revoke: (id: string) => void;
}) {
  useEffect(() => { publish(id, state); }, [id, state, publish]);
  useEffect(() => () => revoke(id), [id, revoke]);
  return null;
}
