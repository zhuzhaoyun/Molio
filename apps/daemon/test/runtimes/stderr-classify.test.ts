import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStderrChunk } from '../../src/core/runtimes/stderr.js';

/**
 * Error-driven test: Claude Code print-mode stderr diagnostics must not be
 * surfaced as UI errors.
 *
 * Customer report: configuring DeepSeek as the Claude Code provider made
 * every run show the error
 *   [claude-code:unrecognized_model] {"model":"deepseek-v4-pro","query_source":"sdk"}
 * while the same setup worked fine in the user's own cmd.
 *
 * Root cause: Claude Code >= 2.1.233 writes `[claude-code:*]` diagnostics to
 * stderr in print mode (`-p`). `unrecognized_model` fires on every request
 * whose model id isn't a built-in Anthropic id — always the case for
 * third-party providers. The request still goes out; the line is purely
 * informational. Molio's stderr handler emitted it as an `error` event, and
 * the frontend flips the assistant message to streaming:false on error —
 * discarding the real reply that followed.
 *
 * Fix: classifyStderrChunk demotes `[claude-code:*]` lines to `raw` events
 * (logged to events.jsonl, ignored by the UI) while keeping genuine error
 * lines as `error` events.
 */

const CUSTOMER_LINE =
  '[claude-code:unrecognized_model] {"model":"deepseek-v4-pro","query_source":"sdk"}';

describe('classifyStderrChunk — claude diagnostics', () => {
  it('reproduces the customer report: unrecognized_model line is NOT an error event', () => {
    const events = classifyStderrChunk('claude', CUSTOMER_LINE + '\n');
    assert.ok(events.length > 0, 'diagnostic should still be persisted as raw');
    for (const ev of events) {
      assert.notEqual(ev.type, 'error', `must not emit error for: ${CUSTOMER_LINE}`);
    }
    assert.deepEqual(events, [{ type: 'raw', line: CUSTOMER_LINE }]);
  });

  it('demotes any [claude-code:*] marker line, not just unrecognized_model', () => {
    const events = classifyStderrChunk('claude', '[claude-code:some_future_kind] details\n');
    assert.deepEqual(events, [{ type: 'raw', line: '[claude-code:some_future_kind] details' }]);
  });

  it('keeps genuine error lines in a mixed chunk as an error event', () => {
    const chunk = `${CUSTOMER_LINE}\nAPI Error: 401 invalid api key\n`;
    const events = classifyStderrChunk('claude', chunk);
    const raws = events.filter((e) => e.type === 'raw');
    const errors = events.filter((e) => e.type === 'error');
    assert.equal(raws.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.type === 'error' && errors[0]!.message, 'API Error: 401 invalid api key');
  });

  it('does not over-filter: marker mentioned mid-line is still an error', () => {
    const events = classifyStderrChunk('claude', 'Failed, see [claude-code:docs] for help\n');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'error');
  });

  it('plain claude stderr without the marker stays an error event', () => {
    const events = classifyStderrChunk('claude', 'Something actually broke\n');
    assert.deepEqual(events, [{ type: 'error', message: 'Something actually broke' }]);
  });

  it('only claude gets the diagnostic demotion — other agents keep error behavior', () => {
    for (const agentId of ['gemini', 'qwen', 'codex', 'unknown']) {
      const events = classifyStderrChunk(agentId, CUSTOMER_LINE + '\n');
      assert.equal(events.length, 1, `agent ${agentId}`);
      assert.equal(events[0]!.type, 'error', `agent ${agentId}`);
    }
  });
});

/**
 * Error-driven test: Gemini CLI 0.57.0 headless startup banners must not be
 * surfaced as UI errors.
 *
 * Customer report: after installing Gemini CLI 0.57.0 and picking it as the
 * default agent, every run showed a red error banner quoting
 *   YOLO mode is enabled. All tool calls will be automatically approved.
 *   Ripgrep is not available. Falling back to GrepTool.
 *   Skill "skill-creator" from "..." is overriding the built-in skill.
 * even though the run itself completed successfully (reply + usage + turn_end
 * all present in events.jsonl).
 *
 * Root cause: Gemini CLI 0.57.0 prints these informational startup banners to
 * stderr on every headless run (the YOLO notice twice — once per --yolo and
 * once per --skip-trust). classifyStderrChunk had no gemini rule, so the
 * whole chunk became one `error` event; the frontend shows a red banner and
 * flips streaming:false, making a successful run look failed.
 *
 * Fix: gemini branch demotes the known banner lines to `raw` events while
 * keeping genuine error lines as `error` events.
 */
const GEMINI_STARTUP_CHUNK = [
  'YOLO mode is enabled. All tool calls will be automatically approved.',
  'YOLO mode is enabled. All tool calls will be automatically approved.',
  'Ripgrep is not available. Falling back to GrepTool.',
  'Skill "skill-creator" from "C:\\Users\\dluty\\.agents\\skills\\skill-creator\\SKILL.md" is overriding the built-in skill.',
].join('\n');

describe('classifyStderrChunk — gemini startup banners', () => {
  it('reproduces the customer report: 0.57.0 startup chunk emits no error event', () => {
    const events = classifyStderrChunk('gemini', GEMINI_STARTUP_CHUNK + '\n');
    assert.ok(events.length > 0, 'banners should still be persisted as raw');
    for (const ev of events) {
      assert.notEqual(ev.type, 'error', `must not emit error for: ${JSON.stringify(ev)}`);
    }
    assert.equal(events.filter((e) => e.type === 'raw').length, 4);
  });

  it('demotes each banner line individually', () => {
    assert.deepEqual(
      classifyStderrChunk('gemini', 'YOLO mode is enabled. All tool calls will be automatically approved.\n'),
      [{ type: 'raw', line: 'YOLO mode is enabled. All tool calls will be automatically approved.' }],
    );
    assert.deepEqual(
      classifyStderrChunk('gemini', 'Ripgrep is not available. Falling back to GrepTool.\n'),
      [{ type: 'raw', line: 'Ripgrep is not available. Falling back to GrepTool.' }],
    );
    assert.deepEqual(
      classifyStderrChunk('gemini', 'Skill "x" from "C:\\a\\b" is overriding the built-in skill.\n'),
      [{ type: 'raw', line: 'Skill "x" from "C:\\a\\b" is overriding the built-in skill.' }],
    );
  });

  it('keeps genuine error lines in a mixed chunk as an error event', () => {
    const chunk = `Ripgrep is not available. Falling back to GrepTool.\nAPI key not found. Please run gemini auth.\n`;
    const events = classifyStderrChunk('gemini', chunk);
    const raws = events.filter((e) => e.type === 'raw');
    const errors = events.filter((e) => e.type === 'error');
    assert.equal(raws.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.type === 'error' && errors[0]!.message, 'API key not found. Please run gemini auth.');
  });

  it('trust-degradation warning stays an error (yolo silently disabled)', () => {
    const line = 'Approval mode overridden to "default" because the current folder is not trusted.';
    const events = classifyStderrChunk('gemini', line + '\n');
    assert.deepEqual(events, [{ type: 'error', message: line }]);
  });

  it('demotes any Warning: line to raw (broad match, not per-message whitelist)', () => {
    const real = 'Warning: True color (24-bit) support not detected. Using a terminal with true color enabled will result in a better visual experience.';
    assert.deepEqual(
      classifyStderrChunk('gemini', real + '\n'),
      [{ type: 'raw', line: real }],
    );
    // hypothetical future warning — must not break the UI
    const future = 'Warning: Some new terminal compatibility issue detected.';
    assert.deepEqual(
      classifyStderrChunk('gemini', future + '\n'),
      [{ type: 'raw', line: future }],
    );
  });

  it('plain gemini stderr without known banners stays an error event', () => {
    const events = classifyStderrChunk('gemini', 'Something actually broke\n');
    assert.deepEqual(events, [{ type: 'error', message: 'Something actually broke' }]);
  });
});

describe('classifyStderrChunk — existing behavior preserved', () => {
  it('codex informational stderr is demoted to raw, not dropped', () => {
    assert.deepEqual(
      classifyStderrChunk('codex', 'Reading prompt from stdin...\n'),
      [{ type: 'raw', line: 'Reading prompt from stdin...' }],
    );
    assert.deepEqual(
      classifyStderrChunk('codex', 'Reading additional input from stdin...\n'),
      [{ type: 'raw', line: 'Reading additional input from stdin...' }],
    );
  });

  it('known codex info lines do not hide real errors in the same chunk', () => {
    const chunk = 'Reading prompt from stdin...\nmodel not found\n';
    const events = classifyStderrChunk('codex', chunk);
    const raws = events.filter((e) => e.type === 'raw');
    const errors = events.filter((e) => e.type === 'error');
    assert.equal(raws.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.type === 'error' && errors[0]!.message, 'model not found');
  });

  it('codex Warning: lines are demoted to raw', () => {
    const line = 'Warning: Some terminal compatibility issue.';
    assert.deepEqual(
      classifyStderrChunk('codex', line + '\n'),
      [{ type: 'raw', line }],
    );
  });

  it('codex real errors still surface', () => {
    const events = classifyStderrChunk('codex', 'model not found\n');
    assert.deepEqual(events, [{ type: 'error', message: 'model not found' }]);
  });

  it('empty / whitespace-only chunks produce no events', () => {
    assert.deepEqual(classifyStderrChunk('claude', ''), []);
    assert.deepEqual(classifyStderrChunk('claude', '  \n\t '), []);
  });
});
