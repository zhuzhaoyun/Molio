/**
 * Shared chat runtime store — single source of truth for the chat's
 * runtime (agent) + model selection.
 *
 * Uses React 18's useSyncExternalStore for tear-safe external store access
 * (same pattern as vaultStore). Consumers:
 *  - RuntimeModelPill (composer): reads + writes both fields;
 *  - App.tsx: hydrates agentId from config default and syncs 设置页 changes;
 *  - useChat / KbChatSession: read a snapshot at send time to pass `model`
 *    to POST /api/runs (per-message effect — no session binding needed).
 *
 * 持久化语义（用户偏好规则：显式选择必须记住，不得静默回退）：
 *  - model 按 runtime 记入 localStorage（`molio.chatModel.<agentId>`），
 *    切回该 runtime 自动恢复；model=null 表示「跟随 CLI 默认」，清除记录。
 *  - agentId 本身不落盘——全局默认仍由设置页的 defaultAgentId 负责，store
 *    只承载「当前会话用哪个 runtime」的 UI 态。
 */

import { useSyncExternalStore } from 'react';

type Listener = () => void;

export interface ChatRuntimeState {
  agentId: string | null;
  /** 当前 runtime 的模型 id；null = 跟随 CLI 默认。 */
  model: string | null;
}

const MODEL_KEY_PREFIX = 'molio.chatModel.';

function readRememberedModel(agentId: string): string | null {
  try {
    return localStorage.getItem(MODEL_KEY_PREFIX + agentId);
  } catch {
    return null;
  }
}

function persistModel(agentId: string, model: string | null) {
  try {
    if (model) {
      localStorage.setItem(MODEL_KEY_PREFIX + agentId, model);
    } else {
      localStorage.removeItem(MODEL_KEY_PREFIX + agentId);
    }
  } catch { /* storage unavailable — memory-only */ }
}

let state: ChatRuntimeState = { agentId: null, model: null };
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const chatRuntimeStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getState(): ChatRuntimeState {
    return state;
  },

  /** 切 runtime：模型切到该 runtime 记住的常用模型（没有则跟随默认）。 */
  setAgentId(agentId: string | null) {
    if (state.agentId === agentId) return;
    state = {
      agentId,
      model: agentId ? readRememberedModel(agentId) : null,
    };
    emit();
  },

  /** 切模型：即时生效（下一条消息），并按 runtime 持久化。 */
  setModel(model: string | null) {
    if (state.model === model) return;
    state = { ...state, model };
    if (state.agentId) persistModel(state.agentId, model);
    emit();
  },
};

/** Subscribe to the runtime+model selection (re-renders on change). */
export function useChatRuntime(): ChatRuntimeState {
  return useSyncExternalStore(
    chatRuntimeStore.subscribe,
    chatRuntimeStore.getState,
    chatRuntimeStore.getState,
  );
}

/** Subscribe to the runtime (agent) selection only. */
export function useChatAgentId(): string | null {
  return useSyncExternalStore(
    chatRuntimeStore.subscribe,
    () => chatRuntimeStore.getState().agentId,
    () => chatRuntimeStore.getState().agentId,
  );
}
