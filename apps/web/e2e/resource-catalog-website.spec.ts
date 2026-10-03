/** @area resources @priority P1 */
import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {renderListingPage} from '../../cloud/src/ssr/render';
import type {MarketListing} from '@molio/contracts';
const listing:MarketListing={id:'test',name:'数学',summary:'基础资料',tags:[],overview:[],highlights:[],previews:[],source:'official',icon:'📚',tint:'#eee',version:'1',priceCents:0,payUrl:'',author:'test',fileSize:1,publishedAt:null,category:{id:'math',name:'数学',kind:'category',position:0}};
const data=Array.from({length:17},(_,i)=>({...listing,id:'test-'+i,name:'数学 '+i}));
test('website SSR enhancement: groups, search, scroll loading, URL reload and mobile layout',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  // 接管全部请求：SSR 页还挂着 GA / 百度统计等真实外网请求，交给网络时一旦不可达
  // 就会拖住 load 事件直到超时（本机实测：外网不通时 goto/reload 双双 30s 超时）。
  await page.route('**',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://catalog.test')return route.abort();
    const path=url.pathname;
    if(path==='/resources.html')return route.fulfill({contentType:'text/html',body:renderListingPage(data)});
    if(path==='/resource-catalog.js'||path==='/styles.css')return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':'text/css',body:readFileSync(new URL('../../landing-page'+path,import.meta.url),'utf8')});
    return route.fulfill({contentType:'text/javascript',body:''});
  });
  await page.goto('https://catalog.test/resources.html');
  await expect(page.locator('#rl-count')).toHaveText('17 个资源');
  // 分组视图也走滚动加载：滚到底后 17 条全部出现（SSR 本来就渲染了全部卡片，这里只是逐批显示）
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator('[data-resource-id]')).toHaveCount(17);
  await page.reload();
  // 显示条数不进 URL：刷新回到第一批，需再滚到底展开
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator('[data-resource-id]')).toHaveCount(17);
  // 分类筛选走顶部 chip（分组标题里的「查看全部」按钮已删）；点完会滚回筛选条，需再滚到底
  await page.locator('[data-category="math"]').click();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator('[data-resource-id]')).toHaveCount(17);
  await page.locator('#rl-search').fill('不存在');
  await expect(page.locator('#rl-no-match')).toBeVisible();
  await page.locator('#rl-clear').click();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator('[data-resource-id]')).toHaveCount(17);
  // 购买按钮必须压住「铺满卡片」的标题链接，否则点购买会变成跳详情
  const buyBtn = page.locator('.rl-buy').first();
  await buyBtn.scrollIntoViewIfNeeded();
  expect(
    await buyBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === el || el.contains(hit);
    }),
  ).toBe(true);

  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/catalog-website-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:'test-results/catalog-website-desktop.png',fullPage:true});
  expect(errors).toEqual([]);
});
