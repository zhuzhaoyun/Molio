import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  approveOneBatchPlan,
  approveOneBatchPlanWithTwoFiles,
  approveTwoBatchPlan,
  approvedPlanWithFailedAndPendingFiles,
  checkpoint,
  makeVault,
  readState,
  runWikiBuildCli,
  stagePage,
} from './wiki-build-test-helpers.js';

const daemonRoot = resolve(import.meta.dirname, '..', '..', '..');
const stateModule = await import(pathToFileURL(join(
  daemonRoot, 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'state.mjs',
)).href);
const workspaceModule = await import(pathToFileURL(join(
  daemonRoot, 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'workspace.mjs',
)).href);

function journalPath(vaultPath: string, batchId: string) {
  return join(vaultPath, '.molio', 'wiki-build', 'journals', `${batchId}.json`);
}

function claimNext(vaultPath: string) {
  return runWikiBuildCli(vaultPath, ['next', '--json']);
}

function recover(vaultPath: string) {
  return runWikiBuildCli(vaultPath, ['status', '--recover', '--json']);
}

describe('wiki-build state — plan scenarios', () => {
  it('claims a batch and isolates a stale attempt after recovery', () => {
    const fixture = approveTwoBatchPlan();
    const first = claimNext(fixture.vault);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.json.data.batch.id, 'economy-001');
    assert.ok(first.json.data.attemptToken);
    assert.equal(first.json.data.attempt, 1);

    const blocked = claimNext(fixture.vault);
    assert.equal(blocked.status, 2);
    assert.equal(blocked.json.error.code, 'BATCH_ALREADY_RUNNING');

    recover(fixture.vault);
    const retried = claimNext(fixture.vault);
    assert.equal(retried.status, 0);
    assert.notEqual(retried.json.data.attemptToken, first.json.data.attemptToken);
    assert.equal(retried.json.data.attempt, 2);

    const stale = checkpoint(fixture.vault, {
      batchId: 'economy-001',
      attemptToken: first.json.data.attemptToken,
      files: [],
      pages: [],
    });
    assert.equal(stale.status, 2);
    assert.equal(stale.json.error.code, 'STALE_ATTEMPT');

    fixture.cleanup();
  });

  it('isolates a single failed file and retries checkpoint idempotently with no duplicate output', () => {
    const fixture = approveOneBatchPlanWithTwoFiles();
    const claim = claimNext(fixture.vault).json.data;
    stagePage(fixture.vault, claim.stagingDir, 'wiki/经济/sources/经济.md', '# 经济');

    const payload = {
      batchId: claim.batch.id,
      attemptToken: claim.attemptToken,
      files: [
        { fileId: 'economy-file', status: 'succeeded', contentHash: 'a'.repeat(64) },
        { fileId: 'bad-file', status: 'failed', error: { code: 'PREPROCESS_FAILED', message: 'docling 退出码 1' } },
      ],
      pages: [{
        path: 'wiki/经济/sources/经济.md',
        topicId: 'economy',
        type: 'source',
        title: '经济',
        summary: '经济摘要',
        stagedPath: 'wiki/经济/sources/经济.md',
      }],
    };

    assert.equal(checkpoint(fixture.vault, payload).status, 0);
    assert.equal(checkpoint(fixture.vault, payload).status, 0);
    assert.equal(readFileSync(join(fixture.vault, payload.pages[0]!.path), 'utf8'), '# 经济');
    assert.equal(readState(fixture.vault).files['bad-file'].status, 'failed');
    assert.equal(readState(fixture.vault).files['economy-file'].status, 'succeeded');

    fixture.cleanup();
  });

  it('skips pending work and retries only selected failed files', () => {
    const fixture = approvedPlanWithFailedAndPendingFiles();
    const skipped = runWikiBuildCli(fixture.vault, [
      'skip', '--file-id', 'pending-file', '--reason', '不支持的格式', '--json',
    ]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(readState(fixture.vault).files['pending-file'].status, 'skipped');

    const retried = runWikiBuildCli(fixture.vault, [
      'retry', '--file-id', 'failed-file', '--json',
    ]);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(retried.json.data.batch.fileIds.length, 1);
    assert.deepEqual(retried.json.data.batch.fileIds, ['failed-file']);
    assert.match(retried.json.data.batch.id, /^retry-failed-file-/);
    assert.equal(readState(fixture.vault).files['already-succeeded'].status, 'succeeded');
    assert.equal(readState(fixture.vault).files['failed-file'].status, 'pending');

    fixture.cleanup();
  });

  it('rejects claiming when a source file changed after plan approval', () => {
    const fixture = approveOneBatchPlan();
    appendFileSync(join(fixture.vault, 'economy.md'), '\n批准后发生变化');
    const result = claimNext(fixture.vault);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'SOURCE_CHANGED_SINCE_SCAN');
    assert.equal(existsSync(join(fixture.vault, 'wiki')), false);
    fixture.cleanup();
  });
});

describe('wiki-build state — journal replay and conflict', () => {
  it('replays a prepared journal by materializing only differing targets', async () => {
    const fixture = approveOneBatchPlan();
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const claim = claimNext(fixture.vault).json.data;
    stagePage(fixture.vault, claim.stagingDir, 'wiki/经济/sources/经济.md', '# 经济');

    const payload = {
      batchId: claim.batch.id,
      attemptToken: claim.attemptToken,
      files: [{ fileId: 'economy-file', status: 'succeeded', contentHash: 'a'.repeat(64) }],
      pages: [{
        path: 'wiki/经济/sources/经济.md',
        topicId: 'economy',
        type: 'source',
        title: '经济',
        summary: '经济摘要',
        stagedPath: 'wiki/经济/sources/经济.md',
      }],
    };

    // Write a prepared journal manually — simulating a crash after journal write
    // but before any target move.
    const stagedAbsolute = join(fixture.vault, claim.stagingDir, payload.pages[0]!.stagedPath);
    const content = readFileSync(stagedAbsolute, 'utf8');
    const targetPath = join(fixture.vault, payload.pages[0]!.path);
    const pages = {
      [payload.pages[0]!.path]: {
        sha256: stateModule.computePageSha256(stagedAbsolute),
        stagedPath: payload.pages[0]!.stagedPath,
        topicId: payload.pages[0]!.topicId,
        type: payload.pages[0]!.type,
        title: payload.pages[0]!.title,
        summary: payload.pages[0]!.summary,
      },
    };
    const payloadHash = stateModule.computePayloadHash(payload);
    mkdirSync(dirname(journalPath(fixture.vault, payload.batchId)), { recursive: true });
    writeFileSync(journalPath(fixture.vault, payload.batchId), `${JSON.stringify({
      batchId: payload.batchId,
      attemptToken: payload.attemptToken,
      payloadHash,
      phase: 'prepared',
      pages,
      files: payload.files,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    assert.equal(existsSync(targetPath), false);
    const result = await stateModule.checkpointBatch(paths, payload);
    assert.equal(existsSync(targetPath), true);
    assert.equal(readFileSync(targetPath, 'utf8'), content);

    const journal = JSON.parse(readFileSync(journalPath(fixture.vault, payload.batchId), 'utf8'));
    assert.equal(journal.phase, 'completed');
    assert.equal(readState(fixture.vault).batches[payload.batchId].status, 'succeeded');
    assert.equal(readState(fixture.vault).files['economy-file'].status, 'succeeded');
    assert.equal(readState(fixture.vault).activeBatchId, null);
    // Calling checkpointBatch again with the same payload is idempotent.
    await stateModule.checkpointBatch(paths, payload);
    assert.equal(readFileSync(targetPath, 'utf8'), content);
    fixture.cleanup();
  });

  it('replays an applied journal after a crash between state-write and journal completion', async () => {
    const fixture = approveOneBatchPlan();
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const claim = claimNext(fixture.vault).json.data;
    stagePage(fixture.vault, claim.stagingDir, 'wiki/经济/sources/经济.md', '# 经济');

    const payload = {
      batchId: claim.batch.id,
      attemptToken: claim.attemptToken,
      files: [{ fileId: 'economy-file', status: 'succeeded', contentHash: 'a'.repeat(64) }],
      pages: [{
        path: 'wiki/经济/sources/经济.md',
        topicId: 'economy',
        type: 'source',
        title: '经济',
        summary: '经济摘要',
        stagedPath: 'wiki/经济/sources/经济.md',
      }],
    };

    // Mirror the post-step-11 crash state: target already materialized,
    // state already mutated (batch succeeded, activeBatchId cleared), but
    // the journal is still 'applied' (step 12 never ran).
    const stagedAbsolute = join(fixture.vault, claim.stagingDir, payload.pages[0]!.stagedPath);
    const targetPath = join(fixture.vault, payload.pages[0]!.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(stagedAbsolute));
    const pageSha = stateModule.computePageSha256(stagedAbsolute);
    const payloadHash = stateModule.computePayloadHash(payload);
    mkdirSync(paths.journals, { recursive: true });
    writeFileSync(journalPath(fixture.vault, payload.batchId), `${JSON.stringify({
      batchId: payload.batchId,
      attemptToken: payload.attemptToken,
      payloadHash,
      phase: 'applied',
      pages: {
        [payload.pages[0]!.path]: {
          sha256: pageSha,
          stagedPath: payload.pages[0]!.stagedPath,
          topicId: payload.pages[0]!.topicId,
          type: payload.pages[0]!.type,
          title: payload.pages[0]!.title,
          summary: payload.pages[0]!.summary,
        },
      },
      files: payload.files,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    // Advance state to post-step-11 shape: batch succeeded, activeBatchId null,
    // file succeeded, pages manifest populated.
    const state = readState(fixture.vault);
    state.activeBatchId = null;
    state.batches[payload.batchId].status = 'succeeded';
    state.batches[payload.batchId].attemptToken = null;
    state.files['economy-file'].status = 'succeeded';
    state.files['economy-file'].contentHash = 'a'.repeat(64);
    state.pages[payload.pages[0]!.path] = {
      sha256: pageSha,
      batchId: payload.batchId,
      attemptToken: payload.attemptToken,
      topicId: payload.pages[0]!.topicId,
      type: payload.pages[0]!.type,
      title: payload.pages[0]!.title,
      summary: payload.pages[0]!.summary,
      stagedPath: payload.pages[0]!.stagedPath,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);

    // Re-call checkpoint via the CLI — must complete the journal without
    // raising BATCH_NOT_ACTIVE despite state.activeBatchId being null.
    const result = checkpoint(fixture.vault, payload);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.data.summary, 'succeeded');

    const journal = JSON.parse(readFileSync(journalPath(fixture.vault, payload.batchId), 'utf8'));
    assert.equal(journal.phase, 'completed');
    const finalState = readState(fixture.vault);
    assert.equal(finalState.batches[payload.batchId].status, 'succeeded');
    assert.equal(finalState.files['economy-file'].status, 'succeeded');
    assert.equal(finalState.activeBatchId, null);
    // No duplicate file move: target content unchanged.
    assert.equal(readFileSync(targetPath, 'utf8'), '# 经济');
    fixture.cleanup();
  });

  it('rejects a different payload after a completed journal with CHECKPOINT_CONFLICT', async () => {
    const fixture = approveOneBatchPlan();
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const claim = claimNext(fixture.vault).json.data;
    stagePage(fixture.vault, claim.stagingDir, 'wiki/经济/sources/经济.md', '# 经济 v1');

    const payloadV1 = {
      batchId: claim.batch.id,
      attemptToken: claim.attemptToken,
      files: [{ fileId: 'economy-file', status: 'succeeded', contentHash: 'a'.repeat(64) }],
      pages: [{
        path: 'wiki/经济/sources/经济.md',
        topicId: 'economy',
        type: 'source',
        title: '经济',
        summary: 'v1',
        stagedPath: 'wiki/经济/sources/经济.md',
      }],
    };

    assert.equal((await stateModule.checkpointBatch(paths, payloadV1)).summary, 'succeeded');

    const payloadV2 = {
      ...payloadV1,
      pages: [{ ...payloadV1.pages[0], summary: 'v2' }],
    };
    await assert.rejects(
      () => stateModule.checkpointBatch(paths, payloadV2),
      (error: any) => error.code === 'CHECKPOINT_CONFLICT',
    );
    fixture.cleanup();
  });

  it('marks mixed succeeded+failed batches as succeeded in queue with succeeded_with_errors summary', async () => {
    const fixture = approveOneBatchPlanWithTwoFiles();
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const claim = claimNext(fixture.vault).json.data;
    stagePage(fixture.vault, claim.stagingDir, 'wiki/经济/sources/经济.md', '# 经济');

    const payload = {
      batchId: claim.batch.id,
      attemptToken: claim.attemptToken,
      files: [
        { fileId: 'economy-file', status: 'succeeded', contentHash: 'a'.repeat(64) },
        { fileId: 'bad-file', status: 'failed', error: { code: 'PREPROCESS_FAILED', message: 'fail' } },
      ],
      pages: [{
        path: 'wiki/经济/sources/经济.md',
        topicId: 'economy',
        type: 'source',
        title: '经济',
        summary: '经济摘要',
        stagedPath: 'wiki/经济/sources/经济.md',
      }],
    };

    const result = await stateModule.checkpointBatch(paths, payload);
    assert.equal(result.summary, 'succeeded_with_errors');
    const state = readState(fixture.vault);
    assert.equal(state.batches[claim.batch.id].status, 'succeeded');
    assert.equal(state.files['economy-file'].status, 'succeeded');
    assert.equal(state.files['bad-file'].status, 'failed');
    assert.equal(state.activeBatchId, null);

    // `next` should be able to proceed (no remaining pending batches → returns no-op).
    const next = claimNext(fixture.vault);
    assert.equal(next.status, 2);
    assert.equal(next.json.error.code, 'NO_PENDING_BATCH');
    fixture.cleanup();
  });

  it('does not blindly retry a running batch and clears activeBatchId after recovery', () => {
    const fixture = approveTwoBatchPlan();
    const first = claimNext(fixture.vault).json.data;
    assert.equal(first.json?.data?.batch?.id ?? first.batch.id, 'economy-001');

    // While running, a second claim must not advance the queue.
    const blocked = claimNext(fixture.vault);
    assert.equal(blocked.status, 2);
    assert.equal(blocked.json.error.code, 'BATCH_ALREADY_RUNNING');

    // Recovery must clear activeBatchId but preserve attempts.
    recover(fixture.vault);
    const state = readState(fixture.vault);
    assert.equal(state.activeBatchId, null);
    assert.equal(state.batches['economy-001'].status, 'pending');
    assert.equal(state.batches['economy-001'].attempts, 1);
    assert.equal(state.batches['economy-001'].attemptToken, null);
    fixture.cleanup();
  });

  it('prepare validates the active claim before producing work items', async () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;
    const manifestPath = join(fixture.vault, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify({
      files: [{ id: 'economy-file', path: 'economy.md', extension: '.md', processor: 'text' }],
    })}\n`);

    // Wrong attempt token must be rejected.
    const wrong = runWikiBuildCli(fixture.vault, [
      'prepare', '--batch-id', claim.batch.id, '--attempt-token', 'wrong-token',
      '--input', manifestPath, '--json',
    ]);
    assert.equal(wrong.status, 2);
    assert.equal(wrong.json.error.code, 'STALE_ATTEMPT');

    const ok = runWikiBuildCli(fixture.vault, [
      'prepare', '--batch-id', claim.batch.id, '--attempt-token', claim.attemptToken,
      '--input', manifestPath, '--json',
    ]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.json.data.workItems.length >= 1);
    // Batch status must remain 'running' after prepare.
    assert.equal(readState(fixture.vault).batches[claim.batch.id].status, 'running');
    fixture.cleanup();
  });

  it('marks a batch skipped when its last pending file is skipped', () => {
    const fixture = approvedPlanWithFailedAndPendingFiles();
    const skip = runWikiBuildCli(fixture.vault, [
      'skip', '--file-id', 'pending-file', '--reason', '不支持的格式', '--json',
    ]);
    assert.equal(skip.status, 0, skip.stderr);
    const state = readState(fixture.vault);
    assert.equal(state.files['pending-file'].status, 'skipped');
    assert.equal(state.batches['pending-file-001'].status, 'skipped');
    // Skipping a failed file is also allowed.
    const skipFailed = runWikiBuildCli(fixture.vault, [
      'skip', '--file-id', 'failed-file', '--reason', '永远跳过', '--json',
    ]);
    assert.equal(skipFailed.status, 0);
    assert.equal(readState(fixture.vault).files['failed-file'].status, 'skipped');
    fixture.cleanup();
  });

  it('rejects retry on a non-failed file', () => {
    const fixture = approvedPlanWithFailedAndPendingFiles();
    const result = runWikiBuildCli(fixture.vault, [
      'retry', '--file-id', 'pending-file', '--json',
    ]);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'FILE_NOT_FAILED');
    fixture.cleanup();
  });
});

describe('wiki-build state — initializeState contract', () => {
  it('rejects initialization when the plan is not approved', () => {
    assert.throws(
      () => stateModule.initializeState({ schemaVersion: 1, planVersion: 1, status: 'draft' }),
      (error: any) => error.code === 'PLAN_NOT_APPROVED',
    );
  });

  it('rejects initialization when the plan lacks a digest', () => {
    assert.throws(
      () => stateModule.initializeState({ schemaVersion: 1, planVersion: 1, status: 'approved' }),
      (error: any) => error.code === 'PLAN_DIGEST_MISSING',
    );
  });

  it('builds the documented initial state shape', () => {
    const plan = {
      schemaVersion: 1, planVersion: 1, status: 'approved', planDigest: 'abc',
      batches: [
        { id: 'economy-001', topicId: 'economy', order: 1, fileIds: ['economy-file'], estimatedInputTokens: 500 },
      ],
    };
    const state = stateModule.initializeState(plan);
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.planVersion, 1);
    assert.equal(state.planDigest, 'abc');
    assert.equal(state.phase, 'approved');
    assert.equal(state.activeBatchId, null);
    assert.deepEqual(state.batches['economy-001'], {
      status: 'pending', attempts: 0, attemptToken: null, lastError: null,
    });
    assert.deepEqual(state.files['economy-file'], {
      status: 'pending', attempts: 0, contentHash: null, lastError: null,
    });
    assert.deepEqual(state.pages, {});
    assert.ok(typeof state.updatedAt === 'string');
  });

  it('makeVault helper isolates state across runs', () => {
    const vault = makeVault();
    const result = runWikiBuildCli(vault.path, ['status', '--json']);
    assert.equal(result.status, 0);
    assert.equal(result.json.data.phase, 'not_started');
    vault.cleanup();
  });
});

describe('wiki-build state — mutation lock self-healing', () => {
  it('reclaims a stale lock whose pid is no longer alive', () => {
    const fixture = approveOneBatchPlan();
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const lock = join(paths.root, '.lock');
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(lock, `${JSON.stringify({
      pid: 999999,
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    })}\n`);
    const result = claimNext(fixture.vault);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.json.data.batch.id, 'expected a claimed batch id');
    fixture.cleanup();
  });

  it('rejects with LOCK_BUSY when a live holder is within TTL', () => {
    const fixture = approveOneBatchPlan();
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const lock = join(paths.root, '.lock');
    mkdirSync(paths.root, { recursive: true });
    // Use the test runner's own pid — it is alive, and startedAt is recent.
    writeFileSync(lock, `${JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`);
    const result = claimNext(fixture.vault);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'LOCK_BUSY');
    assert.equal(result.json.error.details.lock, lock);
    fixture.cleanup();
  });

  it('recovers via status --recover after a stale lock', () => {
    const fixture = approveOneBatchPlan();
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const lock = join(paths.root, '.lock');
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(lock, `${JSON.stringify({
      pid: 999999,
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    })}\n`);
    const result = recover(fixture.vault);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(lock), false);
    fixture.cleanup();
  });
});

describe('wiki-build state — checkpoint --auto', () => {
  function stagePageWithFrontmatter(vaultPath: string, stagingDir: string, relPath: string, fm: Record<string, string>, body: string) {
    const lines = ['---'];
    for (const [key, value] of Object.entries(fm)) {
      lines.push(`${key}: ${value}`);
    }
    lines.push('---', '', body);
    stagePage(vaultPath, stagingDir, relPath, lines.join('\n'));
  }

  it('assembles payload from frontmatter and checkpoints successfully', () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;
    stagePageWithFrontmatter(fixture.vault, claim.stagingDir, 'wiki/economy/sources/经济.md', {
      type: 'sources', title: '经济', topicId: 'economy', summary: '经济摘要',
    }, '# 经济\n宏观经济');

    const result = runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.data.summary, 'succeeded');
    assert.equal(readState(fixture.vault).files['economy-file'].status, 'succeeded');
    assert.equal(readState(fixture.vault).activeBatchId, null);
    fixture.cleanup();
  });

  it('marks failed files via --failed-file', () => {
    const fixture = approveOneBatchPlanWithTwoFiles();
    const claim = claimNext(fixture.vault).json.data;
    stagePageWithFrontmatter(fixture.vault, claim.stagingDir, 'wiki/经济/sources/经济.md', {
      type: 'sources', title: '经济', topicId: 'economy', summary: '经济摘要',
    }, '# 经济');

    const result = runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--failed-file', 'bad-file:PREPROCESS_FAILED:docling exit 1',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.data.summary, 'succeeded_with_errors');
    assert.equal(readState(fixture.vault).files['economy-file'].status, 'succeeded');
    assert.equal(readState(fixture.vault).files['bad-file'].status, 'failed');
    fixture.cleanup();
  });

  it('rejects staged pages missing required frontmatter', () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;
    // Stage a page without frontmatter
    stagePage(fixture.vault, claim.stagingDir, 'wiki/economy/sources/经济.md', '# 经济\nNo frontmatter');

    const result = runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--json',
    ]);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'FRONTMATTER_MISSING');
    fixture.cleanup();
  });

  it('updates incremental indexes after checkpoint', () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;
    stagePageWithFrontmatter(fixture.vault, claim.stagingDir, 'wiki/economy-file/sources/经济.md', {
      type: 'sources', title: '经济', topicId: 'economy-file', summary: '经济摘要',
    }, '# 经济\n宏观经济');

    const result = runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);

    // Leaf INDEX.md should exist and contain the new page
    const indexPath = join(fixture.vault, 'wiki', 'economy-file', 'INDEX.md');
    assert.ok(existsSync(indexPath), 'leaf INDEX.md should exist after checkpoint');
    const indexContent = readFileSync(indexPath, 'utf8');
    assert.match(indexContent, /经济/);
    fixture.cleanup();
  });

  it('appends to log.md after checkpoint', () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;
    stagePageWithFrontmatter(fixture.vault, claim.stagingDir, 'wiki/economy/sources/经济.md', {
      type: 'sources', title: '经济', topicId: 'economy', summary: '经济摘要',
    }, '# 经济');

    runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--json',
    ]);

    const logPath = join(fixture.vault, 'wiki', 'log.md');
    assert.ok(existsSync(logPath), 'log.md should exist after checkpoint');
    const logContent = readFileSync(logPath, 'utf8');
    assert.match(logContent, /# 构建日志/);
    assert.match(logContent, /checkpoint/);
    assert.match(logContent, new RegExp(claim.batch.id));
    fixture.cleanup();
  });

  it('rewrites hot.md after checkpoint', () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;
    stagePageWithFrontmatter(fixture.vault, claim.stagingDir, 'wiki/economy/sources/经济.md', {
      type: 'sources', title: '经济', topicId: 'economy', summary: '经济摘要',
    }, '# 经济');

    runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--json',
    ]);

    const hotPath = join(fixture.vault, 'wiki', 'hot.md');
    assert.ok(existsSync(hotPath), 'hot.md should exist after checkpoint');
    const hotContent = readFileSync(hotPath, 'utf8');
    assert.match(hotContent, /# 构建状态缓存/);
    assert.match(hotContent, /Phase/);
    fixture.cleanup();
  });

  it('rejects empty staging dir with NO_STAGED_PAGES', () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;
    // Do NOT stage any pages — staging dir is empty

    const result = runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--json',
    ]);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'NO_STAGED_PAGES');
    fixture.cleanup();
  });

  it('rejects --failed-file with unknown file id', () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;
    stagePageWithFrontmatter(fixture.vault, claim.stagingDir, 'wiki/economy/sources/经济.md', {
      type: 'sources', title: '经济', topicId: 'economy', summary: '经济摘要',
    }, '# 经济');

    const result = runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--failed-file', 'nonexistent:ERR:some message',
      '--json',
    ]);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'UNKNOWN_FILE_ID');
    fixture.cleanup();
  });

  it('rejects --auto combined with --input', () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;

    const result = runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto', '--input', 'foo.json',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--json',
    ]);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'INVALID_ARGUMENT');
    assert.match(result.json.error.message, /mutually exclusive/);
    fixture.cleanup();
  });

  it('rejects malformed --failed-file without colons', () => {
    const fixture = approveOneBatchPlan();
    const claim = claimNext(fixture.vault).json.data;

    const result = runWikiBuildCli(fixture.vault, [
      'checkpoint', '--auto',
      '--batch-id', claim.batch.id,
      '--attempt-token', claim.attemptToken,
      '--failed-file', 'badformat',
      '--json',
    ]);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'INVALID_ARGUMENT');
    fixture.cleanup();
  });
});
