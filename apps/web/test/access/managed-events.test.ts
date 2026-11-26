import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createManagedEvents, createDeferredManagedEvents } from '../../src/api/managed-events.ts';
import { fixture, tick } from './helpers.ts';

class NativeStream {
  readyState=0; closes=0; onopen:((e:Event)=>void)|null=null; onmessage:((e:MessageEvent<string>)=>void)|null=null; onerror:((e:Event)=>void)|null=null;
  open(){this.readyState=1;this.onopen?.(new Event('open'));}
  fail(){this.readyState=2;this.onerror?.(new Event('error'));}
  message(data:string){this.onmessage?.({data} as MessageEvent<string>);}
  close(){this.closes++;this.readyState=2;}
}
async function setup(local=false){
  const f=fixture();f.setSession(local?{mode:'local',authenticated:false}:f.authenticated());await f.controller.revalidate('startup');
  const streams:NativeStream[]=[];const urls:string[]=[];const states:string[]=[];
  const open=createManagedEvents({controller:f.controller,schedule:f.time.schedule,createNative:url=>{urls.push(url);const stream=new NativeStream();streams.push(stream);return stream as unknown as EventSource;}});
  return {...f,streams,urls,states,open};
}
test('server errors are checked before four bounded retries, then pause instead of completing a run',async()=>{
  const f=await setup();let done=0;f.open({url:()=>'/api/runs/x/events',onMessage:()=>{},onState:s=>f.states.push(s),onLocalClosed:()=>done++});
  for(const [i,ms] of [1000,2000,4000,8000].entries()){
    f.streams.at(-1)!.open();f.streams.at(-1)!.fail();await tick();assert.equal(f.streams.length,i+1);f.time.advance(ms);await tick();assert.equal(f.streams.length,i+2);
  }
  f.streams.at(-1)!.fail();await tick();f.time.advance(60_000);await tick();assert.equal(f.streams.length,5);assert.equal(f.states.at(-1),'paused');assert.equal(done,0);
});
test('reconnect URLs use the latest received sequence and do not reset progress on open',async()=>{
  const f=await setup();let seq=0;const sub=f.open({url:()=>`/api/runs/x/events?after=${seq}`,onMessage:msg=>{seq=Number(msg.data);}});
  f.streams[0].open();f.streams[0].message('19');f.streams[0].fail();await tick();f.time.advance(1000);await tick();assert.equal(f.urls[1],'/api/runs/x/events?after=19');
  sub.close();sub.reconnect();f.time.advance(60_000);await tick();assert.equal(f.streams.length,2);
});
test('revocation cancels queued reconnection and ignores old frames',async()=>{
  const f=await setup();let delivered=0;f.open({url:()=>'/api/knowledge/x/events',onMessage:()=>delivered++});
  const old=f.streams[0];old.fail();await tick();f.setSession({mode:'server',authenticated:false});await f.controller.revalidate('peer');
  f.time.advance(10_000);old.message('late');await tick();assert.equal(f.streams.length,1);assert.equal(delivered,0);assert.equal(f.time.count(),0);
});
test('network uncertainty pauses, a confirmed recovery resumes, and an explicit close remains terminal',async()=>{
  const f=await setup();const sub=f.open({url:()=>'/api/knowledge/x/events',onMessage:()=>{},onState:s=>f.states.push(s)});
  f.setHandler(async()=>{throw new Error('offline');});f.streams[0].fail();await tick();assert.equal(f.states.at(-1),'paused');assert.deepEqual(f.retired,[]);
  f.setHandler(async()=>f.json(f.authenticated()));await f.controller.revalidate('focus');await tick();f.time.advance(1000);await tick();assert.equal(f.streams.length,2);
  sub.close();await f.controller.revalidate('focus');assert.equal(f.streams.length,2);
});
test('local native CLOSED keeps the original completion behavior',async()=>{
  const f=await setup(true);let done=0;f.open({url:()=>'/api/runs/x/events',onMessage:()=>{},onLocalClosed:()=>done++});
  f.streams[0].fail();assert.equal(done,1);
});
test('two failed subscriptions share checks without resetting either retry budget',async()=>{
  const f=await setup();const a:string[]=[],b:string[]=[];
  f.open({url:()=>'/api/runs/x/events',onMessage:()=>{},onState:s=>a.push(s)});f.open({url:()=>'/api/knowledge/x/events',onMessage:()=>{},onState:s=>b.push(s)});
  for(let i=0;i<15;i++){for(const stream of [...f.streams])stream.fail();await tick();f.time.advance(16_000);await tick();}
  assert.ok(f.streams.length<=10,`created ${f.streams.length} streams`);assert.equal(a.at(-1),'paused');assert.equal(b.at(-1),'paused');assert.equal(f.time.count(),0);
});

test('deferred creation waits through a check and reconnect can initialize a previously paused handle',async()=>{
  const f=await setup();let release!:(r:Response)=>void;f.setHandler(async()=>new Promise(r=>{release=r;}));const check=f.controller.revalidate('http-error');
  const open=createDeferredManagedEvents(async()=>f.controller,controller=>createManagedEvents({controller,schedule:f.time.schedule,createNative:()=>{const stream=new NativeStream();f.streams.push(stream);return stream as unknown as EventSource;}}));
  const sub=open({url:()=>'/api/runs/r/events',onMessage:()=>{}});await tick();assert.equal(f.streams.length,0);
  release(f.json(f.authenticated()));await check;await tick();assert.equal(f.streams.length,1);sub.reconnect();await tick();assert.equal(f.streams.length,2);sub.close();assert.ok(f.streams.every(s=>s.closes===1));
});
test('closing before deferred initialization prevents all later subscriptions',async()=>{
  const f=await setup();let resolve!:(c:typeof f.controller)=>void;let created=0;
  const open=createDeferredManagedEvents(()=>new Promise(r=>{resolve=r;}),()=>()=>{created++;return{close(){},reconnect(){}};});const sub=open({url:()=>'/api/x',onMessage:()=>{}});sub.close();resolve(f.controller);await tick();sub.reconnect();assert.equal(created,0);
});
test('a superseding peer probe is not a network recovery and cannot renew a failed stream budget',async()=>{
  const f=await setup();f.open({url:()=>'/api/runs/x/events',onMessage:()=>{},onState:s=>f.states.push(s)});
  for(let i=0;i<12;i++){f.streams.at(-1)!.fail();const peer=f.controller.revalidate('peer');await peer;await tick();f.time.advance(16_000);await tick();}
  assert.ok(f.streams.length<=5,`created ${f.streams.length} streams`);assert.equal(f.states.at(-1),'paused');
});
