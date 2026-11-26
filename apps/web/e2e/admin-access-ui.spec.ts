/** @area auth
 * @priority P0
 * Real production Web build against an isolated server daemon and HTTPS proxy.
 */
import { test, expect, startAdminServer } from './fixtures/admin-server';
import type { Page } from '@playwright/test';
import type { AdminServer } from './fixtures/admin-server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('market suggestion and content-only updates include the administrator CSRF token', async ({ page, admin }) => {
  const content = {
    version: 1, positioning: { what: 'Knowledge resource', who: ['Readers'], notFor: [] },
    facts: [{ label: 'Pages', value: '1' }],
    themes: [{ name: 'Topic', summary: 'Summary', items: ['Item'] }], questions: [],
    delivery: { format: 'Markdown', includes: [], requirements: [], steps: [] },
    review: { basis: 'Publisher review', reviewedAt: '2026-11-26', status: 'draft' },
  };
  await page.route('**/api/market/my', route => route.fulfill({ json: { isAdmin: true, listings: [{
    id: 'csrf-listing', name: 'CSRF resource', summary: 'Summary', icon: '📚', tags: [],
    priceCents: 0, status: 'active', version: '1.0.0', content,
  }] } }));
  await page.goto(`${admin.origin}/knowledge?panel=publish`);
  await login(page, admin);
  const session = await (await page.request.get(`${admin.origin}/api/access/session`)).json() as { csrfToken: string };
  const writes: Array<{ path: string; csrf?: string }> = [];
  for (const path of ['/api/market/publish-suggest', '/api/market/listings/csrf-listing/content']) {
    await page.route(`**${path}`, async route => {
      const csrf = route.request().headers()['x-molio-csrf']; writes.push({ path, csrf });
      if (csrf !== session.csrfToken) return route.fulfill({ status: 403, json: { error: 'forbidden' } });
      await route.fulfill({ json: { name: 'Suggested resource', summary: 'Summary', tags: [], icon: '📚', content } });
    });
  }
  await page.locator('.publish-listing-select select').selectOption('csrf-listing');
  await page.getByTestId('publish-content-regen').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.csrf).toBe(session.csrfToken);
  await expect(page.getByTestId('publish-content-save')).toBeEnabled();
  await page.getByTestId('publish-content-save').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]?.csrf).toBe(session.csrfToken);
});

export async function login(page:Page,admin:AdminServer) {
  await page.locator('[data-testid="admin-username-input"]').fill(admin.username);
  await page.locator('[data-testid="admin-password-input"]').fill(admin.password);
  await page.locator('[data-testid="admin-login-submit"]').click();
  await expect(page.locator('.entry-shell')).toBeVisible({timeout:15000});
}
test('anonymous workspace is never mounted and only session discovery runs',async({page,admin})=>{
  const privateRequests:string[]=[];page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/api/')&&p!=='/api/access/session')privateRequests.push(p);});
  await page.goto(`${admin.origin}/settings?tab=runtimes#keep`);
  await expect(page.locator('[data-testid="admin-login-form"]')).toBeVisible();
  await expect(page.locator('.entry-shell')).toHaveCount(0);expect(privateRequests).toEqual([]);
});
test('login form retains a deep link and refreshing restores the administrator session',async({page,admin})=>{
  await page.goto(`${admin.origin}/settings?tab=runtimes#keep`);await login(page,admin);
  await expect(page).toHaveURL(`${admin.origin}/settings?tab=runtimes#keep`);await page.reload();
  await expect(page.locator('.entry-shell')).toBeVisible();await expect(page.locator('[data-testid="admin-logout-btn"]')).toBeVisible();
});
test('wrong password is an inline error and clears the password only',async({page,admin})=>{
  await page.goto(admin.origin);await page.locator('[data-testid="admin-username-input"]').fill(admin.username);await page.locator('[data-testid="admin-password-input"]').fill('incorrect');await page.locator('[data-testid="admin-login-submit"]').click();
  await expect(page.locator('[data-testid="admin-login-error"]')).toBeVisible();await expect(page.locator('[data-testid="admin-password-input"]')).toHaveValue('');await expect(page.locator('[data-testid="admin-username-input"]')).toHaveValue(admin.username);await expect(page.locator('.entry-shell')).toHaveCount(0);
});
test('unreachable discovery has a retry action and never falls back to local',async({page,admin})=>{
  await page.route('**/api/access/session',r=>r.fulfill({status:503,body:'unavailable'}));await page.goto(admin.origin);
  await expect(page.locator('[data-testid="admin-access-retry"]')).toBeVisible();await expect(page.locator('.entry-shell')).toHaveCount(0);
  await page.unroute('**/api/access/session');await page.locator('[data-testid="admin-access-retry"]').click();await expect(page.locator('[data-testid="admin-login-form"]')).toBeVisible();
});
test('logout cancellation preserves the page and confirmed logout removes private DOM',async({page,admin})=>{
  await page.goto(`${admin.origin}/settings`);await login(page,admin);let writes=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/access/logout')writes++;});
  await page.locator('[data-testid="admin-logout-btn"]').click();await page.locator('[data-testid="admin-logout-cancel"]').click();expect(writes).toBe(0);await expect(page.locator('.entry-shell')).toBeVisible();
  await page.locator('[data-testid="admin-logout-btn"]').click();await page.locator('[data-testid="admin-logout-confirm"]').click();await expect(page.locator('[data-testid="admin-login-form"]')).toBeVisible();await expect(page.locator('.entry-shell')).toHaveCount(0);expect(writes).toBe(1);
});
test('rate limiting prevents a second submit and the login page fits a narrow screen',async({page,admin})=>{
  await page.setViewportSize({width:320,height:720});await page.route('**/api/access/login',r=>r.fulfill({status:429,contentType:'application/json',headers:{'Retry-After':'60'},body:'{"error":"rate_limited"}'}));await page.goto(admin.origin);
  await page.locator('[data-testid="admin-username-input"]').fill(admin.username);await page.locator('[data-testid="admin-password-input"]').fill(admin.password);await page.locator('[data-testid="admin-login-submit"]').click();await expect(page.locator('[data-testid="admin-login-submit"]')).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('local mode enters directly without administrator controls',async({page,adminWebDir})=>{
  const local=await startAdminServer({webDir:adminWebDir,username:'unused',password:'unused local test password',mode:'local'});
  try{await page.goto(`${local.origin}/settings`);await expect(page.locator('.entry-shell')).toBeVisible();await expect(page.locator('[data-testid="admin-login-form"]')).toHaveCount(0);await expect(page.locator('[data-testid="admin-logout-btn"]')).toHaveCount(0);}finally{await local.stop();}
});
test('administrator saves a real knowledge document through the editor',async({page,admin})=>{
  await page.goto(`${admin.origin}/knowledge`);await login(page,admin);
  await page.locator('.kb-tree-item').filter({hasText:'acceptance'}).click();
  await page.locator('[data-testid="kb-btn-typeset"]').click();
  await page.locator('.kb-typeset-textarea').fill('# Saved by administrator\n\nA real authenticated write.');
  const saved=page.waitForResponse(r=>r.url().includes('/files/')&&r.request().method()==='POST');await page.keyboard.press('ControlOrMeta+s');
  expect((await saved).status()).toBe(200);expect(readFileSync(join(admin.vaultDir,'acceptance.md'),'utf8')).toContain('Saved by administrator');
});
test('server stream closure pauses observation without sending queued messages or creating another run',async({page,admin})=>{
  await page.addInitScript(()=>{class ControlledStream {readyState=0;onopen:any=null;onmessage:any=null;onerror:any=null;constructor(url:string){setTimeout(()=>{this.readyState=1;this.onopen?.(new Event('open'));},50);if(url.includes('/runs/'))(window as any).__closeObservedRun=()=>{this.readyState=2;this.onerror?.(new Event('error'));};}close(){this.readyState=2;}}Object.defineProperty(window,'EventSource',{value:ControlledStream});});
  let creates=0;
  await page.route('**/api/agents',r=>r.fulfill({json:{agents:[{id:'codex',name:'Codex',available:true,binary:'/test/codex',source:'path',version:'test',models:[],installUrl:''}]}}));
  await page.route('**/api/runs',r=>{if(r.request().method()==='POST'){creates++;return r.fulfill({json:{runId:'acceptance-run'}});}return r.fulfill({json:{runs:[]}});});
  await page.route('**/api/runs/acceptance-run',r=>r.fulfill({json:{id:'acceptance-run',agentId:'codex',status:'running',createdAt:Date.now(),lastStopReason:null,conversationId:null}}));
  await page.goto(`${admin.origin}/chat`);await login(page,admin);
  const composer=page.locator('[data-testid="composer-input"]');await composer.fill('first intended message');await composer.press('Enter');
  await expect.poll(()=>creates).toBe(1);await expect(composer).toBeEnabled();await composer.fill('queued intended message');await composer.press('Enter');
  await page.evaluate(()=>(window as any).__closeObservedRun());await expect(page.locator('[data-testid="chat-transport-status"]')).toBeVisible({timeout:15000});
  expect(creates).toBe(1);await expect(page.locator('[data-testid="chat-transport-retry"]')).toBeVisible();
});
test('shared-cookie tabs sign out together while an independent session survives',async({page,context,browser,admin})=>{
  await page.goto(`${admin.origin}/settings`);await login(page,admin);const peer=await context.newPage();await peer.goto(`${admin.origin}/settings`);await expect(peer.locator('.entry-shell')).toBeVisible();
  const other=await browser.newContext({ignoreHTTPSErrors:true});
  try{const independent=await other.newPage();await independent.goto(`${admin.origin}/settings`);await login(independent,admin);
    await page.locator('[data-testid="admin-logout-btn"]').click();await page.locator('[data-testid="admin-logout-confirm"]').click();
    await expect(page.locator('[data-testid="admin-login-form"]')).toBeVisible();await expect(peer.locator('[data-testid="admin-login-form"]')).toBeVisible();
    expect(await independent.evaluate(async()=>(await fetch('/api/config')).status)).toBe(200);
  }finally{await other.close();}
});
test('a failed logout remains unconfirmed and can explicitly return to the same session',async({page,admin})=>{
  await page.goto(`${admin.origin}/settings`);await login(page,admin);await page.route('**/api/access/logout',r=>r.abort('failed'));
  await page.locator('[data-testid="admin-logout-btn"]').click();await page.locator('[data-testid="admin-logout-confirm"]').click();
  await expect(page.locator('[data-testid="admin-logout-unconfirmed"]')).toBeVisible();await expect(page.locator('.entry-shell')).not.toBeVisible();
  expect(await page.evaluate(async()=>(await (await fetch('/api/access/session')).json()).authenticated)).toBe(true);
  await page.locator('[data-testid="admin-logout-resume"]').click();await expect(page.locator('.entry-shell')).toBeVisible();
});
test('a lost response after a real logout is resolved by checking server state',async({page,admin})=>{
  await page.goto(`${admin.origin}/settings`);await login(page,admin);
  await page.route('**/api/access/logout',async r=>{await r.fetch();await r.abort('failed');});
  await page.locator('[data-testid="admin-logout-btn"]').click();await page.locator('[data-testid="admin-logout-confirm"]').click();
  await expect(page.locator('[data-testid="admin-login-form"]')).toBeVisible();expect(await page.evaluate(async()=>(await fetch('/api/config')).status)).toBe(401);
});
test('server-side expiry removes private DOM and leaves saved files intact',async({page,context,admin})=>{
  await page.goto(`${admin.origin}/knowledge`);await login(page,admin);
  const cookie=(await context.cookies(admin.origin)).find(x=>x.name==='__Host-molio_admin')!;
  await admin.expireSession(createHash('sha256').update(cookie.value).digest('hex'));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('[data-testid="admin-login-form"]')).toBeVisible();await expect(page.locator('.entry-shell')).toHaveCount(0);
  expect(await page.evaluate(async()=>(await fetch('/api/config')).status)).toBe(401);expect(readFileSync(join(admin.vaultDir,'acceptance.md'),'utf8')).toContain('Original saved text');
});
test('an old logout intent cannot revoke a newer cookie session',async({page,admin})=>{
  await page.goto(`${admin.origin}/settings`);
  await login(page,admin);
  await page.locator('[data-testid="admin-logout-btn"]').click();
  await expect(page.locator('[data-testid="admin-logout-confirm"]')).toBeVisible();
  const reloaded=page.waitForEvent('framenavigated',frame=>frame===page.mainFrame()).then(()=>({kind:'reload' as const}));
  expect(await page.evaluate(async credentials=>(await fetch('/api/access/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(credentials)})).status,{username:admin.username,password:admin.password})).toBe(200);
  // The stale dialog may submit first (403) or a concurrent stale-CSRF write
  // may trigger the designed session-change reload before the click lands.
  const rejected=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/access/logout').then(response=>({kind:'logout' as const,response}));
  await page.locator('[data-testid="admin-logout-confirm"]').click({timeout:2000}).catch(()=>{});
  const outcome=await Promise.race([reloaded,rejected]);
  if(outcome.kind==='logout')expect(outcome.response.status()).toBe(403);
  await expect(page.locator('.entry-shell')).toBeVisible();
  expect(await page.evaluate(async()=>(await (await fetch('/api/access/session')).json()).authenticated)).toBe(true);
});
test('real multipart upload keeps the browser boundary and imported bytes',async({page,admin})=>{
  await page.goto(`${admin.origin}/knowledge`);await login(page,admin);
  await page.getByTestId('kb-btn-import').click();
  await page.locator('.kb-dropzone input[type=file]').setInputFiles({name:'uploaded.txt',mimeType:'text/plain',buffer:Buffer.from('Authenticated multipart upload')});
  const response=page.waitForResponse(r=>r.url().endsWith('/import')&&r.request().method()==='POST');
  await page.getByTestId('kb-import-submit').click();const result=await response;
  expect(result.status()).toBe(200);const headers=await result.request().allHeaders();
  expect(headers['content-type']).toContain('multipart/form-data; boundary=');expect(headers['x-molio-csrf']).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(join(admin.vaultDir,'uploaded.txt'),'utf8')).toBe('Authenticated multipart upload');
});
test('storage fallback notices trigger verification without trusting a peer claim',async({page,context,admin})=>{
  await context.addInitScript(()=>{Object.defineProperty(window,'BroadcastChannel',{value:undefined});});
  await page.goto(`${admin.origin}/settings`);await login(page,admin);const peer=await context.newPage();await peer.goto(`${admin.origin}/settings`);await expect(peer.locator('.entry-shell')).toBeVisible();
  await page.evaluate(()=>localStorage.setItem('molio.admin.access.notice',JSON.stringify({type:'session-changed',nonce:'claim-only'})));
  await expect(peer.locator('.entry-shell')).toBeVisible();
  await page.getByTestId('admin-logout-btn').click();await page.getByTestId('admin-logout-confirm').click();await expect(peer.getByTestId('admin-login-form')).toBeVisible();
});
test('cloud business rejection keeps the administrator signed in',async({page,admin})=>{
  let calls=0;await page.route('**/api/auth/status',r=>{calls++;return r.fulfill({status:401,json:{error:'no_session'}});});
  await page.goto(`${admin.origin}/settings`);await login(page,admin);
  await expect.poll(()=>calls).toBeGreaterThan(0);await expect(page.getByTestId('admin-logout-btn')).toBeVisible();
  expect(await page.evaluate(async()=>(await (await fetch('/api/access/session')).json()).authenticated)).toBe(true);
});
test('administrator login and logout confirmation are keyboard usable',async({page,admin})=>{
  await page.goto(`${admin.origin}/settings`);await page.getByTestId('admin-username-input').fill(admin.username);await page.getByTestId('admin-password-input').fill(admin.password);await page.getByTestId('admin-password-input').press('Enter');
  await page.getByTestId('admin-logout-btn').focus();await page.keyboard.press('Enter');await expect(page.getByTestId('admin-logout-cancel')).toBeFocused();
  await page.keyboard.press('Shift+Tab');await expect(page.getByTestId('admin-logout-confirm')).toBeFocused();
  await page.keyboard.press('Tab');await expect(page.getByTestId('admin-logout-cancel')).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.getByTestId('admin-logout-confirm')).toHaveCount(0);await expect(page.getByTestId('admin-logout-btn')).toBeFocused();
});
test('a silent server stream timeout pauses instead of completing or draining the queue',async({page,admin})=>{
  await page.addInitScript(()=>{
    (window as any).__MOLIO_TEST_FALLBACK_TIMEOUT_MS__=1000;
    class SilentStream { readyState=1;onopen:any=null;onmessage:any=null;onerror:any=null;constructor(){setTimeout(()=>this.onopen?.(new Event('open')),0);}close(){this.readyState=2;} }
    Object.defineProperty(window,'EventSource',{value:SilentStream});
  });
  let creates=0;
  await page.route('**/api/agents',r=>r.fulfill({json:{agents:[{id:'codex',name:'Codex',available:true,binary:'/test/codex',source:'path',version:'test',models:[],installUrl:''}]}}));
  await page.route('**/api/runs',r=>{if(r.request().method()==='POST'){creates++;return r.fulfill({json:{runId:'silent-run'}});}return r.fulfill({json:{runs:[]}});});
  await page.goto(`${admin.origin}/chat`);await login(page,admin);const composer=page.getByTestId('composer-input');await composer.fill('first');await composer.press('Enter');await expect.poll(()=>creates).toBe(1);await composer.fill('queued');await composer.press('Enter');
  await expect(page.getByTestId('chat-transport-status')).toBeVisible({timeout:5000});expect(creates).toBe(1);await expect(page.getByTestId('chat-transport-retry')).toBeVisible();
});
test('private images PDF and downloads work only with an administrator cookie',async({page,context,browser,admin})=>{
  await page.goto(`${admin.origin}/knowledge`);await login(page,admin);await page.locator('.kb-tree-item').filter({hasText:'images.md'}).click();
  const image=page.locator('img[src*="/raw/"]:visible');await expect(image).toHaveCount(1);await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
  const raw=await image.getAttribute('src');expect(raw).not.toMatch(/csrf|token|password/);
  await page.locator('.kb-tree-item').filter({hasText:'sample.pdf'}).click();await expect(page.getByTestId('pdf-statusbar')).toContainText('1 / 3',{timeout:20000});await expect(page.getByTestId('pdf-canvas-1')).toBeVisible();
  expect((await context.request.get(new URL(raw!,admin.origin).href)).status()).toBe(200);
  const anonymous=await browser.newContext({ignoreHTTPSErrors:true});try{expect((await anonymous.request.get(new URL(raw!,admin.origin).href)).status()).toBe(401);}finally{await anonymous.close();}
});
test('two real knowledge subscriptions remain isolated when one administrator logs out',async({page,browser,admin})=>{
  const instrumentation=()=>{const Native=window.EventSource;(window as any).__streams={messages:0,closed:0};class Observed extends Native{constructor(url:string|URL,init?:EventSourceInit){super(url,init);this.addEventListener('message',()=>{(window as any).__streams.messages++;});}close(){(window as any).__streams.closed++;super.close();}}Object.defineProperty(window,'EventSource',{value:Observed});};
  await page.addInitScript(instrumentation);await page.goto(`${admin.origin}/knowledge`);await login(page,admin);
  const other=await browser.newContext({ignoreHTTPSErrors:true});try{const peer=await other.newPage();await peer.addInitScript(instrumentation);await peer.goto(`${admin.origin}/knowledge`);await login(peer,admin);
    const write=async(text:string)=>peer.evaluate(async text=>{const s=await(await fetch('/api/access/session')).json();const v=await(await fetch('/api/knowledge/vaults')).json();return(await fetch(`/api/knowledge/vaults/${v.vaults[0].id}/files/acceptance.md`,{method:'POST',headers:{'content-type':'application/json','x-molio-csrf':s.csrfToken},body:JSON.stringify({content:text})})).status;},text);
    expect(await write('# First event')).toBe(200);await expect.poll(()=>page.evaluate(()=>(window as any).__streams.messages)).toBeGreaterThan(0);await expect.poll(()=>peer.evaluate(()=>(window as any).__streams.messages)).toBeGreaterThan(0);
    await page.getByTestId('admin-logout-btn').click();await page.getByTestId('admin-logout-confirm').click();await expect(page.getByTestId('admin-login-form')).toBeVisible();
    const before=await peer.evaluate(()=>(window as any).__streams.messages);expect(await write('# Second event')).toBe(200);await expect.poll(()=>peer.evaluate(()=>(window as any).__streams.messages)).toBeGreaterThan(before);expect(await peer.evaluate(async()=>(await fetch('/api/config')).status)).toBe(200);
  }finally{await other.close();}
});
test('logout cancels a PDF that is still loading even when logout cannot be confirmed',async({page,admin})=>{
  await page.addInitScript(()=>{const raw=window.fetch;(window as any).__pdfAborts=0;window.fetch=(input,init)=>{if(String(input).includes('/raw/sample.pdf'))init?.signal?.addEventListener('abort',()=>{(window as any).__pdfAborts++;},{once:true});return raw(input,init);};});
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let requested=false;
  await page.route('**/raw/sample.pdf',async r=>{requested=true;await gate;await r.abort().catch(()=>{});});
  await page.goto(`${admin.origin}/knowledge`);await login(page,admin);await page.locator('.kb-tree-item').filter({hasText:'sample.pdf'}).click();await expect.poll(()=>requested).toBe(true);
  await page.route('**/api/access/logout',r=>r.abort());await page.getByTestId('admin-logout-btn').click();await page.getByTestId('admin-logout-confirm').click();await expect(page.getByTestId('admin-logout-unconfirmed')).toBeVisible();
  try{await expect.poll(()=>page.evaluate(()=>(window as any).__pdfAborts)).toBeGreaterThan(0);}finally{release();}
});
test('administrator creates and removes an isolated vault with authenticated JSON and DELETE',async({page,admin})=>{
  await page.goto(`${admin.origin}/knowledge`);await login(page,admin);await page.locator('.kb-vault-bar').first().click();await page.getByTestId('vault-create-action').click();
  const fields=page.locator('.vm-create-form input');await fields.nth(0).fill('Administrator created vault');await fields.nth(1).fill(join(admin.vaultDir,'../new-vault'));
  const created=page.waitForResponse(r=>r.url().endsWith('/api/knowledge/vaults')&&r.request().method()==='POST');await page.locator('.vm-submit-btn').click();const response=await created;expect(response.status()).toBe(201);expect((await response.request().allHeaders())['x-molio-csrf']).toMatch(/^[a-f0-9]{64}$/);
  const vault=await response.json();const row=page.locator('.vm-vault-item').filter({hasText:'Administrator created vault'});await row.hover();await row.getByTestId('vault-more-btn').click();await page.getByTestId('vault-menu-remove').click();
  const deleted=page.waitForResponse(r=>r.url().endsWith(`/api/knowledge/vaults/${vault.id}`)&&r.request().method()==='DELETE');await page.getByTestId('confirm-dialog').locator('button').last().click();expect((await deleted).ok()).toBe(true);
});
test('a rejected server follow-up is not replayed as a new task',async({page,admin})=>{
  await page.addInitScript(()=>{class FinishedTurnStream {readyState=1;onopen:any=null;onmessage:any=null;onerror:any=null;constructor(url:string){if(url.includes('/runs/'))setTimeout(()=>{this.onopen?.(new Event('open'));this.onmessage?.({data:JSON.stringify({seq:1,runId:'followup-run',event:{type:'turn_end',stopReason:'end_turn'}})});},200);}close(){this.readyState=2;}}Object.defineProperty(window,'EventSource',{value:FinishedTurnStream});});
  let creates=0;let followups=0;
  await page.route('**/api/agents',r=>r.fulfill({json:{agents:[{id:'codex',name:'Codex',available:true,binary:'/test/codex',source:'path',version:'test',models:[],installUrl:''}]}}));
  await page.route('**/api/runs',r=>{if(r.request().method()==='POST'){creates++;return r.fulfill({json:{runId:'followup-run'}});}return r.fulfill({json:{runs:[]}});});
  await page.route('**/api/runs/followup-run/messages',r=>{followups++;return r.fulfill({status:403,json:{error:{message:'Follow-up denied'}}});});
  await page.goto(`${admin.origin}/chat`);await login(page,admin);const composer=page.getByTestId('composer-input');await composer.fill('first');await composer.press('Enter');await expect.poll(()=>creates).toBe(1);
  await expect(page.getByTestId('composer-stop')).toHaveCount(0);
  await expect(page.locator('.streaming-cursor')).toHaveCount(0);
  await composer.fill('follow-up');await composer.press('Enter');await expect.poll(()=>followups).toBe(1);
  await expect(page.getByTestId('assistant-message').filter({hasText:'Follow-up denied'}).first()).toBeVisible();expect(creates).toBe(1);
});
test('between turns a paused server transport preserves the draft and blocks follow-up writes',async({page,admin})=>{
  await page.addInitScript(()=>{class TurnStream {readyState=1;onopen:any=null;onmessage:any=null;onerror:any=null;constructor(url:string){if(url.includes('/runs/')){(window as any).__failTurn=()=>{this.readyState=2;this.onerror?.(new Event('error'));};setTimeout(()=>{this.onopen?.(new Event('open'));this.onmessage?.({data:JSON.stringify({seq:1,runId:'paused-turn',event:{type:'turn_end',stopReason:'end_turn'}})});},100);}}close(){this.readyState=2;}}Object.defineProperty(window,'EventSource',{value:TurnStream});});
  let writes=0;await page.route('**/api/agents',r=>r.fulfill({json:{agents:[{id:'codex',name:'Codex',available:true,binary:'/test/codex',source:'path',version:'test',models:[],installUrl:''}]}}));await page.route('**/api/runs',r=>r.fulfill({json:r.request().method()==='POST'?{runId:'paused-turn'}:{runs:[]}}));await page.route('**/api/runs/paused-turn',r=>r.fulfill({json:{id:'paused-turn',status:'running'}}));await page.route('**/api/runs/paused-turn/messages',r=>{writes++;return r.fulfill({json:{}});});
  await page.goto(`${admin.origin}/chat`);await login(page,admin);const composer=page.getByTestId('composer-input');await composer.fill('first');await composer.press('Enter');await expect(page.getByTestId('composer-stop')).toHaveCount(0);await expect(page.locator('.streaming-cursor')).toHaveCount(0);await composer.fill('keep this draft');await page.evaluate(()=>(window as any).__failTurn());
  await expect(page.getByTestId('chat-transport-status')).toBeVisible();await expect(composer).toBeDisabled();await expect(composer).toHaveValue('keep this draft');expect(writes).toBe(0);
  await page.getByTestId('chat-transport-retry').click();await expect(composer).toBeEnabled();await composer.press('Enter');await expect.poll(()=>writes).toBe(1);
});
test('knowledge subscription exhaustion has a visible recovery action',async({page,admin})=>{
  await page.route('**/api/knowledge/vaults/*/events',r=>r.fulfill({status:204}));await page.goto(`${admin.origin}/knowledge`);await login(page,admin);
  await expect(page.getByTestId('kb-transport-status')).toHaveAttribute('data-state','paused',{timeout:25000});
  await page.unroute('**/api/knowledge/vaults/*/events');await page.getByTestId('kb-transport-retry').click();await expect(page.getByTestId('kb-transport-status')).toHaveCount(0);
});
test('pagehide masks private DOM and a persisted pageshow rechecks before restoration',async({page,admin})=>{
  await page.goto(`${admin.origin}/settings`);await login(page,admin);
  expect(await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));const shell=document.querySelector<HTMLElement>('.admin-private-shell')!;return shell.hidden&&shell.inert;})).toBe(true);
  const loaded=page.waitForEvent('load');await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await loaded;await expect(page.locator('.entry-shell')).toBeVisible();
});
test('a run completed during disconnect replays missing text before finishing',async({page,admin})=>{
  let streams=0,creates=0;
  await page.route('**/api/agents',r=>r.fulfill({json:{agents:[{id:'codex',name:'Codex',available:true,binary:'/test/codex',source:'path',version:'test',models:[],installUrl:''}]}}));
  await page.route('**/api/runs',r=>{if(r.request().method()==='POST'){creates++;return r.fulfill({json:{runId:'tail-run'}});}return r.fulfill({json:{runs:[]}});});
  await page.route('**/api/runs/tail-run',r=>r.fulfill({json:{id:'tail-run',status:'succeeded'}}));
  await page.route('**/api/runs/tail-run/events*',r=>{streams++;const frames=streams===1?[{seq:1,runId:'tail-run',event:{type:'text_delta',delta:'Visible head '}}]:[{seq:2,runId:'tail-run',event:{type:'text_delta',delta:'and recovered tail.'}},{seq:3,runId:'tail-run',event:{type:'status',label:'completed'}}];return r.fulfill({contentType:'text/event-stream',body:frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join('')});});
  await page.goto(`${admin.origin}/chat`);await login(page,admin);const composer=page.getByTestId('composer-input');await composer.fill('complete while disconnected');await composer.press('Enter');
  await expect(page.getByTestId('assistant-message')).toContainText('Visible head and recovered tail.',{timeout:15000});await expect(page.getByTestId('composer-stop')).toHaveCount(0);expect(creates).toBe(1);expect(streams).toBeGreaterThanOrEqual(2);
});
test('verified terminal replay drains an already queued intent only after recovering its final text',async({page,admin})=>{
  await page.addInitScript(()=>{class Stream {readyState=0;onopen:any=null;onmessage:any=null;onerror:any=null;constructor(url:string){setTimeout(()=>{this.readyState=1;this.onopen?.(new Event('open'));if(url.includes('final-queued'))this.onmessage?.({data:JSON.stringify({seq:1,runId:'final-queued',event:{type:'text_delta',delta:'Head '}})});},50);if(url.includes('final-queued'))(window as any).__finishQueued=()=>{this.readyState=2;this.onerror?.(new Event('error'));};}close(){this.readyState=2;}}Object.defineProperty(window,'EventSource',{value:Stream});});
  let creates=0;await page.route('**/api/agents',r=>r.fulfill({json:{agents:[{id:'codex',name:'Codex',available:true,binary:'/test/codex',source:'path',version:'test',models:[],installUrl:''}]}}));await page.route('**/api/runs',r=>{if(r.request().method()==='POST'){creates++;return r.fulfill({json:{runId:creates===1?'final-queued':'next-run'}});}return r.fulfill({json:{runs:[]}});});await page.route('**/api/runs/final-queued',r=>r.fulfill({json:{id:'final-queued',status:'succeeded'}}));await page.route('**/api/runs/final-queued/events*',r=>r.fulfill({contentType:'text/event-stream',body:[{seq:2,runId:'final-queued',event:{type:'text_delta',delta:'recovered.'}},{seq:3,runId:'final-queued',event:{type:'status',label:'completed'}}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')}));
  await page.goto(`${admin.origin}/chat`);await login(page,admin);const composer=page.getByTestId('composer-input');await composer.fill('first');await composer.press('Enter');await expect.poll(()=>creates).toBe(1);await expect(composer).toBeEnabled();await expect(page.getByTestId('assistant-message').first()).toContainText('Head ');await composer.fill('next authorized queued message');await composer.press('Enter');await page.evaluate(()=>(window as any).__finishQueued());
  await expect(page.getByTestId('assistant-message').first()).toContainText('Head recovered.');await expect.poll(()=>creates).toBe(2);
});
test('a production resource deep link survives administrator login and refresh',async({page,admin})=>{
  const url=`${admin.origin}/resources/acceptance-item?from=deep#keep`;await page.goto(url);await login(page,admin);await expect(page).toHaveURL(url);await page.reload();await expect(page.locator('.entry-shell')).toBeVisible();await expect(page.getByTestId('admin-logout-btn')).toBeVisible();await expect(page).toHaveURL(url);
});
test('local transient stream errors keep the composer usable for the next turn',async({page,adminWebDir})=>{
  const local=await startAdminServer({webDir:adminWebDir,username:'unused',password:'unused local test password',mode:'local'});
  try{await page.addInitScript(()=>{class Stream {readyState=0;onopen:any=null;onmessage:any=null;onerror:any=null;constructor(url:string){if(url.includes('/runs/'))setTimeout(()=>{this.readyState=1;this.onopen?.(new Event('open'));for(const [i,event]of [{type:'text_delta',delta:'Local first reply'},{type:'turn_end',stopReason:'end_turn'}].entries())this.onmessage?.({data:JSON.stringify({seq:i+1,runId:'local-turn',event})});this.readyState=0;this.onerror?.(new Event('error'));},50);}close(){this.readyState=2;}}Object.defineProperty(window,'EventSource',{value:Stream});});
    let writes=0;await page.route('**/api/agents',r=>r.fulfill({json:{agents:[{id:'codex',name:'Codex',available:true,binary:'/test/codex',source:'path',version:'test',models:[],installUrl:''}]}}));await page.route('**/api/runs',r=>r.fulfill({json:r.request().method()==='POST'?{runId:'local-turn'}:{runs:[]}}));await page.route('**/api/runs/local-turn/messages',r=>{writes++;return r.fulfill({json:{}});});
    await page.goto(`${local.origin}/chat`);const composer=page.getByTestId('composer-input');await composer.fill('first local intent');await composer.press('Enter');await expect(page.getByTestId('assistant-message')).toContainText('Local first reply');await expect(page.getByTestId('composer-stop')).toHaveCount(0);await expect(composer).toBeEnabled();await composer.fill('second local intent');await composer.press('Enter');await expect.poll(()=>writes).toBe(1);await expect(page.getByTestId('chat-transport-status')).toHaveCount(0);
  }finally{await local.stop();}
});
test('the multi-turn SSE fixture advances sequence numbers only for a new turn',async({page,admin})=>{
  await page.goto(`${admin.origin}/settings`);await login(page,admin);
  const {mockChatRun,unmockAll}=await import('./helpers/mock-sse');await mockChatRun(page,{runId:'sequence-check',multiTurn:true});
  try{const ranges=await page.evaluate(async()=>{const read=async()=>{const text=await(await fetch('/api/runs/sequence-check/events')).text();return text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)).seq);};const first=await read();await fetch('/api/runs/sequence-check/messages',{method:'POST',headers:{'content-type':'application/json'},body:'{"message":"next"}'});const second=await read();const replay=await read();return{first,second,replay};});
    expect(ranges.second[0]).toBe(ranges.first.at(-1)+1);expect(ranges.replay).toEqual(ranges.second);
  }finally{await unmockAll(page);}
});
