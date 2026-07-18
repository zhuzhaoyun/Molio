import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makePlanFixture, makeScannedTwoFileVault, runPlan, runWikiBuildCli } from './wiki-build-test-helpers.js';

function runPlanStatus(vaultPath: string) {
  return runWikiBuildCli(vaultPath, ['status', '--json']);
}

const daemonRoot = resolve(import.meta.dirname, '..', '..', '..');
const planModule = await import(pathToFileURL(join(
  daemonRoot, 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'plan.mjs',
)).href);
const workspaceModule = await import(pathToFileURL(join(
  daemonRoot, 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'workspace.mjs',
)).href);

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

  it('retries a pointer publish after immutable history was safely written', () => {
    const fixture = makeScannedTwoFileVault();
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const candidate = makePlanFixture(fixture.inventoryDigest);
    let failPlanPointer = true;
    const writeJson = (path: string, value: unknown) => {
      if (path === paths.plan && failPlanPointer) throw new Error('simulated plan pointer failure');
      workspaceModule.atomicWriteJson(path, value);
    };

    assert.throws(
      () => planModule.approvePlan(paths, candidate, { writeJson }),
      /simulated plan pointer failure/,
    );
    const historyPath = join(paths.planHistory, 'plan-v0001.json');
    assert.equal(existsSync(historyPath), true);
    assert.equal(existsSync(paths.plan), false);
    const frozenHistory = readFileSync(historyPath, 'utf8');
    assert.throws(
      () => planModule.approvePlan(paths, { ...candidate, createdAt: '2026-07-19T00:00:00.000Z' }, { writeJson }),
      { code: 'PLAN_VERSION_FROZEN' },
    );

    failPlanPointer = false;
    const approved = planModule.approvePlan(paths, candidate, { writeJson });
    assert.equal(readFileSync(historyPath, 'utf8'), frozenHistory);
    assert.deepEqual(JSON.parse(readFileSync(paths.plan, 'utf8')), approved);
    fixture.cleanup();
  });

  it('requires every assignment exactly once in a batch for its primary leaf', () => {
    const fixture = makeScannedTwoFileVault();
    const candidate = makePlanFixture(fixture.inventoryDigest);
    candidate.batches[1].fileIds = ['economy-file'];
    const result = runPlan(fixture.vault, candidate, 'validate');
    assert.equal(result.status, 2);
    assert.deepEqual(result.json.error.details.codes, [
      'BATCH_FILE_DUPLICATE',
      'BATCH_FILE_CROSS_TOPIC',
      'BATCH_ASSIGNMENT_MISSING',
    ]);
    fixture.cleanup();
  });

  it('requires leaf fileIds to be known, unique, and equal to primary assignments', () => {
    const fixture = makeScannedTwoFileVault();
    const candidate = makePlanFixture(fixture.inventoryDigest);
    candidate.topics[0].fileIds = ['economy-file', 'economy-file', 'ghost-file'];
    const result = runPlan(fixture.vault, candidate, 'validate');
    assert.equal(result.status, 2);
    assert.deepEqual(result.json.error.details.codes, [
      'LEAF_FILE_ID_DUPLICATE',
      'LEAF_FILE_ID_UNKNOWN',
      'LEAF_ASSIGNMENT_SET_MISMATCH',
    ]);
    fixture.cleanup();
  });

  it('recursively aggregates independent child errors below a one-child branch', () => {
    const fixture = makeScannedTwoFileVault();
    const candidate = makePlanFixture(fixture.inventoryDigest);
    candidate.topics = [{
      id: 'semantic-root', name: '知识', slug: '知识', kind: 'branch', depth: 1,
      splitReason: 'semantic', estimatedPages: 2, estimatedIndexTokens: 80,
      children: [{ ...candidate.topics[0], slug: 'INDEX.md' }],
    }];
    const result = runPlan(fixture.vault, candidate, 'validate');
    assert.equal(result.status, 2);
    assert.deepEqual(result.json.error.details.codes, [
      'BRANCH_REQUIRES_TWO_CHILDREN',
      'TOPIC_SLUG_RESERVED',
    ]);
    fixture.cleanup();
  });

  it('rejects a leaf that explicitly declares an empty children array', () => {
    const fixture = makeScannedTwoFileVault();
    const candidate = makePlanFixture(fixture.inventoryDigest);
    candidate.topics[0].children = [];
    const result = runPlan(fixture.vault, candidate, 'validate');
    assert.equal(result.status, 2);
    assert.deepEqual(result.json.error.details.codes, ['LEAF_HAS_CHILDREN']);
    fixture.cleanup();
  });
});
