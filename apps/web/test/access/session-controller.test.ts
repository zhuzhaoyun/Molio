import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick } from './helpers.ts';

test('discovery never guesses local from unreachable or malformed server responses', async () => {
  const f = fixture(); f.setHandler(async () => { throw new Error('offline'); });
  await f.controller.revalidate('startup'); assert.equal(f.controller.getSnapshot().status, 'unavailable'); assert.equal(f.controller.getContext(), null);
  f.setHandler(async () => f.json({ mode: 'server', authenticated: true }));
  await f.controller.revalidate('startup'); assert.equal(f.controller.getSnapshot().status, 'unavailable');
  f.setHandler(async () => f.json({ mode: 'local', authenticated: false }));
  await f.controller.revalidate('startup'); assert.equal(f.controller.getContext()?.mode, 'local');
  await assert.rejects(f.controller.login({ username: 'admin', password: 'secret' }));
  assert.equal(f.calls.some(x => x.url.endsWith('/login')), false);
});
test('login authorizes only after session confirmation and does not keep the password', async () => {
  const f = fixture(); await f.controller.revalidate('startup');
  f.setSession(f.authenticated()); await f.controller.login({ username: 'admin', password: 'temporary password' });
  assert.equal(f.controller.getContext()?.mode, 'server'); assert.equal(JSON.stringify(f.controller.getSnapshot()).includes('temporary password'), false);
  assert.deepEqual(f.calls.slice(-2).map(x => new URL(x.url).pathname), ['/api/access/login','/api/access/session']);
});
test('session replacement retires old actions instead of adopting a new CSRF', async () => {
  const f = fixture(); f.setSession(f.authenticated()); await f.controller.revalidate('startup');
  const old = f.controller.getContext()!;
  f.setSession(f.authenticated('b'.repeat(64))); await f.controller.revalidate('http-error');
  assert.equal(old.resources.closed, true); assert.deepEqual(f.retired, ['session-changed']); assert.equal(f.controller.getContext(), null);
});
test('a lost logout response stays unconfirmed until the server reports anonymous', async () => {
  const f = fixture(); f.setSession(f.authenticated()); await f.controller.revalidate('startup');
  f.setHandler(async url => { if (url.endsWith('/logout')) throw new Error('response lost'); return f.json(f.authenticated()); });
  await f.controller.logout(); assert.equal(f.controller.getSnapshot().status, 'logging-out'); assert.deepEqual(f.retired, []);
  await f.controller.resumeAfterFailedLogout(); assert.equal(f.controller.getContext()?.mode, 'server');
  f.setHandler(async url => url.endsWith('/logout') ? new Response(null, { status: 204 }) : f.json({ mode: 'server', authenticated: false }));
  await f.controller.logout(); assert.deepEqual(f.retired, ['signed-out']);
});
test('logout with an old CSRF never retries against a replacement session', async () => {
  const f=fixture(); f.setSession(f.authenticated()); await f.controller.revalidate('startup');
  f.setHandler(async url => url.endsWith('/logout') ? f.json({ error: 'forbidden' },403) : f.json(f.authenticated('b'.repeat(64))));
  await f.controller.logout(); assert.deepEqual(f.retired,['session-changed']); assert.equal(f.calls.filter(x=>x.url.endsWith('/logout')).length,1);
});
test('network errors pause authenticated operations without pretending to sign out', async () => {
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');
  f.setHandler(async()=>{throw new Error('offline');});await f.controller.revalidate('http-error');
  const s=f.controller.getSnapshot();assert.equal(s.status,'authenticated');assert.equal(f.controller.getContext(),null);assert.deepEqual(f.retired,[]);
  f.setHandler(async()=>f.json(f.authenticated()));await f.controller.revalidate('focus');assert.equal(f.controller.getContext()?.mode,'server');
});
test('deduplicated checks time out, abort the request and permit recovery', async () => {
  const f=fixture();let signal:AbortSignal|undefined;f.setHandler(async(_url,init)=>{signal=init?.signal ?? undefined;return new Promise(()=>{});});
  const a=f.controller.revalidate('startup');const b=f.controller.revalidate('focus');assert.equal(f.calls.length,1);
  f.time.advance(5000);await Promise.all([a,b]);assert.equal(signal?.aborted,true);assert.equal(f.controller.getSnapshot().status,'unavailable');
  f.setHandler(async()=>f.json({mode:'local',authenticated:false}));await f.controller.revalidate('startup');assert.equal(f.controller.getContext()?.mode,'local');
});
test('late successful session checks cannot resurrect a completed logout', async () => {
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');
  let release!:(r:Response)=>void;f.setHandler(async url=>url.endsWith('/session')?new Promise(r=>{release=r;}):new Response(null,{status:204}));
  const old=f.controller.revalidate('poll');await f.controller.logout();release(f.json(f.authenticated()));await old;
  assert.equal(f.controller.getSnapshot().status,'retiring');assert.equal(f.retired.length,1);
});
test('a polling host cleans up every scheduled callback on stop', async () => {
  const f=fixture();f.setSession(f.authenticated());const stop=f.controller.start();await tick();
  f.time.advance(30_000);await tick();assert.equal(f.calls.length,2);
  stop();assert.equal(f.time.count(),0);
});
test('expiry warns before the deadline and retires only after anonymous confirmation', async () => {
  const f=fixture();f.setSession({...f.authenticated(),expiresAt:f.time.now()+301_000});
  const stop=f.controller.start();await tick();f.time.advance(1000);await tick();
  const s=f.controller.getSnapshot();assert.equal(s.status==='authenticated'&&s.expiresSoon,true);
  f.setSession({mode:'server',authenticated:false});f.time.advance(300_000);await tick();
  assert.equal(f.controller.getSnapshot().status,'retiring');assert.equal(f.retired.length,1);stop();assert.equal(f.time.count(),0);
});
test('a browser clock ahead of the server does not by itself expire the session', async () => {
  const f=fixture();const serverTime=f.time.now();const data={...f.authenticated(),expiresAt:serverTime+120_000};
  f.time.advance(600_000);f.setHandler(async()=>new Response(JSON.stringify(data),{headers:{Date:new Date(serverTime).toUTCString()}}));
  const stop=f.controller.start();await tick();assert.equal(f.controller.getContext()?.mode,'server');assert.deepEqual(f.retired,[]);stop();
});
test('login rate limiting exposes a retry deadline without exposing submitted data', async () => {
  const f=fixture();await f.controller.revalidate('startup');f.setHandler(async()=>f.json({error:'rate_limited'},429,{'Retry-After':'60'}));
  await assert.rejects(f.controller.login({username:'admin',password:'secret'}),(err:any)=>err.code==='rate_limited'&&err.retryAt===f.time.now()+60_000&&!JSON.stringify(err).includes('secret'));
});
test('HTTP-date Retry-After is parsed without retaining login input',async()=>{
  const f=fixture();await f.controller.revalidate('startup');const retryAt=f.time.now()+60_000;
  f.setHandler(async()=>f.json({error:'rate_limited'},429,{'Retry-After':new Date(retryAt).toUTCString()}));
  await assert.rejects(f.controller.login({username:'admin',password:'ephemeral'}),(err:any)=>err.retryAt===retryAt&&!JSON.stringify(err).includes('ephemeral'));
});
test('a peer notice supersedes a pending poll instead of adopting the pre-notice cookie response',async()=>{
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');let release!:(r:Response)=>void;let oldSignal:AbortSignal|undefined;let checks=0;
  f.setHandler(async(_url,init)=>{checks++;if(checks===1){oldSignal=init?.signal??undefined;return new Promise(r=>{release=r;});}return f.json(f.authenticated('b'.repeat(64)));});
  const old=f.controller.revalidate('poll');const peer=f.controller.revalidate('peer');
  assert.equal(f.controller.getContext(),null);release(f.json(f.authenticated()));await Promise.all([old,peer]);
  assert.equal(oldSignal?.aborted,true);assert.equal(checks,2);assert.deepEqual(f.retired,['session-changed']);
});
test('login confirmation cannot reuse a focus probe that began before the login response',async()=>{
  const f=fixture();await f.controller.revalidate('startup');let releasePost!:(r:Response)=>void;let releaseOld!:(r:Response)=>void;let oldSignal:AbortSignal|undefined;let checks=0;
  f.setHandler(async(url,init)=>{if(url.endsWith('/login'))return new Promise(r=>{releasePost=r;});checks++;if(checks===1){oldSignal=init?.signal??undefined;return new Promise(r=>{releaseOld=r;});}return f.json(f.authenticated());});
  const login=f.controller.login({username:'admin',password:'temporary'});const result=login.catch(e=>e);
  const old=f.controller.revalidate('focus');releasePost(f.json({authenticated:true}));await tick();
  const canceled=oldSignal?.aborted;releaseOld(f.json({mode:'server',authenticated:false}));await old;const error=await result;
  assert.equal(canceled,true);assert.equal(error,undefined);assert.equal(checks,2);assert.equal(f.controller.getContext()?.mode,'server');
});
