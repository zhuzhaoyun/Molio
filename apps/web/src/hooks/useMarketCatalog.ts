/**
 * 市场资源目录运行时拉取 —— daemon 镜像 GET /api/market/listings（官方+用户同目录）。
 *
 * 60s 内存缓存防抖：TTL 内多个组件共享同一份数据，不重复请求；
 * 失败不抛 —— 标记 stale 并保留旧数据（或空），资源区块降级。
 */
import { useCallback, useEffect, useState } from 'react';
import type { MarketListing } from '@molio/contracts';

interface CatalogState {
  listings: MarketListing[];
  stale: boolean;
  loading: boolean;
}

let memCache: { at: number; data: MarketListing[] } | null = null;
const TTL_MS = 60_000;

export function useMarketCatalog(): CatalogState & { refresh: () => void } {
  const [state, setState] = useState<CatalogState>(() => ({
    listings: memCache?.data ?? [],
    stale: false,
    loading: memCache === null,
  }));

  const load = useCallback(async (force = false) => {
    if (!force && memCache && Date.now() - memCache.at < TTL_MS) {
      setState({ listings: memCache.data, stale: false, loading: false });
      return;
    }
    try {
      const res = await fetch('/api/market/listings');
      if (!res.ok) throw new Error(`market ${res.status}`);
      const body = (await res.json()) as { listings: MarketListing[]; stale?: boolean };
      memCache = { at: Date.now(), data: body.listings };
      setState({ listings: body.listings, stale: body.stale ?? false, loading: false });
    } catch {
      // 失败不抛：保留旧数据或空，标记 stale，社区区块降级
      setState((s) => ({ ...s, loading: false, stale: true }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 稳定引用：页面侧以 [refresh] 依赖挂载刷新，避免每次渲染重复强制拉取
  const refresh = useCallback(() => { void load(true); }, [load]);

  return { ...state, refresh };
}
