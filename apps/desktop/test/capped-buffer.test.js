/**
 * Regression tests for capped-buffer.js.
 *
 * Bug context: main.js previously collected daemon stdout/stderr into plain
 * arrays that grew without bound — after a day of runtime the Electron main
 * process held a full day of daemon log lines in memory (contributor to the
 * 3GB memory-growth report). CappedBuffer must retain only the most recent
 * N lines, in order.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CappedBuffer } from '../src/capped-buffer.js';

describe('CappedBuffer', () => {
  it('should keep all items when under capacity', () => {
    const buf = new CappedBuffer(5);
    buf.push('a');
    buf.push('b');
    assert.equal(buf.length, 2);
    assert.deepEqual(buf.toArray(), ['a', 'b']);
  });

  it('should evict oldest items once over capacity, preserving order', () => {
    const buf = new CappedBuffer(3);
    for (const line of ['a', 'b', 'c', 'd', 'e']) buf.push(line);
    assert.equal(buf.length, 3);
    assert.deepEqual(buf.toArray(), ['c', 'd', 'e']);
  });

  it('should stay bounded under sustained writes (the leak scenario)', () => {
    const buf = new CappedBuffer(200);
    for (let i = 0; i < 100_000; i++) buf.push(`daemon line ${i}`);
    assert.equal(buf.length, 200);
    const tail = buf.toArray();
    assert.equal(tail[0], 'daemon line 99800');
    assert.equal(tail[199], 'daemon line 99999');
  });

  it('should return a snapshot copy from toArray', () => {
    const buf = new CappedBuffer(3);
    buf.push('a');
    const snap = buf.toArray();
    snap.push('mutated');
    assert.deepEqual(buf.toArray(), ['a']);
  });

  it('should reject invalid capacity', () => {
    assert.throws(() => new CappedBuffer(0), /positive integer/);
    assert.throws(() => new CappedBuffer(-1), /positive integer/);
    assert.throws(() => new CappedBuffer(1.5), /positive integer/);
    assert.throws(() => new CappedBuffer('10'), /positive integer/);
  });
});
