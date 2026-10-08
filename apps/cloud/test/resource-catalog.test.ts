import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketCatalogView, type MarketListing } from '@molio/contracts';
const listings: MarketListing[] = Array.from({length:217}, (_,i) => ({
  id:String(i),name:`数学 ${i}`,summary:'基础课程',tags:['代数'],source:'official',icon:'📚',tint:'#eee',
  overview:[],highlights:[],previews:[],version:'1',priceCents:i,payUrl:'',author:'test',fileSize:1,publishedAt:null,
  category:{id:'math',kind:'category',name:'数学',position:1},
  resourceType:{id:'knowledge',kind:'type',name:'知识库',position:1},
}));
test('catalog grows past 200: batch overview, exact counts, incremental batches with no duplicates', () => {
  const view = marketCatalogView(listings);
  assert.equal(view.total,217);
  // 分组视图的每类上限就是 limit：先露一批，滚动再放大（没有「查看全部」按钮）
  assert.equal(view.groups[0]!.items.length,9);
  assert.equal(view.hasMore,true);
  assert.equal(view.shown,9);
  // 平铺视图：一批 9 条
  const first=marketCatalogView(listings,{category:'math'});
  assert.equal(first.items.length,9);
  assert.equal(first.hasMore,true);
  const ids = new Set<string>();
  for(let limit=9;limit<=225;limit+=9) {
    marketCatalogView(listings,{category:'math',limit}).items.forEach(m=>ids.add(m.id));
  }
  assert.equal(ids.size,217);
  const all=marketCatalogView(listings,{category:'math',limit:225});
  assert.equal(all.items.length,217);
  assert.equal(all.hasMore,false);
  // 放大到装得下就不再 hasMore（分组视图同理）
  assert.equal(marketCatalogView(listings,{limit:225}).hasMore,false);
});
test('search keeps category and matches all terms; unavailable filters do not silently switch', () => {
  assert.equal(marketCatalogView(listings,{q:'基础 代数',category:'math'}).total,217);
  assert.equal(marketCatalogView(listings,{q:'基础 代数',category:'missing'}).total,0);
  assert.equal(marketCatalogView(listings,{type:'missing'}).total,0);
  assert.equal(marketCatalogView(listings,{q:'代数 missing'}).total,0);
});
test('legacy unclassified items remain reachable; new types work without a code registry', () => {
  const item={...listings[0]!,category:null,resourceType:{id:'new',kind:'type' as const,name:'数据集',position:9}};
  const view=marketCatalogView([item],{category:'uncategorized',type:'new'});
  assert.equal(view.total,1);
  assert.equal(view.types[0]!.name,'数据集');
});
