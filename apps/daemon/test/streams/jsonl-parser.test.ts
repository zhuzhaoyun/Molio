import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonlParser } from '../../src/core/streams/jsonl-parser.js';

describe('JSONL Parser', () => {
  it('should parse single complete line', () => {
    const lines: string[] = [];
    const parser = createJsonlParser((line) => lines.push(line));

    parser.feed('{"type":"text","content":"hello"}\n');
    parser.flush();

    assert.equal(lines.length, 1);
    assert.equal(lines[0], '{"type":"text","content":"hello"}');
  });

  it('should handle chunked input split across lines', () => {
    const lines: string[] = [];
    const parser = createJsonlParser((line) => lines.push(line));

    parser.feed('{"type":"a"}\n{"ty');
    parser.feed('pe":"b"}\n');
    parser.flush();

    assert.equal(lines.length, 2);
    assert.equal(lines[0], '{"type":"a"}');
    assert.equal(lines[1], '{"type":"b"}');
  });

  it('should flush remaining buffer without trailing newline', () => {
    const lines: string[] = [];
    const parser = createJsonlParser((line) => lines.push(line));

    parser.feed('{"type":"a"}\n{"type":"b"}');
    assert.equal(lines.length, 1); // only first line emitted

    parser.flush();
    assert.equal(lines.length, 2); // second line emitted on flush
    assert.equal(lines[1], '{"type":"b"}');
  });

  it('should skip empty lines', () => {
    const lines: string[] = [];
    const parser = createJsonlParser((line) => lines.push(line));

    parser.feed('{"type":"a"}\n\n\n{"type":"b"}\n');
    parser.flush();

    assert.equal(lines.length, 2);
  });

  it('should handle \\r\\n line endings', () => {
    const lines: string[] = [];
    const parser = createJsonlParser((line) => lines.push(line));

    parser.feed('{"type":"a"}\r\n{"type":"b"}\r\n');
    parser.flush();

    assert.equal(lines.length, 2);
    assert.equal(lines[0], '{"type":"a"}');
    assert.equal(lines[1], '{"type":"b"}');
  });

  it('should handle Buffer input', () => {
    const lines: string[] = [];
    const parser = createJsonlParser((line) => lines.push(line));

    parser.feed(Buffer.from('{"type":"a"}\n{"type":"b"}\n'));
    parser.flush();

    assert.equal(lines.length, 2);
  });
});
