import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionResources } from '../../src/access/resources.ts';

test('terminating a scope cancels producers once and immediately disposes late producers', () => {
  const scope = createSessionResources(1); let disposed = 0;
  scope.track(() => disposed++);
  const unregister = scope.track(() => disposed += 100); unregister();
  scope.close(); scope.close();
  assert.equal(scope.signal.aborted, true); assert.equal(scope.closed, true); assert.equal(disposed, 1);
  scope.track(() => disposed++); assert.equal(disposed, 2);
});
