import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { geminiAgentDef } from '../../src/core/runtimes/gemini.js';

/**
 * Error-driven test: Gemini CLI runtime must emit parseable events.
 *
 * Bug: buildArgs was empty (only --model), so Gemini CLI ran in its default
 * interactive TUI mode with plain-text output. The json-event-stream parser
 * received no valid JSON and silently produced zero events — the user sees
 * "no response".
 *
 * Fix: Pass -p (headless), --output-format stream-json (JSONL events on
 * stdout), and --yolo (auto-approve tool calls — daemon has no human in
 * the loop to click "yes").
 */

describe('Gemini CLI runtime stream-json configuration', () => {
  it('should use json-event-stream as streamFormat', () => {
    assert.equal(
      geminiAgentDef.streamFormat,
      'json-event-stream',
      'streamFormat must be json-event-stream so selectParser uses createJsonEventStreamHandler',
    );
  });

  it('should use gemini as eventParser', () => {
    assert.equal(
      geminiAgentDef.eventParser,
      'gemini',
      'eventParser must be gemini so the dispatcher routes to handleGeminiEvent',
    );
  });

  it('should use promptViaStdin', () => {
    assert.equal(
      geminiAgentDef.promptViaStdin,
      true,
      'prompt must be delivered via stdin',
    );
  });

  it('should include --output-format stream-json in buildArgs', () => {
    const args = geminiAgentDef.buildArgs('test prompt', {}, {});
    const idx = args.indexOf('--output-format');
    assert.ok(idx !== -1, 'should have --output-format flag');
    assert.equal(args[idx + 1], 'stream-json');
  });

  it('should include -p flag for headless/prompt mode', () => {
    const args = geminiAgentDef.buildArgs('test prompt', {}, {});
    assert.ok(args.includes('-p'), 'should have -p flag for non-interactive (headless) mode');
  });

  it('should include --yolo for auto-approving tool calls', () => {
    const args = geminiAgentDef.buildArgs('test prompt', {}, {});
    assert.ok(args.includes('--yolo'), 'should have --yolo to auto-approve tools (daemon has no human in the loop)');
  });

  it('should add --model flag when model is specified', () => {
    const args = geminiAgentDef.buildArgs('test', { model: 'gemini-2.5-pro' }, {});
    const idx = args.indexOf('--model');
    assert.ok(idx !== -1, 'should have --model flag');
    assert.equal(args[idx + 1], 'gemini-2.5-pro');
  });

  it('should NOT add --model flag for default model', () => {
    const args = geminiAgentDef.buildArgs('test', { model: 'default' }, {});
    assert.ok(!args.includes('--model'), 'should not have --model for default');
  });
});
