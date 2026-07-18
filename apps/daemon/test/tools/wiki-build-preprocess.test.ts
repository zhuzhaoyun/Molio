import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeVault } from './wiki-build-test-helpers.js';

const daemonRoot = resolve(import.meta.dirname, '..', '..', '..');
const preprocessModule = await import(pathToFileURL(join(
  daemonRoot, 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'preprocess.mjs',
)).href);
const workspaceModule = await import(pathToFileURL(join(
  daemonRoot, 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'workspace.mjs',
)).href);

function fixtureFile(vaultPath: string, relativePath: string, contents: string, processor = 'text') {
  const source = join(vaultPath, relativePath);
  mkdirSync(join(source, '..'), { recursive: true });
  writeFileSync(source, contents, 'utf8');
  return { id: `file-${relativePath}`, path: relativePath, extension: `.${relativePath.split('.').pop()}`, processor };
}

function prepare(vaultPath: string, records: object[], policy: object, external?: object[]) {
  const paths = workspaceModule.resolveBuildPaths(vaultPath);
  return preprocessModule.prepareWorkItems({
    paths,
    batch: { id: 'topic-001', attemptToken: 'attempt-001', fileIds: records.map((record: any) => record.id) },
    inputManifest: { files: records },
    policy,
    external,
  });
}

describe('wiki-build preprocess', () => {
  it('prioritizes Markdown headings before bounded overlap windows', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'notes.md', [
      '# One', 'a'.repeat(120), '# Two', 'b'.repeat(120),
    ].join('\n'));
    const result = await prepare(vault.path, [record], {
      maxInputTokens: 60, fallbackWindowChars: 120, overlapChars: 12,
    });
    assert.ok(result.workItems.length >= 2);
    assert.equal(result.workItems[0].heading, 'One');
    assert.equal(result.workItems[1].heading, 'Two');
    assert.ok(result.workItems.every((item: any) => item.estimatedTokens <= 60));
    vault.cleanup();
  });

  it('streams JSONL into bounded chunks', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'events.jsonl', Array.from(
      { length: 100 }, (_, index) => JSON.stringify({ index, text: 'event'.repeat(10) }),
    ).join('\n'));
    const result = await prepare(vault.path, [record], { maxInputTokens: 80, jsonlMaxLines: 10 });
    assert.ok(result.workItems.length > 1);
    assert.equal(result.strategy, 'jsonl-stream');
    assert.ok(result.workItems.every((item: any) => item.byteEnd > item.byteStart));
    assert.ok(result.workItems.every((item: any) => item.estimatedTokens <= 80));
    vault.cleanup();
  });

  it('requires an approved field policy for a large JSON object', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'large.json', JSON.stringify({
      safe: 'x'.repeat(300), secret: { nested: true }, count: 3,
    }));
    await assert.rejects(
      prepare(vault.path, [record], { maxInputTokens: 80 }),
      (error: any) => error.code === 'JSON_FIELD_POLICY_REQUIRED',
    );
    vault.cleanup();
  });

  it('summarizes a policy-approved large JSON object without retaining its values', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'large.json', JSON.stringify({
      safe: { nested: ['value'] }, count: 3, ignored: 'x'.repeat(300),
    }));
    const result = await prepare(vault.path, [record], {
      maxInputTokens: 80,
      fieldPolicy: { fields: ['safe', 'count'] },
    });
    assert.match(result.workItems[0].content, /safe: object/);
    assert.match(result.workItems[0].content, /count: number/);
    assert.doesNotMatch(result.workItems[0].content, /x{20}/);
    vault.cleanup();
  });

  it('leaves sources unchanged and records external normalization hashes', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'report.pptx', 'source bytes', 'docling');
    const paths = workspaceModule.resolveBuildPaths(vault.path);
    mkdirSync(paths.normalized, { recursive: true });
    const normalized = join(paths.normalized, 'report.md');
    writeFileSync(normalized, '# 报告', 'utf8');
    const before = readFileSync(join(vault.path, record.path));
    const result = await prepare(vault.path, [record], { maxInputTokens: 80 }, [{
      fileId: record.id,
      sourcePath: record.path,
      normalizedPath: normalized,
      processor: 'docling',
      processorVersion: '2.x',
    }]);
    assert.deepEqual(readFileSync(join(vault.path, record.path)), before);
    assert.match(result.workItems[0].contentHash, /^[a-f0-9]{64}$/);
    assert.match(result.normalized[0].sourceHash, /^[a-f0-9]{64}$/);
    assert.match(result.normalized[0].normalizedHash, /^[a-f0-9]{64}$/);
    assert.equal(result.normalized[0].processorVersion, '2.x');
    assert.equal(existsSync(join(paths.root, 'prepared', 'topic-001-attempt-001.json')), true);
    vault.cleanup();
  });

  it('rejects normalized paths that escape the workspace', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'report.pdf', 'source bytes', 'docling');
    const escaped = join(vault.path, 'escaped.md');
    writeFileSync(escaped, '# escaped', 'utf8');
    await assert.rejects(
      prepare(vault.path, [record], { maxInputTokens: 80 }, [{
        fileId: record.id, sourcePath: record.path, normalizedPath: escaped,
        processor: 'docling', processorVersion: '2.x',
      }]),
      (error: any) => error.code === 'NORMALIZED_PATH_INVALID',
    );
    vault.cleanup();
  });
});
