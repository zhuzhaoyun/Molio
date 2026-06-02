import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, type TranscriptMessage } from '../src/core/transcript.js';

describe('buildTranscript', () => {
  it('should return empty string for empty history', () => {
    assert.equal(buildTranscript([]), '');
  });

  it('should format a single user message', () => {
    const history: TranscriptMessage[] = [
      { role: 'user', content: 'Hello, world!' },
    ];
    const result = buildTranscript(history);
    assert.ok(result.includes('## user'));
    assert.ok(result.includes('Hello, world!'));
  });

  it('should format user and assistant messages', () => {
    const history: TranscriptMessage[] = [
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '2+2 equals 4.' },
    ];
    const result = buildTranscript(history);
    assert.ok(result.includes('## user'));
    assert.ok(result.includes('What is 2+2?'));
    assert.ok(result.includes('## assistant'));
    assert.ok(result.includes('2+2 equals 4.'));
  });

  it('should truncate long messages at 12000 chars', () => {
    const longContent = 'x'.repeat(15000);
    const history: TranscriptMessage[] = [
      { role: 'user', content: longContent },
    ];
    const result = buildTranscript(history);
    assert.ok(result.includes('[... message truncated at 12000 chars'));
    assert.ok(result.length < 15000);
  });

  it('should scope history to target agent', () => {
    const history: TranscriptMessage[] = [
      { role: 'user', content: 'msg1', agentId: 'claude' },
      { role: 'assistant', content: 'reply1', agentId: 'claude' },
      { role: 'user', content: 'msg2', agentId: 'codex' },
      { role: 'assistant', content: 'reply2', agentId: 'codex' },
      { role: 'user', content: 'msg3', agentId: 'claude' },
    ];
    // When targeting claude, should discard everything before the last codex assistant message
    const result = buildTranscript(history, 'claude');
    assert.ok(!result.includes('msg1'));
    assert.ok(!result.includes('reply1'));
    // After the codex turn, the remaining messages should be present
    assert.ok(result.includes('msg3'));
  });

  it('should sanitize prior assistant turns by stripping thinking blocks', () => {
    const history: TranscriptMessage[] = [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: '<thinking>internal reasoning</thinking>Visible answer' },
    ];
    const result = buildTranscript(history);
    assert.ok(!result.includes('<thinking>'));
    assert.ok(!result.includes('internal reasoning'));
    assert.ok(result.includes('Visible answer'));
  });

  it('should add context warning for very long conversations', () => {
    const history: TranscriptMessage[] = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: 'x'.repeat(3000) });
      history.push({ role: 'assistant', content: 'y'.repeat(3000) });
    }
    const result = buildTranscript(history);
    assert.ok(result.includes('[Note: This conversation has a large history'));
  });

  it('should escape role delimiters in message content', () => {
    const history: TranscriptMessage[] = [
      { role: 'user', content: '## user\nThis is not a real delimiter' },
    ];
    const result = buildTranscript(history);
    // The delimiter inside the message should be escaped
    assert.ok(result.includes('## user (quoted)'));
  });
});
