/**
 * 「发布到资源库」身份门禁快照 —— 进程内单例，替代各组件各自 fetch /api/market/my。
 *
 * 为什么需要它：发布入口点击时必须**同步**分流（管理员 = 页内发布 tab；
 * 其他 = 系统浏览器打开官网联系页），因为 `window.open` 必须在用户手势里调用。
 * 而 /api/market/my 要等云端往返（实测 1~4s），首屏点得快就会落进「非管理员」
 * 分支——管理员被丢进浏览器，页内发布配置页永远打不开（2026-10 用户报告）。
 *
 * 现在 daemon 的 GET /api/market/role 从本地 kv 缓存即答（首次判定才走云端），
 * 本 store 再把结论缓存到内存。三种结论：
 * - 'admin' / 'member' / 'signed-out'：已判定，调用方可以直接分流；
 * - null（未判定）：**必须等**，绝不能当成非管理员。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { MarketRoleResponse } from '@molio/contracts';
import { api } from '../api/client.js';
import { useAuthStatus } from './authStore.js';

export type MarketRole = 'admin' | 'member' | 'signed-out';

export interface MarketRoleSnapshot {
  /** 已判定的身份；null = 还没判定出来（未取数 / 云端不可达且无缓存） */
  role: MarketRole | null;
  /** 是否有请求在飞（仅 role === null 时有意义） */
  loading: boolean;
  /** 最近一次判定失败（云侧不可达），可触发重试 */
  failed: boolean;
}

type Listener = () => void;

let snapshot: MarketRoleSnapshot = { role: null, loading: false, failed: false };
const listeners = new Set<Listener>();
let inFlight: Promise<MarketRole | null> | null = null;
/** 上一次判定成功时对应的登录上下文（用户 id / 'anon'） */
let settledKey: string | null = null;
let seq = 0;

function emit(): void {
  for (const l of listeners) l();
}

function setSnapshot(next: Partial<MarketRoleSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  emit();
}

export const marketRoleStore = {
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getSnapshot(): MarketRoleSnapshot {
    return snapshot;
  },

  /**
   * 确保当前登录上下文已判定过一次身份。
   * - 已有结论且上下文没变 → 立即返回（不发请求）
   * - 有请求在飞 → 复用（并发点击不会打云两次）
   * - force=true → 忽略结论重新判定（失败后用户再点 = 重试）
   */
  ensure(key: string, force = false): Promise<MarketRole | null> {
    if (!force && inFlight) return inFlight;
    if (!force && snapshot.role !== null && settledKey === key) return Promise.resolve(snapshot.role);
    const mySeq = ++seq;
    setSnapshot({ loading: true, failed: false });
    const p = api.getMarketRole()
      .then((body: MarketRoleResponse): MarketRole | null => {
        const role: MarketRole | null = !body.loggedIn
          ? 'signed-out'
          : body.isAdmin === true ? 'admin'
            : body.isAdmin === false ? 'member'
              : null; // isAdmin=null：云端不可达且无缓存，保持未决
        if (mySeq === seq) {
          if (role !== null) settledKey = key;
          // 未决时保留上一次结论（不把已确认的管理员降级成未决）
          setSnapshot({ loading: false, failed: role === null, ...(role !== null ? { role } : {}) });
        }
        return role;
      })
      .catch(() => {
        if (mySeq === seq) setSnapshot({ loading: false, failed: true });
        return null;
      });
    inFlight = p;
    void p.finally(() => { if (inFlight === p) inFlight = null; });
    return p;
  },
};

export interface UseMarketRoleResult {
  role: MarketRole | null;
  loading: boolean;
  failed: boolean;
  /** 等（必要时触发）一次身份判定；force=true 重试 */
  ensure: (force?: boolean) => Promise<MarketRole | null>;
}

/**
 * 订阅身份门禁快照，并在登录态变化时自动判定一次。
 * key 只用于判断「是否需要重新判定」：登录用户用 user id，未登录/未知用 'anon'。
 */
export function useMarketRole(): UseMarketRoleResult {
  const auth = useAuthStatus();
  const key = auth?.loggedIn ? auth.user.id : 'anon';
  const snap = useSyncExternalStore(marketRoleStore.subscribe, marketRoleStore.getSnapshot, marketRoleStore.getSnapshot);

  useEffect(() => {
    void marketRoleStore.ensure(key);
  }, [key]);

  const ensure = useCallback((force = false) => marketRoleStore.ensure(key, force), [key]);
  return { role: snap.role, loading: snap.loading, failed: snap.failed, ensure };
}
