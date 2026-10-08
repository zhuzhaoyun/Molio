import type { MarketListing, MarketTaxon } from './market.js';

/** limit = 当前要显示多少条（滚动加载逐批放大）。默认一批 9 条（原型 3 列 × 3 行）。 */
export interface CatalogQuery { category?: string; type?: string; q?: string; limit?: number; }
/** Pure shared view model. Kept self-contained for SSR's progressive-enhancement script. */
export function marketCatalogView(listings: MarketListing[], query: CatalogQuery = {}) {
  const category = query.category || 'all', type = query.type || 'all';
  const words = (query.q || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const categories = new Map<string, MarketTaxon>();
  const types = new Map<string, MarketTaxon>();
  for (const m of listings) {
    const cat = m.category ?? { id: 'uncategorized', name: '未分类', kind: 'category' as const, position: 2147483647 };
    const typ = m.resourceType ?? { id: 'knowledge', name: '知识库', kind: 'type' as const, position: 0 };
    categories.set(cat.id, cat); types.set(typ.id, typ);
  }
  const order = (a: MarketTaxon, b: MarketTaxon) => a.position - b.position || a.id.localeCompare(b.id);
  const matching = listings.filter(m => (type === 'all' || (m.resourceType?.id ?? 'knowledge') === type)
    && words.every(w => [m.name, m.summary, ...m.tags, m.category?.name ?? '未分类', m.resourceType?.name ?? '知识库'].join(' ').toLocaleLowerCase().includes(w)));
  const filtered = matching.filter(m => category === 'all' || (m.category?.id ?? 'uncategorized') === category);
  // 固定按上架时间倒序（与云端 listActiveListings 的 ORDER BY published_at DESC 一致）。
  // 注意：本函数会被 toString() 序列化进 SSR 页面，数字必须内联、不能引模块常量。
  filtered.sort((a,b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.id.localeCompare(b.id));
  const grouped = category === 'all' && type === 'all' && words.length === 0;
  // 滚动加载：limit 是「当前显示多少条」，不是页码。分组视图把它当**每类**上限，
  // 平铺视图当总量上限 —— 两种视图都靠滚动放大 limit 露更多，没有「查看全部」按钮。
  const limit = Number.isFinite(query.limit) && query.limit! > 0 ? Math.floor(query.limit!) : 9;
  const facets = [...categories.values()].sort(order).map(c => ({ ...c, count: matching.filter(m => (m.category?.id ?? 'uncategorized') === c.id).length }));
  const byCategory = (id: string) => filtered.filter(m => (m.category?.id ?? 'uncategorized') === id);
  const groups = facets.map(c => ({ category: c, items: byCategory(c.id).slice(0, limit) }));
  return {
    categories: facets, types: [...types.values()].sort(order), total: filtered.length,
    matchingTotal: matching.length, grouped,
    shown: limit,
    hasMore: grouped ? facets.some(c => byCategory(c.id).length > limit) : filtered.length > limit,
    items: grouped ? filtered : filtered.slice(0, limit),
    groups,
  };
}
