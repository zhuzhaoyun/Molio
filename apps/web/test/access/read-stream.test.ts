import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeSseData } from '../../src/api/read-stream.ts';
import { tick } from './helpers.ts';
test('session abort cancels a waiting reader, releases its lock and stops late callbacks',async()=>{
  let source!:ReadableStreamDefaultController<Uint8Array>;let cancels=0;const body=new ReadableStream<Uint8Array>({start(c){source=c;c.enqueue(new TextEncoder().encode('data: first\n\n'));},cancel(){cancels++;}});const abort=new AbortController();const seen:string[]=[];
  const pending=consumeSseData(body,abort.signal,data=>seen.push(data));const result=pending.catch(e=>e);await tick();abort.abort();await tick();const canceled=cancels;try{source.enqueue(new TextEncoder().encode('data: late\n\n'));source.close();}catch{}await result;
  assert.equal(canceled,1);assert.deepEqual(seen,['first']);assert.equal(body.locked,false);
});
test('abort from a callback stops other buffered install/preload frames',async()=>{
  const abort=new AbortController();const seen:string[]=[];const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: first\n\ndata: late\n\n'));c.close();}});
  await consumeSseData(body,abort.signal,data=>{seen.push(data);abort.abort();}).catch(()=>{});assert.deepEqual(seen,['first']);assert.equal(body.locked,false);
});
