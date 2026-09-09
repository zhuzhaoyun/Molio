/**
 * KB 单库分屏状态（per-vault 工厂，仿 createTabsStore）。
 * companion=null 即单视图；ratio 是主格宽度占比（clamp 0.25–0.75）。
 * 持久化到 localStorage `molio.kb.split.<vaultId>`，随 vault 分片；
 * 多窗口每窗独立 renderer，天然互不干扰（同 kbTabsStore）。
 * 注意：不得在模块顶层访问 localStorage（node:test 环境无此全局）。
 */
import { useMemo, useSyncExternalStore, useCallback } from 'react';

export type CompanionView = { type: 'graph' } | { type: 'file'; filePath: string };

const RATIO_MIN = 0.25;
const RATIO_MAX = 0.75;
const DEFAULT_RATIO = 0.5;

const storeCache = new Map<string, SplitViewStoreImpl>();

interface PersistedShape { companion: CompanionView | null; ratio: number }

export interface SplitViewStoreImpl {
  getCompanion(): CompanionView | null;
  setCompanion(c: CompanionView | null): void;
  getRatio(): number;
  setRatio(r: number): void;
  subscribe(fn: () => void): () => void;
}

function readPersisted(key: string): PersistedShape {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { companion: null, ratio: DEFAULT_RATIO };
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    const companion = parsed.companion ?? null;
    const valid =
      companion === null ||
      (companion.type === 'graph') ||
      (companion.type === 'file' && typeof companion.filePath === 'string' && companion.filePath.length > 0);
    const ratio = typeof parsed.ratio === 'number' && Number.isFinite(parsed.ratio)
      ? Math.min(RATIO_MAX, Math.max(RATIO_MIN, parsed.ratio))
      : DEFAULT_RATIO;
    return { companion: valid ? companion : null, ratio };
  } catch {
    return { companion: null, ratio: DEFAULT_RATIO };
  }
}

function persist(key: string, state: PersistedShape) {
  try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* 配额/隐私模式——静默 */ }
}

export function createSplitViewStore(vaultId: string): SplitViewStoreImpl {
  const cached = storeCache.get(vaultId);
  if (cached) return cached;

  const key = `molio.kb.split.${vaultId}`;
  let { companion, ratio } = readPersisted(key);
  const listeners = new Set<() => void>();

  const emit = () => { for (const fn of listeners) fn(); };

  const store: SplitViewStoreImpl = {
    getCompanion: () => companion,
    setCompanion(c) {
      if (companion === c) return;                       // 幂等：同引用不重发
      if (companion !== null && c !== null) {
        // 幂等：深值相同不重发（graph↔graph / file↔file 同路径）
        if (companion.type === 'graph' && c.type === 'graph') return;
        if (companion.type === 'file' && c.type === 'file' && companion.filePath === c.filePath) return;
      }
      companion = c;
      persist(key, { companion, ratio });
      emit();
    },
    getRatio: () => ratio,
    setRatio(r) {
      const next = Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
      if (next === ratio) return;
      ratio = next;
      persist(key, { companion, ratio });
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
  storeCache.set(vaultId, store);
  return store;
}

export interface SplitViewHook {
  companion: CompanionView | null;
  ratio: number;
  setCompanion(c: CompanionView | null): void;
  setRatio(r: number): void;
}

const nullCompanion: CompanionView | null = null;
const getNull = () => nullCompanion;
const getDefaultRatio = () => DEFAULT_RATIO;
const noopSubscribe = () => () => {};

/** 组件消费入口。vaultId 为 null（无活跃库）时返回 null。 */
export function useSplitView(vaultId: string | null): SplitViewHook | null {
  const store = useMemo(() => (vaultId ? createSplitViewStore(vaultId) : null), [vaultId]);

  const companion = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getCompanion : getNull,
  );
  const ratio = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getRatio : getDefaultRatio,
  );

  const setCompanion = useCallback(
    (c: CompanionView | null) => store?.setCompanion(c),
    [store],
  );
  const setRatio = useCallback((r: number) => store?.setRatio(r), [store]);

  return store ? { companion, ratio, setCompanion, setRatio } : null;
}
