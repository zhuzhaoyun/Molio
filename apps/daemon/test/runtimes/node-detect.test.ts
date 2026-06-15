import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectNode } from '../../src/core/runtimes/node-detect.js';

/**
 * Tests for Node.js / npm detection.
 * Since the test runner itself is Node.js, node should always be available.
 */
describe('detectNode', () => {
  it('should detect Node.js as available (test runner IS node)', () => {
    const result = detectNode();

    assert.equal(result.available, true, 'Node.js should be available since tests run on Node');
    assert.ok(result.binary, 'binary path should be set');
    assert.ok(result.version, 'version should be detected');
    assert.match(result.version!, /^v\d+\.\d+\.\d+/, 'version should match semver pattern');
  });

  it('should detect npm as available', () => {
    const result = detectNode();

    // npm ships with Node.js, so it should be available
    assert.equal(result.npmAvailable, true, 'npm should be available');
    assert.ok(result.npmBinary, 'npm binary path should be set');
  });

  it('should return consistent binary paths', () => {
    const result = detectNode();

    if (result.binary) {
      // Binary should be a plausible path
      assert.ok(result.binary.length > 0, 'binary path should not be empty');
    }
    if (result.npmBinary) {
      assert.ok(result.npmBinary.length > 0, 'npm binary path should not be empty');
    }
  });
});
