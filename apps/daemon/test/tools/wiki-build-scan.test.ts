import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { makeVault, runWikiBuildCli } from './wiki-build-test-helpers.js';

function writeFile(vaultPath: string, relativePath: string, contents: string) {
  const path = join(vaultPath, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function createFiles(vaultPath: string, directory: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    writeFile(vaultPath, join(directory, `${index}.md`), `# ${index}`);
  }
}

function readInventory(vaultPath: string) {
  const path = join(vaultPath, '.molio', 'wiki-build', 'inventory.jsonl');
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('wiki-build scan', () => {
  it('does not read wiki or hidden workspace and writes a deterministic inventory', () => {
    const vault = makeVault();
    writeFile(vault.path, 'notes/economy.md', '# 经济\n' + 'x'.repeat(20_000));
    writeFile(vault.path, 'slides.pptx', '模拟 Office');
    writeFile(vault.path, 'archive.zip', '模拟 ZIP');
    writeFile(vault.path, 'wiki/old.md', 'should be ignored');
    writeFile(vault.path, '.molio/private.md', 'should be ignored');

    const result = runWikiBuildCli(vault.path, ['scan', '--json']);
    assert.equal(result.status, 0);
    assert.equal(result.json.data.counts.total, 3);

    const records = readInventory(vault.path);
    assert.deepEqual(records.map((record: { path: string }) => record.path), [
      'archive.zip',
      'notes/economy.md',
      'slides.pptx',
    ]);
    assert.equal(records[1].title, '经济');
    assert.equal(records[1].processor, 'text');
    assert.equal(records[2].processor, 'docling');
    assert.equal(records[0].support, 'needs-confirmation');
    assert.ok(records[1].samplePath.startsWith('.molio/wiki-build/samples/'));
    vault.cleanup();
  });

  it('records directory limits without crashing', () => {
    const vault = makeVault();
    createFiles(vault.path, 'dump', 4);
    const result = runWikiBuildCli(vault.path, [
      'scan', '--max-dir-entries', '3', '--max-total', '2', '--json',
    ]);
    assert.equal(result.status, 0);
    assert.ok(result.json.data.errors.some((error: { code: string }) => error.code === 'DIRECTORY_LIMIT'));
    vault.cleanup();
  });

  it('stops at the total limit across ordinary directories', () => {
    const vault = makeVault();
    createFiles(vault.path, 'a', 2);
    createFiles(vault.path, 'b', 2);
    createFiles(vault.path, 'c', 2);

    const result = runWikiBuildCli(vault.path, [
      'scan', '--max-dir-entries', '4', '--max-total', '2', '--json',
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.json.data.counts.total, 2);
    assert.deepEqual(readInventory(vault.path).map((record: { path: string }) => record.path), [
      'a/0.md', 'a/1.md',
    ]);
    assert.ok(result.json.data.errors.some((error: { code: string }) => error.code === 'TOTAL_LIMIT'));
    assert.equal(result.json.data.errors.some((error: { code: string }) => error.code === 'DIRECTORY_LIMIT'), false);
    vault.cleanup();
  });

  it('prunes an oversized directory instead of scanning part of it', () => {
    const vault = makeVault();
    createFiles(vault.path, 'dump', 4);
    writeFile(vault.path, 'keep.md', '# Keep');

    const result = runWikiBuildCli(vault.path, ['scan', '--max-dir-entries', '3', '--json']);
    assert.equal(result.status, 0);
    assert.deepEqual(readInventory(vault.path).map((record: { path: string }) => record.path), ['keep.md']);
    assert.ok(result.json.data.errors.some((error: { code: string }) => error.code === 'DIRECTORY_LIMIT'));
    vault.cleanup();
  });

  it('keeps the full inventory when scanning explicit ingest candidates', () => {
    const vault = makeVault();
    writeFile(vault.path, 'keep.md', '# Keep');
    writeFile(vault.path, 'candidate.md', '# Candidate');
    assert.equal(runWikiBuildCli(vault.path, ['scan', '--json']).status, 0);
    const inventoryPath = join(vault.path, '.molio', 'wiki-build', 'inventory.jsonl');
    const frozenInventory = readFileSync(inventoryPath, 'utf8');

    const result = runWikiBuildCli(vault.path, ['scan', '--include', 'candidate.md', '--json']);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(inventoryPath, 'utf8'), frozenInventory);
    const candidates = readFileSync(join(vault.path, '.molio', 'wiki-build', 'ingest-candidate.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(candidates.map((record: { path: string }) => record.path), ['candidate.md']);
    vault.cleanup();
  });

  it('skips explicit includes under pruned ancestors', () => {
    const vault = makeVault();
    writeFile(vault.path, 'wiki/old.md', '# Old');
    writeFile(vault.path, '.molio/private.md', '# Private');
    writeFile(vault.path, 'node_modules/example/index.md', '# Dependency');

    const result = runWikiBuildCli(vault.path, [
      'scan', '--include', 'wiki/old.md', '--include', '.molio/private.md',
      '--include', 'node_modules/example/index.md', '--json',
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.json.data.counts.total, 0);
    assert.equal(result.json.data.errors.filter((error: { code: string }) => error.code === 'PRUNED_PATH').length, 3);
    assert.equal(readFileSync(join(vault.path, '.molio', 'wiki-build', 'ingest-candidate.jsonl'), 'utf8'), '');
    vault.cleanup();
  });

  it('records inaccessible includes and continues scanning other candidates', () => {
    const vault = makeVault();
    writeFile(vault.path, 'candidate.md', '# Candidate');

    const result = runWikiBuildCli(vault.path, [
      'scan', '--include', 'missing.md', '--include', 'candidate.md', '--json',
    ]);
    assert.equal(result.status, 0);
    assert.ok(result.json.data.errors.some((error: { code: string }) => error.code === 'INCLUDE_READ_FAILED'));
    const candidates = readFileSync(join(vault.path, '.molio', 'wiki-build', 'ingest-candidate.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(candidates.map((record: { path: string }) => record.path), ['candidate.md']);
    vault.cleanup();
  });
});
