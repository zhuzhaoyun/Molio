import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './helpers.ts';
test('runtime start stop start owns one listener set and masks persisted pages before reload',async()=>{
  class Target extends EventTarget { active=new Map<string,Set<unknown>>();get listeners(){return [...this.active.values()].reduce((n,s)=>n+s.size,0);}override addEventListener(type:string,callback:any,options?:any){const entries=this.active.get(type)??new Set();entries.add(callback);this.active.set(type,entries);super.addEventListener(type,callback,options);}override removeEventListener(type:string,callback:any,options?:any){const entries=this.active.get(type);entries?.delete(callback);if(!entries?.size)this.active.delete(type);super.removeEventListener(type,callback,options);} }
  const windowTarget=new Target(),documentTarget=new Target();const shell={hidden:false,inert:false};let created=0,closed=0,reloads=0;
  class Channel {onmessage:any;constructor(_name:string){created++;}postMessage(){}close(){closed++;}}
  const location={origin:'https://molio.test',pathname:'/settings',search:'',hash:'',reload(){reloads++;},replace(){}};
  Object.assign(windowTarget,{location});Object.assign(documentTarget,{visibilityState:'visible',querySelector:()=>shell});
  const values:Record<string,unknown>={window:windowTarget,document:documentTarget,location,BroadcastChannel:Channel,fetch:async()=>new Response('{"mode":"local","authenticated":false}'),sessionStorage:{setItem(){}},localStorage:{setItem(){},removeItem(){}}};
  const originals=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  try{const runtime=await import('../../src/access/runtime.ts');const a=runtime.startAccessRuntime(),b=runtime.startAccessRuntime();await tick();assert.equal(created,1);assert.equal(windowTarget.listeners,4);a();assert.equal(closed,0);b();assert.equal(closed,1);assert.equal(windowTarget.listeners,0);assert.equal(documentTarget.listeners,0);
    const c=runtime.startAccessRuntime();assert.equal(created,2);windowTarget.dispatchEvent(new Event('pagehide'));assert.deepEqual(shell,{hidden:true,inert:true});const event=new Event('pageshow');Object.defineProperty(event,'persisted',{value:true});windowTarget.dispatchEvent(event);assert.equal(reloads,1);c();assert.equal(closed,2);assert.equal(windowTarget.listeners,0);assert.equal(documentTarget.listeners,0);
  }finally{for(const [key,descriptor]of originals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete(globalThis as any)[key];}
});
