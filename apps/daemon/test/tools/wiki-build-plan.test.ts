import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { makePlanFixture, makeScannedTwoFileVault, runPlan, runWikiBuildCli } from './wiki-build-test-helpers.js';

function runPlanStatus(vaultPath: string) {
  return runWikiBuildCli(vaultPath, ['status', '--json']);
}

describe('wiki-build plan', () => {
  it('accepts unrelated single-file leaf topics', () => {
    const fixture = makeScannedTwoFileVault();
    const candidate = makePlanFixture(fixture.inventoryDigest);
    const result = runPlan(fixture.vault, candidate, 'validate');
    assert.equal(result.status, 0);
    assert.equal(result.json.data.topicCounts.leaf, 2);
    assert.equal(existsSync(join(fixture.vault, 'wiki')), false);
    fixture.cleanup();
  });

  it('writes validation output only to the draft plan', () => {
    const fixture = makeScannedTwoFileVault();
    const result = runPlan(fixture.vault, makePlanFixture(fixture.inventoryDigest), 'validate');
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(fixture.vault, '.molio', 'wiki-build', 'plan-draft.json')), true);
    assert.equal(existsSync(join(fixture.vault, '.molio', 'wiki-build', 'plan.json')), false);
    assert.deepEqual(runPlanStatus(fixture.vault).json.data, { phase: 'draft' });
    fixture.cleanup();
  });

  it('rejects a one-child branch and capacity split below the limit', () => {
    const fixture = makeScannedTwoFileVault();
    const candidate = makePlanFixture(fixture.inventoryDigest);
    candidate.topics = [{
      id: 'root-child', name: '多余层级', slug: '多余层级', kind: 'branch', depth: 1,
      splitReason: 'capacity', estimatedPages: 2, estimatedIndexTokens: 80,
      children: [candidate.topics[0]],
    }];
    const result = runPlan(fixture.vault, candidate, 'validate');
    assert.equal(result.status, 2);
    assert.deepEqual(result.json.error.details.codes, [
      'BRANCH_REQUIRES_TWO_CHILDREN', 'CAPACITY_SPLIT_BELOW_LIMIT',
    ]);
    fixture.cleanup();
  });

  it('rejects a branch that declares fileIds even when it is empty', () => {
    const fixture = makeScannedTwoFileVault();
    const candidate = makePlanFixture(fixture.inventoryDigest);
    candidate.topics = [{
      id: 'semantic-root', name: '知识', slug: '知识', kind: 'branch', depth: 1,
      splitReason: 'semantic', estimatedPages: 2, estimatedIndexTokens: 80, fileIds: [],
      children: candidate.topics.map((topic: any) => ({ ...topic, depth: 2 })),
    }];
    const result = runPlan(fixture.vault, candidate, 'validate');
    assert.equal(result.status, 2);
    assert.ok(result.json.error.details.codes.includes('BRANCH_HAS_FILE_IDS'));
    fixture.cleanup();
  });

  it('freezes an approved version and rejects an in-place overwrite', () => {
    const fixture = makeScannedTwoFileVault();
    const candidate = makePlanFixture(fixture.inventoryDigest);
    assert.equal(runPlan(fixture.vault, candidate, 'approve').status, 0);
    const second = runPlan(fixture.vault, candidate, 'approve');
    assert.equal(second.status, 2);
    assert.equal(second.json.error.code, 'PLAN_VERSION_FROZEN');
    fixture.cleanup();
  });
});
