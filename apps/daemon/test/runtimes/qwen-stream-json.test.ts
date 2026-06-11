import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { qwenAgentDef } from '../../src/core/runtimes/qwen.js';

/**
 * Error-driven test: Qwen Code runtime must use stream-json protocol.
 *
 * Bug: streamFormat was 'plain', which routes stdout through createJsonlParser
 * emitting { type: 'raw', line } events. The frontend updateWithEvent() does
 * not handle 'raw' events (falls to default: return msg), so all Qwen output
 * was silently dropped — the user sees "no response".
 *
 * Fix: Use --output-format stream-json (Qwen Code v0.3.0+) which produces
 * Claude-compatible events (message_start, content_block_delta, etc.),
 * parsed by createClaudeStreamHandler.
 */

describe('Qwen Code runtime stream-json configuration', () => {
  it('should use claude-stream-json as streamFormat', () => {
    assert.equal(
      qwenAgentDef.streamFormat,
      'claude-stream-json',
      'streamFormat must be claude-stream-json so selectParser uses createClaudeStreamHandler',
    );
  });

  it('should use stream-json as promptInputFormat', () => {
    assert.equal(
      qwenAgentDef.promptInputFormat,
      'stream-json',
      'promptInputFormat must be stream-json for Pattern A (JSON stdin, multi-turn)',
    );
  });

  it('should enable multiTurn for interactive conversations', () => {
    assert.equal(
      qwenAgentDef.multiTurn,
      true,
      'multiTurn must be true so stdin stays open between turns',
    );
  });

  it('should include --output-format stream-json in buildArgs', () => {
    const args = qwenAgentDef.buildArgs('test prompt', {}, {});
    const idx = args.indexOf('--output-format');
    assert.ok(idx !== -1, 'should have --output-format flag');
    assert.equal(args[idx + 1], 'stream-json');
  });

  it('should include --input-format stream-json in buildArgs', () => {
    const args = qwenAgentDef.buildArgs('test prompt', {}, {});
    const idx = args.indexOf('--input-format');
    assert.ok(idx !== -1, 'should have --input-format flag');
    assert.equal(args[idx + 1], 'stream-json');
  });

  it('should include -p flag for headless/prompt mode', () => {
    const args = qwenAgentDef.buildArgs('test prompt', {}, {});
    assert.ok(args.includes('-p'), 'should have -p flag for non-interactive mode');
  });

  it('should include --verbose flag', () => {
    const args = qwenAgentDef.buildArgs('test prompt', {}, {});
    assert.ok(args.includes('--verbose'), 'should have --verbose flag');
  });

  it('should add --model flag when model is specified', () => {
    const args = qwenAgentDef.buildArgs('test', { model: 'qwen-max' }, {});
    const idx = args.indexOf('--model');
    assert.ok(idx !== -1, 'should have --model flag');
    assert.equal(args[idx + 1], 'qwen-max');
  });

  it('should NOT add --model flag for default model', () => {
    const args = qwenAgentDef.buildArgs('test', { model: 'default' }, {});
    assert.ok(!args.includes('--model'), 'should not have --model for default');
  });
});
