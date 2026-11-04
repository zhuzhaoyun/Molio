// apps/web/src/stores/kbChatSessionsStore.ts
import { useMemo, useSyncExternalStore } from 'react';
// kbChatPrompts 对本模块只有 type import（运行时无环）：标题/提示词常量的家在那边
import { legacyWikiTitleFix } from '../components/kb/kbChatPrompts.ts';
// 当前活跃知识库 —— 会话标签按库隔离的唯一判据（见 sessionsOfVault）
import { vaultStore, useActiveVaultId } from './vaultStore.ts';

export const MAX_CHAT_SESSIONS = 10;
const STORAGE_KEY_SESSIONS = 'molio.kb.chatSessions';
const STORAGE_KEY_ACTIVE = 'molio.kb.chatActiveSessionId';

export type ChatSessionMode = 'qa' | 'build' | 'lint' | 'ingest';

export interface ChatSessionTab {
  id: string;
  title: string;
  conversationId: string | null;
  mode: ChatSessionMode;
  /**
   * 归属的知识库 id。会话标签按库隔离：只显示当前库的会话（切库即隐藏，切回即恢复）。
   *
   * 三态：`'vault-x'` = 属于该库；`null` = **通用会话**（不属于任何库，任何库都可见）；
   * `undefined` = 旧会话（隔离机制之前创建的，没有这个字段）→ 载入时迁移到当前活跃库。
   */
  vaultId?: string | null;
  filePath?: string | null;
}

/**
 * 属于指定库的会话（可见集合）。
 *
 * 会话标签按知识库隔离的落点：切到另一个库 → 别的库的会话不出现在标签栏；
 * 切回来 → 原样恢复（会话仍在底层清单里，controller 重新挂载后从 DB 拉历史）。
 *
 * 通用会话（`vaultId === null`）不属于任何库 → 任何库都可见（它是「还没进知识库
 * 时的普通对话」，不该因为用户切了个库就凭空消失）。
 */
export function sessionsOfVault(
  sessions: ChatSessionTab[],
  vaultId: string | null | undefined,
): ChatSessionTab[] {
  const key = vaultId ?? null;
  return sessions.filter((s) => {
    // undefined = 尚未迁移的旧会话（载入时已迁移，运行时不该出现）→ 先不显示
    if (s.vaultId === undefined) return false;
    // null = 通用会话（不属于任何库）→ 任何库都可见
    if (s.vaultId === null) return true;
    return s.vaultId === key;
  });
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
      if (Array.isArray(arr)) {
        const sessions = arr as ChatSessionTab[];
        let dirty = false;
        // 一次性迁移：旧版提示词片段标题 → 规范 wiki 标题（就地改写并回写 storage，
        // 之后这份脏数据不再存在）。用户重命名过的不受影响（见 legacyWikiTitleFix）。
        for (const s of sessions) {
          if (typeof s?.title !== 'string') continue;
          const fixed = legacyWikiTitleFix(s.mode, s.title);
          if (fixed) { s.title = fixed; dirty = true; }
        }
        // 一次性迁移：会话标签按库隔离之前创建的旧会话**没有 vaultId 字段**
        // （undefined）→ 归属当前活跃库；没有活跃库则算通用会话（null）。
        // 不迁移的话它们对不上任何库（永远不可见），用户会以为自己的会话没了。
        // 只动 undefined：显式 null 表示「通用会话」（不属于任何库），要保留。
        const activeVaultId = vaultStore.getActiveVaultId() ?? null;
        for (const s of sessions) {
          if (s.vaultId === undefined) { s.vaultId = activeVaultId; dirty = true; }
        }
        if (dirty) {
          try { localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions)); } catch { /* ignore */ }
        }
        return sessions;
      }
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

// wiki 构建完成事件总线：面板（App 层常驻）无法跨层回调 KB 页，改由 store 通知，
// KB 页挂载时订阅刷新文件树、卸载时取消（见 KnowledgeBasePage）。
const wikiCompleteListeners = new Set<() => void>();

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

/**
 * 活动会话（**按当前库取作用域**）：别的库的会话不可见，不能当活动。
 * 当前库没有对应活动会话时，回落到本库最后一个（切库后不至于面板全黑）。
 *
 * 模块级函数而非 store 上的方法：useSyncExternalStore 会把方法**拆出来**传，
 * 那样 `this` 是 undefined（踩过：getActiveSession undefined 报错，整页白屏）。
 */
function activeSession(): ChatSessionTab | undefined {
  const scoped = sessionsOfVault(state.sessions, vaultStore.getActiveVaultId());
  return scoped.find((s) => s.id === state.activeSessionId) ?? scoped[scoped.length - 1];
}

export const kbChatSessionsStore = {
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
  getSessions(): ChatSessionTab[] { return state.sessions; },
  /** 属于指定库的会话（可见集合）——标签栏/面板只渲染这一份。 */
  getSessionsForVault(vaultId: string | null | undefined): ChatSessionTab[] {
    return sessionsOfVault(state.sessions, vaultId);
  },
  /**
   * 活动会话（**按当前库取作用域**）：别的库的会话不可见，不能当活动。
   * 当前库没有对应活动会话时，回落到本库最后一个（切库后不至于面板全黑）。
   */
  getActiveSession(): ChatSessionTab | undefined { return activeSession(); },
  getActiveSessionId(): string | null { return activeSession()?.id ?? null; },
  isPanelOpen(): boolean { return state.panelOpen; },
  setPanelOpen(open: boolean) {
    if (state.panelOpen === open) return;
    emit({ ...state, panelOpen: open });
  },

  /** 订阅 wiki 任务完成（面板通知 → KB 页刷新文件树）。返回取消订阅函数。 */
  subscribeWikiComplete(cb: () => void) {
    wikiCompleteListeners.add(cb);
    return () => { wikiCompleteListeners.delete(cb); };
  },
  /** wiki 任务完成时通知订阅者（由面板在 KbChatSession onComplete 触发）。 */
  notifyWikiComplete() {
    for (const cb of wikiCompleteListeners) cb();
  },

  openSession(tab: Omit<ChatSessionTab, 'id'>): OpenSessionResult {
    // 会话归属库：调用方给了就用它的（null = 通用会话），没给就归属当前活跃库。
    const vaultId = tab.vaultId === undefined ? (vaultStore.getActiveVaultId() ?? null) : tab.vaultId;
    const scoped = sessionsOfVault(state.sessions, vaultId);
    // 同一 conversation 已开 → 去重激活（**只在本库内**去重：别的库的同名会话不可见）
    if (tab.conversationId) {
      const existing = scoped.find((s) => s.conversationId === tab.conversationId);
      if (existing) {
        emit({ ...state, activeSessionId: existing.id, panelOpen: true });
        return { opened: false, tab: existing };
      }
    }
    // 标签上限按库计：A 库占满不妨碍 B 库开新会话
    if (scoped.length >= MAX_CHAT_SESSIONS) {
      return { opened: false, reason: 'limit' };
    }
    const id = nextId();
    const newTab: ChatSessionTab = { ...tab, id, vaultId };
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
    const closed = state.sessions[idx]!;
    const sessions = state.sessions.filter((s) => s.id !== id);
    let activeSessionId = state.activeSessionId;
    if (activeSessionId === id) {
      // 替补在**同一个库**里选：别的库的会话不可见，不能当活动。
      // 优先取被关会话的前一个（与旧行为一致），否则取本库最后一个。
      let next: ChatSessionTab | undefined;
      for (let i = Math.min(idx, sessions.length) - 1; i >= 0; i--) {
        const cand = sessions[i];
        if (cand && cand.vaultId === closed.vaultId) { next = cand; break; }
      }
      const sameVault = sessions.filter((s) => s.vaultId === closed.vaultId);
      activeSessionId = (next ?? sameVault[sameVault.length - 1])?.id ?? null;
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

  /**
   * 打开历史对话（切不像 VS Code Claude Code）：按 conversationId 去重激活；
   * 否则若有活动 qa 会话则「就地切换」其内容（不新建标签，返回 switched）；
   * 否则新建 qa 标签。目标是避免历史打开把标签越开越多。
   *
   * 去重与「就地切换」都只在本库内进行 —— 别的库的会话在当前库不可见，
   * 拿它当活动会切到一个看不见的标签上。
   */
  openConversation(conversationId: string): OpenSessionResult {
    const vaultId = vaultStore.getActiveVaultId() ?? null;
    const scoped = sessionsOfVault(state.sessions, vaultId);
    const existing = scoped.find((s) => s.conversationId === conversationId);
    if (existing) {
      if (state.activeSessionId !== existing.id || !state.panelOpen) {
        emit({ ...state, activeSessionId: existing.id, panelOpen: true });
      }
      return { opened: false, tab: existing };
    }
    // 就地切换：活动会话是 qa 时，把它的 conversationId 换成目标会话（标题占位）。
    // 切换本身不加载——由调用方（面板 handleOpenConversation）触发该会话的加载。
    const active = scoped.find((s) => s.id === state.activeSessionId);
    if (active && active.mode === 'qa') {
      const sessions = state.sessions.map((s) =>
        s.id === active.id ? { ...s, conversationId, title: '加载中…' } : s,
      );
      emit({ ...state, sessions, panelOpen: true });
      return { opened: false, tab: { ...active, conversationId, title: '加载中…' }, switched: true };
    }
    if (scoped.length >= MAX_CHAT_SESSIONS) {
      return { opened: false, reason: 'limit' };
    }
    const id = nextId();
    const newTab: ChatSessionTab = {
      id, title: '加载中…', conversationId, mode: 'qa', filePath: null, vaultId,
    };
    emit({ ...state, sessions: [...state.sessions, newTab], activeSessionId: id, panelOpen: true });
    return { opened: true, tab: newTab };
  },
};

/**
 * 当前库的会话标签（可见集合）。
 *
 * 会话标签按知识库隔离：切到另一个库 → 这里只返回那个库的会话（标签栏不再出现
 * 旧库的标签）；切回来 → 原样恢复。订阅当前库，所以切库即时生效。
 */
export function useKbChatSessions(): ChatSessionTab[] {
  const vaultId = useActiveVaultId();
  const all = useSyncExternalStore(
    kbChatSessionsStore.subscribe, kbChatSessionsStore.getSessions, kbChatSessionsStore.getSessions,
  );
  return useMemo(() => sessionsOfVault(all, vaultId), [all, vaultId]);
}

/**
 * 当前库的活动会话 id。
 *
 * 底层 activeSessionId 是全局的，切库后可能指向别的库的会话（不可见）——
 * 这里取当前库作用域内的那个（store.getActiveSessionId 已按库解析）。
 * 额外订阅当前库：库一变，活动会话的作用域跟着变，必须重渲染。
 */
export function useKbChatActiveSessionId(): string | null {
  useActiveVaultId();
  return useSyncExternalStore(
    kbChatSessionsStore.subscribe, kbChatSessionsStore.getActiveSessionId, kbChatSessionsStore.getActiveSessionId,
  );
}
export function useKbChatPanelOpen(): boolean {
  return useSyncExternalStore(kbChatSessionsStore.subscribe, kbChatSessionsStore.isPanelOpen, kbChatSessionsStore.isPanelOpen);
}

/**
 * 会话输入框的**草稿**命名空间 —— 面板态（`KbChatSession`）与全屏态（`/chat` 的
 * `HomePage`）必须**逐字一致**：两个视图共享同一份草稿。这里是唯一真值源，两处都调它，
 * 杜绝格式漂移。放在 store 里是为了让两个组件都能 import 且不产生循环依赖。
 *
 * 只带会话 id、不带 filePath：切换所看的文档时，没发出去的草稿留在会话里
 * （引用 chip 才跟着文档走，见 `sessionComposerMountKey`）。
 */
export function sessionComposerKey(id: string): string {
  return `kb:${id}`;
}

/**
 * composer 的 React key：带 filePath，换文档时重挂载以按新种子播种引用 chip。
 * 草稿与 chip 缓存都按会话 id（`sessionComposerKey`）分桶，mountKey 只负责触发
 * 重挂载；chip 缓存自己按「由哪篇文档播种」判断是否沿用。
 */
export function sessionComposerMountKey(id: string, filePath?: string | null): string {
  return `${id}:${filePath ?? ''}`;
}
