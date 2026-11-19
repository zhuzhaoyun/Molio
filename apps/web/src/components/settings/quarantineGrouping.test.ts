import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupQuarantineEvents } from './quarantineGrouping.ts';
import type { SkillQuarantineEvent } from '@molio/contracts';

function ev(id: number, source: SkillQuarantineEvent['source']): SkillQuarantineEvent {
  return {
    id,
    source,
    mirrorName: `m${id}`,
    description: `事件${id}`,
    quarantinedPath: `/tmp/q${id}`,
    createdAt: id,
    acked: false,
  };
}

describe('groupQuarantineEvents', () => {
  it('splits cold-start events (aggregated banner) from everything else (individual rows)', () => {
    const { coldStart, individual } = groupQuarantineEvents([
      ev(1, 'vault-cold-start'),
      ev(2, 'vault-drift'),
      ev(3, 'vault-cold-start'),
      ev(4, 'hub-update'),
      ev(5, 'retired'),
      ev(6, 'orphan-sweep'),
    ]);
    assert.deepEqual(coldStart.map((e) => e.id), [1, 3]);
    assert.deepEqual(individual.map((e) => e.id), [2, 4, 5, 6]);
  });

  it('empty input → both groups empty (banner hidden)', () => {
    const { coldStart, individual } = groupQuarantineEvents([]);
    assert.equal(coldStart.length, 0);
    assert.equal(individual.length, 0);
  });
});
