/** sse-parser 单测：跨 chunk 半帧、单 chunk 多帧、CRLF、ping 跳过、UTF-8 多字节切分、关流。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SSEEnvelope } from '@molio/contracts';
import { createFrameSplitter, parseFrame, parseSseStream } from '../src/sse-parser.js';

function envelope(seq: number, delta: string): SSEEnvelope {
  return { seq, runId: 'r1', event: { type: 'text_delta', delta } };
}

function frame(seq: number, delta: string): string {
  return `id: ${seq}\ndata: ${JSON.stringify(envelope(seq, delta))}\n\n`;
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

const enc = new TextEncoder();

test('splitter: 单 chunk 多帧', () => {
  const s = createFrameSplitter();
  const frames = s.feed(frame(1, 'a') + frame(2, 'b'));
  assert.equal(frames.length, 2);
  assert.equal(s.flush(), null);
});

test('splitter: 帧跨 chunk 切断', () => {
  const s = createFrameSplitter();
  const raw = frame(1, 'hello');
  const cut = Math.floor(raw.length / 2);
  assert.deepEqual(s.feed(raw.slice(0, cut)), []);
  const frames = s.feed(raw.slice(cut));
  assert.equal(frames.length, 1);
  assert.equal(parseFrame(frames[0]!)?.event.type, 'text_delta');
});

test('splitter: CRLF 行尾归一化', () => {
  const s = createFrameSplitter();
  const crlf = frame(1, 'x').replace(/\n/g, '\r\n');
  const frames = s.feed(crlf);
  assert.equal(frames.length, 1);
  assert.equal(parseFrame(frames[0]!)?.seq, 1);
});

test('splitter: chunk 末尾孤立 \\r 挂起（可能是下个 chunk 的 \\r\\n 前半）', () => {
  const s = createFrameSplitter();
  assert.deepEqual(s.feed('data: ping\r'), []);
  const frames = s.feed('\n\r\n');
  assert.equal(frames.length, 1); // ping 帧完整切出（parseFrame 会跳过它）
  assert.equal(parseFrame(frames[0]!), null);
});

test('splitter: flush 取出无结尾空行的残留帧', () => {
  const s = createFrameSplitter();
  assert.deepEqual(s.feed('data: {"seq":9,"runId":"r","event":{"type":"result"}}'), []);
  const rest = s.flush();
  assert.ok(rest);
  assert.equal(parseFrame(rest)?.seq, 9);
});

test('parseFrame: ping / 非 JSON / 缺 event 均返回 null', () => {
  assert.equal(parseFrame('data: ping'), null);
  assert.equal(parseFrame('data: {broken json'), null);
  assert.equal(parseFrame('data: {"seq":1,"runId":"r"}'), null);
  assert.equal(parseFrame('id: 1'), null);
});

test('parseFrame: 多行 data 按 SSE 规范以 \\n 拼接', () => {
  // 在 JSON 合法空白处（字段间）拆成两行 data:，拼接后仍是合法 JSON
  const payload = JSON.stringify(envelope(3, 'z'));
  const cut = payload.indexOf(',') + 1;
  const parsed = parseFrame(`data: ${payload.slice(0, cut)}\ndata: ${payload.slice(cut)}`);
  assert.equal(parsed?.seq, 3);
  assert.equal((parsed?.event as { delta?: string }).delta, 'z');
});

test('parseSseStream: 真实帧序列 + ping 跳过 + 关流结束', async () => {
  const chunks = [
    enc.encode('data: ping\n\n' + frame(1, '你')),
    enc.encode(frame(2, '好')),
    enc.encode('data: ping\n\n'),
  ];
  const out: SSEEnvelope[] = [];
  for await (const e of parseSseStream(streamFrom(chunks))) out.push(e);
  assert.deepEqual(
    out.map((e) => e.seq),
    [1, 2],
  );
  assert.equal((out[0]!.event as { delta?: string }).delta, '你');
});

test('parseSseStream: UTF-8 多字节字符跨 chunk 切断', async () => {
  const raw = frame(1, '你好世界');
  const bytes = enc.encode(raw);
  // 在「你」的 3 字节序列中间切开
  const prefixLen = enc.encode(raw.slice(0, raw.indexOf('你'))).length;
  const chunks = [bytes.slice(0, prefixLen + 1), bytes.slice(prefixLen + 1)];
  const out: SSEEnvelope[] = [];
  for await (const e of parseSseStream(streamFrom(chunks))) out.push(e);
  assert.equal(out.length, 1);
  assert.equal((out[0]!.event as { delta?: string }).delta, '你好世界');
});

test('parseSseStream: 空流直接结束', async () => {
  const out: SSEEnvelope[] = [];
  for await (const e of parseSseStream(streamFrom([]))) out.push(e);
  assert.equal(out.length, 0);
});
