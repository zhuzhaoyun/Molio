import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonFetch } from '../../src/api/http.ts';
import { fixture } from './helpers.ts';

test('all management writes receive the current CSRF while reads and FormData keep their semantics',async()=>{
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');
  const seen:RequestInit[]=[];const send=createDaemonFetch(f.controller,(async(_url,init)=>{seen.push(init!);return new Response('{}');}) as typeof fetch,'https://molio.test');
  for(const method of ['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE'])await send('/api/config',{method,headers:{'x-original':'yes'}});
  assert.deepEqual(seen.map(x=>new Headers(x.headers).get('x-molio-csrf')),[null,null,null,...Array(4).fill('a'.repeat(64))]);
  const form=new FormData();form.append('file',new Blob(['body']),'test.md');await send('/api/knowledge/upload',{method:'POST',body:form});
  assert.equal(new Headers(seen.at(-1)?.headers).has('content-type'),false);assert.equal(seen.at(-1)?.body,form);
});
test('external URLs never receive a management request or token',async()=>{
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');let count=0;
  const send=createDaemonFetch(f.controller,(async()=>{count++;return new Response();}) as typeof fetch,'https://molio.test');
  for(const url of ['https://external.test/api/config','//external.test/api/config','https://molio.test/not-api'])await assert.rejects(send(url));
  assert.equal(count,0);
});
test('business 401 and 403 preserve the original body when administrator session is still valid',async()=>{
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');let count=0;
  const send=createDaemonFetch(f.controller,(async()=>{count++;return new Response('{"error":"no_session"}',{status:401});}) as typeof fetch,'https://molio.test');
  const res=await send('/api/auth/me',{method:'POST'});assert.equal(res.status,401);assert.deepEqual(await res.json(),{error:'no_session'});assert.equal(count,1);assert.equal(f.controller.getContext()?.mode,'server');assert.deepEqual(f.retired,[]);
});
test('anonymous confirmation retires the page without retrying a failed write',async()=>{
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');f.setSession({mode:'server',authenticated:false});let count=0;
  const send=createDaemonFetch(f.controller,(async()=>{count++;return new Response('{}',{status:403});}) as typeof fetch,'https://molio.test');
  await assert.rejects(send('/api/config',{method:'PUT',body:'{}'}));assert.equal(count,1);assert.equal(f.controller.getSnapshot().status,'retiring');
});
test('terminating the session aborts an outstanding operation and rejects late successful responses',async()=>{
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');let signal:AbortSignal|undefined;let release!:(res:Response)=>void;
  const send=createDaemonFetch(f.controller,(async(_url,init)=>{signal=init?.signal??undefined;return new Promise(r=>{release=r;});}) as typeof fetch,'https://molio.test');
  const pending=send('/api/config');f.controller.getContext()!.resources.close();release(new Response('{"secret":"old"}'));
  await assert.rejects(pending);assert.equal(signal?.aborted,true);
});
test('local requests omit CSRF and caller cancellation reaches the network',async()=>{
  const f=fixture();f.setSession({mode:'local',authenticated:false});await f.controller.revalidate('startup');let signal:AbortSignal|undefined;
  const send=createDaemonFetch(f.controller,(async(_url,init)=>{signal=init?.signal??undefined;assert.equal(new Headers(init?.headers).has('x-molio-csrf'),false);return new Promise((_,reject)=>signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}) as typeof fetch,'https://molio.test');
  const abort=new AbortController();const pending=send('/api/config',{method:'PUT',signal:abort.signal});abort.abort();await assert.rejects(pending);assert.equal(signal?.aborted,true);
});
test('a business 403 is returned once, while replacement CSRF and offline checks interrupt old writes',async()=>{
  for(const scenario of ['same','replaced','offline']){
    const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');let writes=0;
    if(scenario==='replaced')f.setSession(f.authenticated('b'.repeat(64)));
    if(scenario==='offline')f.setHandler(async()=>{throw new Error('offline');});
    const send=createDaemonFetch(f.controller,(async()=>{writes++;return new Response('{"error":"business_denied"}',{status:403});}) as typeof fetch,'https://molio.test');
    if(scenario==='same')assert.deepEqual(await(await send('/api/business',{method:'DELETE'})).json(),{error:'business_denied'});
    else await assert.rejects(send('/api/business',{method:'DELETE'}));
    assert.equal(writes,1);assert.deepEqual(f.retired,scenario==='replaced'?['session-changed']:[]);
  }
});
test('management requests cannot forward CSRF through an external redirect',async()=>{
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');let redirect:RequestRedirect|undefined;
  const send=createDaemonFetch(f.controller,(async(_url,init)=>{redirect=init?.redirect;return new Response('{}');}) as typeof fetch,'https://molio.test');await send('/api/config',{method:'PUT',redirect:'follow'});assert.equal(redirect,'error');
});
