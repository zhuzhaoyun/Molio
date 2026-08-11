// apps/web/src/stores/kbChatSessionsStore.ts
import { useSyncExternalStore } from 'react';

export const MAX_CHAT_SESSIONS = 10;
const STORAGE_KEY_SESSIONS = 'molio.kb.chatSessions';
const STORAGE_KEY_ACTIVE = 'molio.kb.chatActiveSessionId';

export type ChatSessionMode = 'qa' | 'build' | 'lint' | 'ingest';

export interface ChatSessionTab {
  id: string;
  title: string;
  conversationId: string | null;
  mode: ChatSessionMode;
  vaultId?: string;
  filePath?: string | null;
}

interface StoreState {
  sessions: ChatSessionTab[];
  activeSessionId: string | null;
  panelOpen: boolean;
}

export interface OpenSessionResult {
  opened: boolean;
  reason?: 'limit';
  tab?: ChatSessionTab;
  /** 就地切换：把活动 qa 会话的内容替换为目标会话（不新建标签）。调用方需触发加载。 */
  switched?: boolean;
}

function readPersistedSessions(): ChatSessionTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SESSIONS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch { /* ignore */ }
  return [];
}

function readPersistedActive(): string | null {
  try { return localStorage.getItem(STORAGE_KEY_ACTIVE); } catch { return null; }
}

function nextId(): string {
  return `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

let state: StoreState = {
  sessions: readPersistedSessions(),
  activeSessionId: readPersistedActive(),
  panelOpen: false,
};
// 持久化 active 可能已失效 → 回退到最后一个标签
if (state.activeSessionId && !state.sessions.some((s) => s.id === state.activeSessionId)) {
  state.activeSessionId = state.sessions[state.sessions.length - 1]?.id ?? null;
}

const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(state.sessions));
    if (state.activeSessionId) localStorage.setItem(STORAGE_KEY_ACTIVE, state.activeSessionId);
    else localStorage.removeItem(STORAGE_KEY_ACTIVE);
  } catch { /* storage unavailable */ }
}

function emit(next: StoreState) {
  state = next;
  persist();
  for (const l of listeners) l();
}

export const kbChatSessionsStore = {
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
  getSessions(): ChatSessionTab[] { return state.sessions; },
  getActiveSessionId(): string | null { return state.activeSessionId; },
  getActiveSession(): ChatSessionTab | undefined {
    return state.sessions.find((s) => s.id === state.activeSessionId);
  },
  isPanelOpen(): boolean { return state.panelOpen; },
  setPanelOpen(open: boolean) {
    if (state.panelOpen === open) return;
    emit({ ...state, panelOpen: open });
  },

  openSession(tab: Omit<ChatSessionTab, 'id'>): OpenSessionResult {
    // 同一 conversation 已开 → 去重激活
    if (tab.conversationId) {
      const existing = state.sessions.find((s) => s.conversationId === tab.conversationId);
      if (existing) {
        emit({ ...state, activeSessionId: existing.id, panelOpen: true });
        return { opened: false, tab: existing };
      }
    }
    if (state.sessions.length >= MAX_CHAT_SESSIONS) {
      return { opened: false, reason: 'limit' };
    }
    const id = nextId();
    const newTab: ChatSessionTab = { ...tab, id };
    emit({ ...state, sessions: [...state.sessions, newTab], activeSessionId: id, panelOpen: true });
    return { opened: true, tab: newTab };
  },

  activateSession(id: string) {
    if (!state.sessions.some((s) => s.id === id)) return;
    if (state.activeSessionId !== id) emit({ ...state, activeSessionId: id });
  },

  closeSession(id: string) {
    const idx = state.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const sessions = state.sessions.filter((s) => s.id !== id);
    let activeSessionId = state.activeSessionId;
    if (activeSessionId === id) {
      activeSessionId = sessions[idx - 1]?.id ?? sessions[0]?.id ?? null;
    }
    emit({ ...state, sessions, activeSessionId });
  },

  updateSession(id: string, patch: Partial<ChatSessionTab>) {
    let changed = false;
    const sessions = state.sessions.map((s) => {
      if (s.id === id) { changed = true; return { ...s, ...patch }; }
      return s;
    });
    if (changed) emit({ ...state, sessions });
  },

  /** vault 切换时清空所有会话的 @文件上下文（旧库引用失效）。会话本身保留。 */
  clearFilePaths() {
    let changed = false;
    const sessions = state.sessions.map((s) => {
      if (s.filePath) { changed = true; return { ...s, filePath: null }; }
      return s;
    });
    if (changed) emit({ ...state, sessions });
  },

  /**
   * 打开历史对话（切不像 VS Code Claude Code）：按 conversationId 去重激活；
   * 否则若有活动 qa 会话则「就地切换」其内容（不新建标签，返回 switched）；
   * 否则新建 qa 标签。目标是避免历史打开把标签越开越多。
   */
  openConversation(conversationId: string): OpenSessionResult {
    const existing = state.sessions.find((s) => s.conversationId === conversationId);
    if (existing) {
      if (state.activeSessionId !== existing.id || !state.panelOpen) {
        emit({ ...state, activeSessionId: existing.id, panelOpen: true });
      }
      return { opened: false, tab: existing };
    }
    // 就地切换：活动会话是 qa 时，把它的 conversationId 换成目标会话（标题占位）。
    // 切换本身不加载——由调用方（面板 handleOpenConversation）触发该会话的加载。
    const active = state.sessions.find((s) => s.id === state.activeSessionId);
    if (active && active.mode === 'qa') {
      const sessions = state.sessions.map((s) =>
        s.id === active.id ? { ...s, conversationId, title: '加载中…' } : s,
      );
      emit({ ...state, sessions, panelOpen: true });
      return { opened: false, tab: { ...active, conversationId, title: '加载中…' }, switched: true };
    }
    if (state.sessions.length >= MAX_CHAT_SESSIONS) {
      return { opened: false, reason: 'limit' };
    }
    const id = nextId();
    const newTab: ChatSessionTab = {
      id, title: '加载中…', conversationId, mode: 'qa', filePath: null,
    };
    emit({ ...state, sessions: [...state.sessions, newTab], activeSessionId: id, panelOpen: true });
    return { opened: true, tab: newTab };
  },
};

export function useKbChatSessions(): ChatSessionTab[] {
  return useSyncExternalStore(kbChatSessionsStore.subscribe, kbChatSessionsStore.getSessions, kbChatSessionsStore.getSessions);
}
export function useKbChatActiveSessionId(): string | null {
  return useSyncExternalStore(kbChatSessionsStore.subscribe, kbChatSessionsStore.getActiveSessionId, kbChatSessionsStore.getActiveSessionId);
}
export function useKbChatPanelOpen(): boolean {
  return useSyncExternalStore(kbChatSessionsStore.subscribe, kbChatSessionsStore.isPanelOpen, kbChatSessionsStore.isPanelOpen);
}
