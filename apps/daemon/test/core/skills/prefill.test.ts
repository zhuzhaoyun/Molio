import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parsePrefillResponse } from '../../../src/core/skills/prefill.js';

const FALLBACK_CONTENT = 'original message content';

describe('skills/prefill parsePrefillResponse', () => {
  it('parses direct JSON', () => {
    const raw = JSON.stringify({ name: '排版', description: '排版文章', instructions: '用 doocs 排版' });
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, '排版');
    assert.equal(result.description, '排版文章');
    assert.equal(result.instructions, '用 doocs 排版');
    assert.ok(!result.fallback);
  });

  it('parses JSON inside a ```json code fence', () => {
    const raw = '```json\n{"name":"A","description":"B","instructions":"C"}\n```';
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, 'A');
    assert.equal(result.instructions, 'C');
  });

  it('parses JSON inside a bare ``` code fence', () => {
    const raw = '```\n{"name":"A","description":"B","instructions":"C"}\n```';
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, 'A');
  });

  it('extracts JSON embedded in prose (first { to last })', () => {
    const raw = '好的，这是技能定义：{"name":"X","description":"Y","instructions":"Z"} 希望有用。';
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, 'X');
    assert.equal(result.instructions, 'Z');
  });

  it('falls back when JSON is malformed', () => {
    const result = parsePrefillResponse('{ this is not json', FALLBACK_CONTENT);
    assert.ok(result.fallback);
    assert.equal(result.instructions, FALLBACK_CONTENT);
    assert.equal(result.name, '未命名技能');
  });

  it('falls back on empty input', () => {
    const result = parsePrefillResponse('   ', FALLBACK_CONTENT);
    assert.ok(result.fallback);
    assert.equal(result.instructions, FALLBACK_CONTENT);
  });

  it('uses fallback instructions when the instructions field is empty', () => {
    const raw = JSON.stringify({ name: 'N', description: 'D', instructions: '' });
    const result = parsePrefillResponse(raw, FALLBACK_CONTENT);
    assert.equal(result.name, 'N');
    assert.equal(result.instructions, FALLBACK_CONTENT);
  });
});
