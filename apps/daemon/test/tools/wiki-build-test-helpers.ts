import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
