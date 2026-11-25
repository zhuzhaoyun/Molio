import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunSubscriber } from '../../src/api/run-events.ts';
import type { ManagedEventsOptions } from '../../src/api/managed-events.ts';
import { fixture, tick } from './helpers.ts';
test('a terminal run is not completed until all missed text has been replayed to EOF',async()=>{
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');let options!:ManagedEventsOptions;let closed=0,done=0;let finish!:(()=>void);let replayed=false;const texts:string[]=[];
  const subscribe=createRunSubscriber({getContext:f.controller.getContext,open:o=>{options=o;return{close(){closed++;},reconnect(){}};},getRun:async()=>({id:'r',agentId:'a',status:'succeeded',createdAt:0,lastStopReason:null,conversationId:null}),replay:async(_id,after,onMessage)=>{assert.equal(after,1);replayed=true;onMessage({data:JSON.stringify({seq:2,runId:'r',event:{type:'text_delta',delta:'tail'}})} as MessageEvent<string>);await new Promise<void>(r=>{finish=r;});}});
  subscribe('r',e=>{if(e.type==='text_delta')texts.push(e.delta);},undefined,()=>done++);
  options.onMessage({data:JSON.stringify({seq:1,runId:'r',event:{type:'text_delta',delta:'head'}})} as MessageEvent<string>);options.onError?.(new Event('error'));await tick();
  assert.equal(closed,0);assert.equal(done,0);assert.equal(replayed,true);assert.deepEqual(texts,['head','tail']);finish();await tick();assert.equal(done,1);assert.equal(closed,1);
});
test('closing an observation aborts its in-flight finite replay and cannot finish later',async()=>{
  const f=fixture();f.setSession(f.authenticated());await f.controller.revalidate('startup');let options!:ManagedEventsOptions;let finish!:()=>void;let signal:AbortSignal|undefined;let done=0;
  const subscribe=createRunSubscriber({getContext:f.controller.getContext,open:o=>{options=o;return{close(){},reconnect(){}};},getRun:async()=>({id:'r',agentId:'a',status:'succeeded',createdAt:0,lastStopReason:null,conversationId:null}),replay:async(_id,_after,_onMessage,currentSignal)=>{signal=currentSignal;await new Promise<void>(r=>{finish=r;});}});
  const sub=subscribe('r',()=>{},undefined,()=>done++);options.onError?.(new Event('error'));await tick();sub.close();const aborted=signal?.aborted;finish();await tick();assert.equal(aborted,true);assert.equal(done,0);
});
