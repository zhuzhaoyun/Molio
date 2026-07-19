import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const daemonRoot = resolve(import.meta.dirname, '..', '..', '..');
const cli = join(
  daemonRoot,
  'src',
  'tools',
  'skills',
  'wiki-build',
  'scripts',
  'wiki-build.mjs',
);

export function makeVault() {
  const path = mkdtempSync(join(tmpdir(), 'molio-wiki-build-'));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function runWikiBuildCli(vaultPath: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, '--vault', vaultPath], {
    cwd: vaultPath,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

export function makePlanFixture(inventoryDigest: string): any {
  return {
    schemaVersion: 1,
    planVersion: 1,
    status: 'draft',
    inventoryDigest,
    createdAt: '2026-07-18T00:00:00.000Z',
    capacity: {
      maxLeafPages: 200,
      maxLeafIndexTokens: 12000,
      maxTopicDepth: 6,
    },
    topics: [
      {
        id: 'economy', name: '经济', slug: '经济', kind: 'leaf', depth: 1,
        summary: '经济政策与市场', rationale: '该文件讨论宏观经济。', estimatedPages: 1,
        estimatedIndexTokens: 40, fileIds: ['economy-file'], indexStrategy: 'inline',
      },
      {
        id: 'motorcycle', name: '摩托车维修', slug: '摩托车维修', kind: 'leaf', depth: 1,
        summary: '摩托车故障诊断与维修', rationale: '该文件讨论机械维修。', estimatedPages: 1,
        estimatedIndexTokens: 40, fileIds: ['motorcycle-file'], indexStrategy: 'inline',
      },
    ],
    assignments: [
      { fileId: 'economy-file', primaryTopicId: 'economy', relatedTopicIds: [], processor: 'text' },
      { fileId: 'motorcycle-file', primaryTopicId: 'motorcycle', relatedTopicIds: [], processor: 'text' },
    ],
    batches: [
      { id: 'economy-001', topicId: 'economy', order: 1, fileIds: ['economy-file'], estimatedInputTokens: 500 },
      { id: 'motorcycle-001', topicId: 'motorcycle', order: 2, fileIds: ['motorcycle-file'], estimatedInputTokens: 500 },
    ],
    batchPolicy: {
      maxFiles: 50, contextWindowTokens: 100000, maxInputFraction: 0.2, maxInputTokens: 20000,
    },
    excluded: [],
    undecided: [],
  };
}

export function makeScannedTwoFileVault() {
  const vault = makeVault();
  writeFileSync(join(vault.path, 'economy.md'), '# 经济\n宏观经济');
  writeFileSync(join(vault.path, 'motorcycle.md'), '# 摩托车维修\n机械维修');
  const scan = runWikiBuildCli(vault.path, ['scan', '--json']);
  if (scan.status !== 0) throw new Error(`Fixture scan failed: ${scan.stderr}`);

  const inventoryPath = join(vault.path, '.molio', 'wiki-build', 'inventory.jsonl');
  const records = readFileSync(inventoryPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  for (const record of records) record.id = record.path === 'economy.md' ? 'economy-file' : 'motorcycle-file';
  const contents = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  writeFileSync(inventoryPath, contents);
  return {
    vault: vault.path,
    cleanup: vault.cleanup,
    inventoryDigest: createHash('sha256').update(contents).digest('hex'),
  };
}

export function runPlan(vaultPath: string, candidate: object, mode: 'validate' | 'approve') {
  const candidatePath = join(vaultPath, 'candidate-plan.json');
  writeFileSync(candidatePath, `${JSON.stringify(candidate)}\n`);
  return runWikiBuildCli(vaultPath, ['plan', '--input', candidatePath, '--mode', mode, '--json']);
}

/**
 * Scan a vault with the given files and rewrite inventory ids to stable values
 * so plan fixtures can reference them deterministically.
 */
export function makeScannedVaultWithFiles(files: Array<{ filename: string; content: string; id: string }>) {
  const vault = makeVault();
  for (const file of files) {
    writeFileSync(join(vault.path, file.filename), file.content);
  }
  const scan = runWikiBuildCli(vault.path, ['scan', '--json']);
  if (scan.status !== 0) throw new Error(`Fixture scan failed: ${scan.stderr}`);
  const inventoryPath = join(vault.path, '.molio', 'wiki-build', 'inventory.jsonl');
  const records = readFileSync(inventoryPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  for (const record of records) {
    const match = files.find((file) => file.filename === record.path);
    if (match) record.id = match.id;
  }
  const contents = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  writeFileSync(inventoryPath, contents);
  return {
    vault: vault.path,
    cleanup: vault.cleanup,
    inventoryDigest: createHash('sha256').update(contents).digest('hex'),
  };
}

/**
 * Build a plan fixture with one batch per file (ordered) using the given
 * inventory digest and file ids. Topics mirror file ids for simplicity.
 */
export function makePlanFixtureForFiles(inventoryDigest: string, fileIds: string[], options: { singleBatch?: boolean } = {}): any {
  const topics = fileIds.map((id) => ({
    id, name: id, slug: id, kind: 'leaf' as const, depth: 1,
    summary: `${id} summary`, rationale: `${id} rationale`,
    estimatedPages: 1, estimatedIndexTokens: 40, fileIds: [id], indexStrategy: 'inline',
  }));
  const assignments = fileIds.map((id) => ({
    fileId: id, primaryTopicId: id, relatedTopicIds: [], processor: 'text',
  }));
  const batches = options.singleBatch
    ? [{ id: 'batch-001', topicId: fileIds[0], order: 1, fileIds: [...fileIds], estimatedInputTokens: 500 }]
    : fileIds.map((id, index) => ({
      id: `${id}-001`, topicId: id, order: index + 1, fileIds: [id], estimatedInputTokens: 500,
    }));
  return {
    schemaVersion: 1,
    planVersion: 1,
    status: 'draft',
    inventoryDigest,
    createdAt: '2026-07-18T00:00:00.000Z',
    capacity: { maxLeafPages: 200, maxLeafIndexTokens: 12000, maxTopicDepth: 6 },
    topics,
    assignments,
    batches,
    batchPolicy: { maxFiles: 50, contextWindowTokens: 100000, maxInputFraction: 0.2, maxInputTokens: 20000 },
    excluded: [],
    undecided: [],
  };
}

/** Approve a two-batch plan (economy + motorcycle). */
export function approveTwoBatchPlan() {
  const fixture = makeScannedTwoFileVault();
  const candidate = makePlanFixture(fixture.inventoryDigest);
  const result = runPlan(fixture.vault, candidate, 'approve');
  if (result.status !== 0) throw new Error(`approve failed: ${result.stderr}`);
  return fixture;
}

/** Approve a single-batch plan with one file (economy). */
export function approveOneBatchPlan() {
  const fixture = makeScannedVaultWithFiles([
    { filename: 'economy.md', content: '# 经济\n宏观经济', id: 'economy-file' },
  ]);
  const candidate = makePlanFixtureForFiles(fixture.inventoryDigest, ['economy-file']);
  const result = runPlan(fixture.vault, candidate, 'approve');
  if (result.status !== 0) throw new Error(`approve failed: ${result.stderr}`);
  return fixture;
}

/** Approve a single-batch plan with two files (economy + bad). */
export function approveOneBatchPlanWithTwoFiles() {
  const fixture = makeScannedVaultWithFiles([
    { filename: 'economy.md', content: '# 经济\n宏观经济', id: 'economy-file' },
    { filename: 'bad.md', content: '# 坏文件\n无法处理', id: 'bad-file' },
  ]);
  const candidate = makePlanFixtureForFiles(fixture.inventoryDigest, ['economy-file', 'bad-file'], { singleBatch: true });
  // Restore the batch id used by the spec scenario 2.
  candidate.batches[0].id = 'batch-001';
  candidate.batches[0].topicId = 'economy-file';
  // Replace single-file topic with a shared topic covering both files.
  candidate.topics = [{
    id: 'economy', name: '经济', slug: '经济', kind: 'leaf', depth: 1,
    summary: '经济', rationale: 'r', estimatedPages: 1, estimatedIndexTokens: 40,
    fileIds: ['economy-file', 'bad-file'], indexStrategy: 'inline',
  }];
  candidate.assignments = [
    { fileId: 'economy-file', primaryTopicId: 'economy', relatedTopicIds: [], processor: 'text' },
    { fileId: 'bad-file', primaryTopicId: 'economy', relatedTopicIds: [], processor: 'text' },
  ];
  candidate.batches[0].topicId = 'economy';
  const result = runPlan(fixture.vault, candidate, 'approve');
  if (result.status !== 0) throw new Error(`approve failed: ${result.stderr}`);
  return fixture;
}

/**
 * Approve a three-batch plan and then manually shape the state so that one
 * file is pending, one is failed, and one is already succeeded — the starting
 * point for skip/retry scenarios.
 */
export function approvedPlanWithFailedAndPendingFiles() {
  const fixture = makeScannedVaultWithFiles([
    { filename: 'pending.md', content: '# pending', id: 'pending-file' },
    { filename: 'failed.md', content: '# failed', id: 'failed-file' },
    { filename: 'succeeded.md', content: '# succeeded', id: 'already-succeeded' },
  ]);
  const candidate = makePlanFixtureForFiles(fixture.inventoryDigest, ['pending-file', 'failed-file', 'already-succeeded']);
  const result = runPlan(fixture.vault, candidate, 'approve');
  if (result.status !== 0) throw new Error(`approve failed: ${result.stderr}`);
  // Reshape state.json so files reflect a partially-executed run.
  const statePath = join(fixture.vault, '.molio', 'wiki-build', 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.activeBatchId = null;
  state.batches['pending-file-001'].status = 'pending';
  state.batches['pending-file-001'].attempts = 0;
  state.batches['pending-file-001'].attemptToken = null;
  state.batches['pending-file-001'].lastError = null;
  state.batches['failed-file-001'].status = 'failed';
  state.batches['failed-file-001'].attempts = 1;
  state.batches['failed-file-001'].attemptToken = null;
  state.batches['failed-file-001'].lastError = { code: 'PREPROCESS_FAILED', message: 'docling exit 1' };
  state.batches['already-succeeded-001'].status = 'succeeded';
  state.batches['already-succeeded-001'].attempts = 1;
  state.batches['already-succeeded-001'].attemptToken = null;
  state.batches['already-succeeded-001'].lastError = null;
  state.files['pending-file'].status = 'pending';
  state.files['pending-file'].attempts = 0;
  state.files['pending-file'].lastError = null;
  state.files['failed-file'].status = 'failed';
  state.files['failed-file'].attempts = 1;
  state.files['failed-file'].lastError = { code: 'PREPROCESS_FAILED', message: 'docling exit 1' };
  state.files['already-succeeded'].status = 'succeeded';
  state.files['already-succeeded'].attempts = 1;
  state.files['already-succeeded'].contentHash = 'a'.repeat(64);
  state.files['already-succeeded'].lastError = null;
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return fixture;
}

/** Write a staged source page under the given staging dir. */
export function stagePage(vaultPath: string, stagingDir: string, relPath: string, content: string) {
  const target = join(vaultPath, stagingDir, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

/** Read the current state.json from a vault's wiki-build workspace. */
export function readState(vaultPath: string): any {
  const statePath = join(vaultPath, '.molio', 'wiki-build', 'state.json');
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

/** Run a checkpoint CLI command with the given payload object. */
export function checkpoint(vaultPath: string, payload: object) {
  const inputPath = join(vaultPath, 'checkpoint-input.json');
  writeFileSync(inputPath, `${JSON.stringify(payload)}\n`);
  return runWikiBuildCli(vaultPath, ['checkpoint', '--input', inputPath, '--json']);
}
