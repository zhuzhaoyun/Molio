import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkpoint,
  makePlanFixture,
  makeVault,
  readState,
  runWikiBuildCli,
  stagePage,
} from './wiki-build-test-helpers.js';

// ---------------------------------------------------------------------------
// Workflow helpers
// ---------------------------------------------------------------------------

/** Create a vault with the given files, scan, and rewrite inventory ids. */
function createWorkflowVault(files: Record<string, string>) {
  const vault = makeVault();
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(vault.path, filename), content);
  }
  const scan = runWikiBuildCli(vault.path, ['scan', '--json']);
  if (scan.status !== 0) throw new Error(`scan failed: ${scan.stderr}`);
  const inventoryPath = join(vault.path, '.molio', 'wiki-build', 'inventory.jsonl');
  const records = readFileSync(inventoryPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const record of records) {
    if (record.path === 'economy.md') record.id = 'economy-file';
    else if (record.path === 'motorcycle.md') record.id = 'motorcycle-file';
    else if (record.path === 'bad.md') record.id = 'bad-file';
  }
  writeFileSync(inventoryPath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return vault;
}

/** Compute the sha256 digest of the current inventory file. */
function inventoryDigest(vaultPath: string) {
  const inventoryPath = join(vaultPath, '.molio', 'wiki-build', 'inventory.jsonl');
  const contents = readFileSync(inventoryPath, 'utf8');
  return createHash('sha256').update(contents).digest('hex');
}

/** Write a 2-topic plan candidate JSON to disk, return the path. */
function writeTwoDomainPlan(vaultPath: string) {
  const candidate = makePlanFixture(inventoryDigest(vaultPath));
  const candidatePath = join(vaultPath, 'candidate-plan.json');
  writeFileSync(candidatePath, `${JSON.stringify(candidate)}\n`);
  return candidatePath;
}

/** Run next --json and return the claim data. */
function claim(vaultPath: string) {
  const result = runWikiBuildCli(vaultPath, ['next', '--json']);
  assert.equal(result.status, 0, `claim failed: ${result.stderr}`);
  return result.json.data;
}

/** Run prepare --batch-id ... --attempt-token ... --input MANIFEST --json. */
function prepareClaimedBatch(vaultPath: string, claimData: any) {
  const inventoryPath = join(vaultPath, '.molio', 'wiki-build', 'inventory.jsonl');
  const records = readFileSync(inventoryPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const manifest = records.filter((r: any) => claimData.batch.fileIds.includes(r.id));
  const manifestPath = join(vaultPath, 'prepare-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const result = runWikiBuildCli(vaultPath, [
    'prepare', '--batch-id', claimData.batch.id,
    '--attempt-token', claimData.attemptToken,
    '--input', manifestPath, '--json',
  ]);
  assert.equal(result.status, 0, `prepare failed: ${result.stderr}`);
  return result.json.data;
}

/** Stage a source page under the claim's staging dir. */
function stageSourcePage(vaultPath: string, claimData: any, title: string) {
  stagePage(vaultPath, claimData.stagingDir, `wiki/${title}/sources/${title}.md`, `# ${title}\nContent`);
}

/** Write a succeeded checkpoint payload for all files in the batch. */
function checkpointSucceeded(vaultPath: string, claimData: any) {
  const topicMap: Record<string, { topicId: string; title: string }> = {
    'economy-file': { topicId: 'economy', title: '经济' },
    'motorcycle-file': { topicId: 'motorcycle', title: '摩托车维修' },
  };
  const payload = {
    batchId: claimData.batch.id,
    attemptToken: claimData.attemptToken,
    files: claimData.batch.fileIds.map((id: string) => ({
      fileId: id,
      status: 'succeeded' as const,
      contentHash: 'a'.repeat(64),
    })),
    pages: claimData.batch.fileIds.map((id: string) => {
      const { topicId, title } = topicMap[id] ?? { topicId: id, title: id };
      return {
        path: `wiki/${title}/sources/${title}.md`,
        topicId,
        type: 'sources',
        title,
        summary: `${title}摘要`,
        stagedPath: `wiki/${title}/sources/${title}.md`,
      };
    }),
  };
  const result = checkpoint(vaultPath, payload);
  assert.equal(result.status, 0, `checkpoint failed: ${result.stderr}`);
  return result;
}

/** Write topic summaries JSON and return the file path. */
function writeTopicSummaries(vaultPath: string, summaries: Record<string, { summary: string }>) {
  const summariesPath = join(vaultPath, 'summaries.json');
  writeFileSync(summariesPath, `${JSON.stringify(summaries)}\n`);
  return summariesPath;
}

/** Build a 3-file plan candidate: economy (2 files), motorcycle (1 file). */
function makeThreeFilePlan(digest: string) {
  return {
    schemaVersion: 1,
    planVersion: 1,
    status: 'draft',
    inventoryDigest: digest,
    createdAt: '2026-07-18T00:00:00.000Z',
    capacity: { maxLeafPages: 200, maxLeafIndexTokens: 12000, maxTopicDepth: 6 },
    topics: [
      {
        id: 'economy', name: '经济', slug: '经济', kind: 'leaf' as const, depth: 1,
        summary: '经济', rationale: 'r', estimatedPages: 1, estimatedIndexTokens: 40,
        fileIds: ['economy-file', 'bad-file'], indexStrategy: 'inline',
      },
      {
        id: 'motorcycle', name: '摩托车维修', slug: '摩托车维修', kind: 'leaf' as const, depth: 1,
        summary: '摩托车维修', rationale: 'r', estimatedPages: 1, estimatedIndexTokens: 40,
        fileIds: ['motorcycle-file'], indexStrategy: 'inline',
      },
    ],
    assignments: [
      { fileId: 'economy-file', primaryTopicId: 'economy', relatedTopicIds: [], processor: 'text' },
      { fileId: 'bad-file', primaryTopicId: 'economy', relatedTopicIds: [], processor: 'text' },
      { fileId: 'motorcycle-file', primaryTopicId: 'motorcycle', relatedTopicIds: [], processor: 'text' },
    ],
    batches: [
      { id: 'economy-001', topicId: 'economy', order: 1, fileIds: ['economy-file', 'bad-file'], estimatedInputTokens: 500 },
      { id: 'motorcycle-001', topicId: 'motorcycle', order: 2, fileIds: ['motorcycle-file'], estimatedInputTokens: 500 },
    ],
    batchPolicy: { maxFiles: 50, contextWindowTokens: 100000, maxInputFraction: 0.2, maxInputTokens: 20000 },
    excluded: [],
    undecided: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wiki-build workflow — E2E', () => {
  it('runs from scan to finalize with a simulated crash mid-build', () => {
    const vault = createWorkflowVault({
      'economy.md': '# 经济\n市场',
      'motorcycle.md': '# 摩托车维修\n化油器',
    });

    // 1. Scan was already done in createWorkflowVault (with stable id rewrite).

    // 2. Validate plan (no wiki/ created yet)
    const candidate = writeTwoDomainPlan(vault.path);
    const validate = runWikiBuildCli(vault.path, [
      'plan', '--input', candidate, '--mode', 'validate', '--json',
    ]);
    assert.equal(validate.status, 0, `validate failed: ${validate.stderr}`);

    // 3. Approve plan
    const approve = runWikiBuildCli(vault.path, [
      'plan', '--input', candidate, '--mode', 'approve', '--json',
    ]);
    assert.equal(approve.status, 0, `approve failed: ${approve.stderr}`);

    // 4. Claim economy batch → prepare → stage page → checkpoint succeeded
    const economy = claim(vault.path);
    assert.equal(economy.batch.id, 'economy-001');
    prepareClaimedBatch(vault.path, economy);
    stageSourcePage(vault.path, economy, '经济');
    checkpointSucceeded(vault.path, economy);

    // 5. Claim motorcycle batch (simulated crash: activeBatchId is set)
    const motorcycleBeforeCrash = claim(vault.path);
    assert.equal(motorcycleBeforeCrash.batch.id, 'motorcycle-001');
    assert.equal(readState(vault.path).activeBatchId, motorcycleBeforeCrash.batch.id);

    // 6. Recover (clear activeBatchId, flip running→pending)
    const recover = runWikiBuildCli(vault.path, ['status', '--recover', '--json']);
    assert.equal(recover.status, 0, `recover failed: ${recover.stderr}`);
    const recoveredState = readState(vault.path);
    assert.equal(recoveredState.activeBatchId, null);
    assert.equal(recoveredState.batches['motorcycle-001'].status, 'pending');

    // 7. Re-claim motorcycle (new attemptToken)
    const motorcycleAfterCrash = claim(vault.path);
    assert.notEqual(motorcycleAfterCrash.attemptToken, motorcycleBeforeCrash.attemptToken);
    prepareClaimedBatch(vault.path, motorcycleAfterCrash);
    stageSourcePage(vault.path, motorcycleAfterCrash, '摩托车维修');
    checkpointSucceeded(vault.path, motorcycleAfterCrash);

    // 8. Finalize with summaries
    const summaries = writeTopicSummaries(vault.path, {
      economy: { summary: '经济摘要' },
      motorcycle: { summary: '摩托车摘要' },
    });
    const final = runWikiBuildCli(vault.path, [
      'finalize', '--summaries', summaries, '--json',
    ]);
    assert.equal(final.status, 0, `finalize failed: ${final.stderr}`);
    assert.equal(final.json.data.phase, 'completed');

    // Verify index contains both topics
    const indexContent = readFileSync(join(vault.path, 'wiki', 'INDEX.md'), 'utf8');
    assert.match(indexContent, /经济/);
    assert.match(indexContent, /摩托车维修/);

    vault.cleanup();
  });

  it('handles partial failure and skip, finalizing with completed_with_errors', () => {
    const vault = createWorkflowVault({
      'economy.md': '# 经济\n市场',
      'motorcycle.md': '# 摩托车维修\n化油器',
      'bad.md': '# 坏文件\n无法处理',
    });

    // Approve a custom plan: economy topic with 2 files, motorcycle with 1 file
    const candidatePath = join(vault.path, 'candidate-plan.json');
    writeFileSync(candidatePath, `${JSON.stringify(makeThreeFilePlan(inventoryDigest(vault.path)))}\n`);
    assert.equal(runWikiBuildCli(vault.path, [
      'plan', '--input', candidatePath, '--mode', 'approve', '--json',
    ]).status, 0);

    // Claim economy batch → prepare → stage → checkpoint with partial failure
    const economy = claim(vault.path);
    assert.equal(economy.batch.id, 'economy-001');
    prepareClaimedBatch(vault.path, economy);
    stageSourcePage(vault.path, economy, '经济');

    const cp1 = checkpoint(vault.path, {
      batchId: economy.batch.id,
      attemptToken: economy.attemptToken,
      files: [
        { fileId: 'economy-file', status: 'succeeded', contentHash: 'a'.repeat(64) },
        { fileId: 'bad-file', status: 'failed', error: { code: 'PREPROCESS_FAILED', message: 'test failure' } },
      ],
      pages: [{
        path: 'wiki/经济/sources/经济.md',
        topicId: 'economy', type: 'sources', title: '经济',
        summary: '经济摘要', stagedPath: 'wiki/经济/sources/经济.md',
      }],
    });
    assert.equal(cp1.status, 0, `partial checkpoint failed: ${cp1.stderr}`);
    assert.equal(readState(vault.path).files['bad-file'].status, 'failed');
    assert.equal(readState(vault.path).files['economy-file'].status, 'succeeded');

    // Skip the failed bad-file
    const skip = runWikiBuildCli(vault.path, [
      'skip', '--file-id', 'bad-file', '--reason', '不支持的格式', '--json',
    ]);
    assert.equal(skip.status, 0, `skip failed: ${skip.stderr}`);
    assert.equal(readState(vault.path).files['bad-file'].status, 'skipped');

    // Process motorcycle batch normally
    const motorcycle = claim(vault.path);
    assert.equal(motorcycle.batch.id, 'motorcycle-001');
    prepareClaimedBatch(vault.path, motorcycle);
    stageSourcePage(vault.path, motorcycle, '摩托车维修');
    checkpointSucceeded(vault.path, motorcycle);

    // Finalize — completed_with_errors because bad-file is skipped
    const summaries = writeTopicSummaries(vault.path, {
      economy: { summary: '经济摘要' },
      motorcycle: { summary: '摩托车摘要' },
    });
    const final = runWikiBuildCli(vault.path, [
      'finalize', '--summaries', summaries, '--json',
    ]);
    assert.equal(final.status, 0, `finalize failed: ${final.stderr}`);
    assert.equal(final.json.data.phase, 'completed_with_errors');
    assert.equal(final.json.data.succeeded, 2);
    assert.equal(final.json.data.failed, 0);
    assert.equal(final.json.data.skipped, 1);

    // Verify index was generated with both topics
    const indexContent = readFileSync(join(vault.path, 'wiki', 'INDEX.md'), 'utf8');
    assert.match(indexContent, /经济/);
    assert.match(indexContent, /摩托车维修/);

    vault.cleanup();
  });

  it('retries a failed file and completes the build', () => {
    const vault = createWorkflowVault({
      'economy.md': '# 经济\n市场',
      'motorcycle.md': '# 摩托车维修\n化油器',
      'bad.md': '# 坏文件\n无法处理',
    });

    // Approve custom plan
    const candidatePath = join(vault.path, 'candidate-plan.json');
    writeFileSync(candidatePath, `${JSON.stringify(makeThreeFilePlan(inventoryDigest(vault.path)))}\n`);
    assert.equal(runWikiBuildCli(vault.path, [
      'plan', '--input', candidatePath, '--mode', 'approve', '--json',
    ]).status, 0);

    // Process economy batch: economy-file succeeds, bad-file fails
    const economy = claim(vault.path);
    prepareClaimedBatch(vault.path, economy);
    stageSourcePage(vault.path, economy, '经济');
    const cp1 = checkpoint(vault.path, {
      batchId: economy.batch.id,
      attemptToken: economy.attemptToken,
      files: [
        { fileId: 'economy-file', status: 'succeeded', contentHash: 'a'.repeat(64) },
        { fileId: 'bad-file', status: 'failed', error: { code: 'PREPROCESS_FAILED', message: 'fail' } },
      ],
      pages: [{
        path: 'wiki/经济/sources/经济.md',
        topicId: 'economy', type: 'sources', title: '经济',
        summary: '经济摘要', stagedPath: 'wiki/经济/sources/经济.md',
      }],
    });
    assert.equal(cp1.status, 0, cp1.stderr);
    assert.equal(readState(vault.path).files['bad-file'].status, 'failed');

    // Retry bad-file → creates a retry batch
    const retry = runWikiBuildCli(vault.path, [
      'retry', '--file-id', 'bad-file', '--json',
    ]);
    assert.equal(retry.status, 0, `retry failed: ${retry.stderr}`);
    assert.equal(readState(vault.path).files['bad-file'].status, 'pending');
    const retryBatchId = retry.json.data.batch.id;
    assert.match(retryBatchId, /^retry-bad-file-/);

    // Process motorcycle batch
    const motorcycle = claim(vault.path);
    assert.equal(motorcycle.batch.id, 'motorcycle-001');
    prepareClaimedBatch(vault.path, motorcycle);
    stageSourcePage(vault.path, motorcycle, '摩托车维修');
    checkpointSucceeded(vault.path, motorcycle);

    // Claim and process retry batch for bad-file
    const retryClaim = claim(vault.path);
    assert.equal(retryClaim.batch.id, retryBatchId);
    prepareClaimedBatch(vault.path, retryClaim);
    // Stage a page for bad-file under the economy topic
    stagePage(
      vault.path,
      retryClaim.stagingDir,
      'wiki/经济/sources/坏文件.md',
      '# 坏文件\nFixed content',
    );
    const cpRetry = checkpoint(vault.path, {
      batchId: retryClaim.batch.id,
      attemptToken: retryClaim.attemptToken,
      files: [{ fileId: 'bad-file', status: 'succeeded', contentHash: 'b'.repeat(64) }],
      pages: [{
        path: 'wiki/经济/sources/坏文件.md',
        topicId: 'economy', type: 'sources', title: '坏文件',
        summary: '修复后摘要', stagedPath: 'wiki/经济/sources/坏文件.md',
      }],
    });
    assert.equal(cpRetry.status, 0, `retry checkpoint failed: ${cpRetry.stderr}`);
    assert.equal(readState(vault.path).files['bad-file'].status, 'succeeded');

    // Finalize — all files succeeded, phase is completed
    const summaries = writeTopicSummaries(vault.path, {
      economy: { summary: '经济摘要' },
      motorcycle: { summary: '摩托车摘要' },
    });
    const final = runWikiBuildCli(vault.path, [
      'finalize', '--summaries', summaries, '--json',
    ]);
    assert.equal(final.status, 0, `finalize failed: ${final.stderr}`);
    assert.equal(final.json.data.phase, 'completed');
    assert.equal(final.json.data.succeeded, 3);
    assert.equal(final.json.data.failed, 0);
    assert.equal(final.json.data.skipped, 0);

    vault.cleanup();
  });

  it('runs E2E with checkpoint --auto (2-command loop)', () => {
    const vault = createWorkflowVault({
      'economy.md': '# 经济\n市场',
      'motorcycle.md': '# 摩托车维修\n化油器',
    });

    // Approve plan
    const candidate = writeTwoDomainPlan(vault.path);
    assert.equal(runWikiBuildCli(vault.path, [
      'plan', '--input', candidate, '--mode', 'approve', '--json',
    ]).status, 0);

    // Process economy batch: next → stage with frontmatter → checkpoint --auto
    const economy = claim(vault.path);
    assert.equal(economy.batch.id, 'economy-001');
    stagePage(
      vault.path,
      economy.stagingDir,
      'wiki/经济/sources/经济.md',
      '---\ntype: sources\ntitle: 经济\ntopicId: economy\nsummary: 经济摘要\n---\n\n# 经济\n市场',
    );
    const cp1 = runWikiBuildCli(vault.path, [
      'checkpoint', '--auto',
      '--batch-id', economy.batch.id,
      '--attempt-token', economy.attemptToken,
      '--json',
    ]);
    assert.equal(cp1.status, 0, `checkpoint --auto failed: ${cp1.stderr}`);
    assert.equal(cp1.json.data.summary, 'succeeded');

    // Verify incremental artifacts exist after checkpoint
    assert.ok(existsSync(join(vault.path, 'wiki', '经济', 'INDEX.md')), 'leaf INDEX should exist');
    assert.ok(existsSync(join(vault.path, 'wiki', 'log.md')), 'log.md should exist');
    assert.ok(existsSync(join(vault.path, 'wiki', 'hot.md')), 'hot.md should exist');

    // Process motorcycle batch
    const motorcycle = claim(vault.path);
    stagePage(
      vault.path,
      motorcycle.stagingDir,
      'wiki/摩托车维修/sources/摩托车维修.md',
      '---\ntype: sources\ntitle: 摩托车维修\ntopicId: motorcycle\nsummary: 摩托车摘要\n---\n\n# 摩托车维修\n化油器',
    );
    const cp2 = runWikiBuildCli(vault.path, [
      'checkpoint', '--auto',
      '--batch-id', motorcycle.batch.id,
      '--attempt-token', motorcycle.attemptToken,
      '--json',
    ]);
    assert.equal(cp2.status, 0, cp2.stderr);

    // Finalize
    const summaries = writeTopicSummaries(vault.path, {
      economy: { summary: '经济摘要' },
      motorcycle: { summary: '摩托车摘要' },
    });
    const final = runWikiBuildCli(vault.path, [
      'finalize', '--summaries', summaries, '--json',
    ]);
    assert.equal(final.status, 0, final.stderr);
    assert.equal(final.json.data.phase, 'completed');

    vault.cleanup();
  });

  it('run --resume recovers orphan claims and claims next batch', () => {
    const vault = createWorkflowVault({
      'economy.md': '# 经济\n市场',
      'motorcycle.md': '# 摩托车维修\n化油器',
    });

    const candidate = writeTwoDomainPlan(vault.path);
    assert.equal(runWikiBuildCli(vault.path, [
      'plan', '--input', candidate, '--mode', 'approve', '--json',
    ]).status, 0);

    // Claim first batch, then simulate a crash (leave activeBatchId set)
    const first = claim(vault.path);
    assert.equal(first.batch.id, 'economy-001');
    assert.equal(readState(vault.path).activeBatchId, 'economy-001');

    // run --resume should recover and claim the same batch again
    const resumed = runWikiBuildCli(vault.path, ['run', '--resume', '--json']);
    assert.equal(resumed.status, 0, `run --resume failed: ${resumed.stderr}`);
    assert.equal(resumed.json.data.batch.id, 'economy-001');
    assert.ok(resumed.json.data.attemptToken);
    // New attempt token after recovery
    assert.notEqual(resumed.json.data.attemptToken, first.attemptToken);

    vault.cleanup();
  });

  it('run --resume returns no-op message when no pending batches remain', () => {
    const vault = createWorkflowVault({
      'economy.md': '# 经济\n市场',
    });

    // Approve a single-batch plan and complete it
    const fixture = makePlanFixture(inventoryDigest(vault.path));
    // Keep only economy topic/batch
    fixture.topics = [fixture.topics[0]];
    fixture.assignments = [fixture.assignments[0]];
    fixture.batches = [fixture.batches[0]];
    const candidatePath = join(vault.path, 'candidate-plan.json');
    writeFileSync(candidatePath, `${JSON.stringify(fixture)}\n`);
    assert.equal(runWikiBuildCli(vault.path, [
      'plan', '--input', candidatePath, '--mode', 'approve', '--json',
    ]).status, 0);

    const economy = claim(vault.path);
    stagePage(
      vault.path,
      economy.stagingDir,
      'wiki/经济/sources/经济.md',
      '---\ntype: sources\ntitle: 经济\ntopicId: economy\nsummary: 经济摘要\n---\n\n# 经济',
    );
    const cp = runWikiBuildCli(vault.path, [
      'checkpoint', '--auto',
      '--batch-id', economy.batch.id,
      '--attempt-token', economy.attemptToken,
      '--json',
    ]);
    assert.equal(cp.status, 0, cp.stderr);

    // No more pending batches
    const resumed = runWikiBuildCli(vault.path, ['run', '--resume', '--json']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.json.data.message, 'No pending batches');

    vault.cleanup();
  });
});
