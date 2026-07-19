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

function prepare(vaultPath: string, records: object[], policy: object, external?: object[], batch?: object, options?: { chunk?: boolean }) {
  const paths = workspaceModule.resolveBuildPaths(vaultPath);
  return preprocessModule.prepareWorkItems({
    paths,
    batch: batch ?? { id: 'topic-001', attemptToken: 'attempt-001', fileIds: records.map((record: any) => record.id) },
    inputManifest: { files: records },
    policy,
    external,
    chunk: options?.chunk ?? false,
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
    }, undefined, undefined, { chunk: true });
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
    const result = await prepare(vault.path, [record], { maxInputTokens: 80, jsonlMaxLines: 10 }, undefined, undefined, { chunk: true });
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
      prepare(vault.path, [record], { maxInputTokens: 80 }, undefined, undefined, { chunk: true }),
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
      fieldPolicy: { approved: true, fields: ['safe', 'count'] },
    }, undefined, undefined, { chunk: true });
    assert.match(result.workItems[0].content, /safe: object/);
    assert.match(result.workItems[0].content, /count: number/);
    assert.doesNotMatch(result.workItems[0].content, /x{20}/);
    vault.cleanup();
  });

  it('streams nested JSON strings safely and summarizes only approved top-level fields', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'nested.json', `{"safe":{"nested":"}\\\""},"count":2,"ignored":"${'x'.repeat(300)}"}`);
    const result = await prepare(vault.path, [record], {
      maxInputTokens: 80,
      fieldPolicy: { approved: true, fields: ['safe', 'count'] },
    }, undefined, undefined, { chunk: true });
    assert.match(result.workItems[0].content, /^safe: object\ncount: number$/);
    vault.cleanup();
  });

  it('rejects a non-explicit field policy for large JSON', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'large.json', JSON.stringify({ safe: 'x'.repeat(300) }));
    await assert.rejects(
      prepare(vault.path, [record], { maxInputTokens: 80, fieldPolicy: { fields: ['safe'] } }, undefined, undefined, { chunk: true }),
      (error: any) => error.code === 'JSON_FIELD_POLICY_INVALID',
    );
    vault.cleanup();
  });

  it('rejects trailing non-whitespace after a streamed JSON root object', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'invalid.json', `{"safe":"${'x'.repeat(300)}"} trailing`);
    await assert.rejects(
      prepare(vault.path, [record], {
        maxInputTokens: 80,
        fieldPolicy: { approved: true, fields: ['safe'] },
      }, undefined, undefined, { chunk: true }),
      (error: any) => error.code === 'JSON_INVALID',
    );
    vault.cleanup();
  });

  it('keeps fallback chunks on UTF-8 and UTF-16 character boundaries', () => {
    const source = 'A😀中BCDEF';
    const chunks = preprocessModule.chunkPlainText(source, {
      maxInputTokens: 2, fallbackWindowChars: 3, overlapChars: 1,
    });
    const bytes = Buffer.from(source, 'utf8');
    for (const chunk of chunks) {
      assert.doesNotMatch(chunk.content, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
      assert.equal(bytes.subarray(chunk.byteStart, chunk.byteEnd).toString('utf8'), chunk.content);
    }
  });

  it('tracks mixed JSONL newline byte ranges while streaming', async () => {
    const vault = makeVault();
    const contents = '{"a":1}\r\n{"b":2}\n{"c":3}\r\n';
    const record = fixtureFile(vault.path, 'mixed.jsonl', contents);
    const result = await prepare(vault.path, [record], { maxInputTokens: 80, jsonlMaxLines: 1 }, undefined, undefined, { chunk: true });
    const bytes = Buffer.from(contents, 'utf8');
    for (const item of result.workItems) {
      assert.equal(bytes.subarray(item.byteStart, item.byteEnd).toString('utf8'), item.content);
    }
    vault.cleanup();
  });

  it('rejects unsafe batch path segments before writing prepared output', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'notes.md', '# Safe');
    await assert.rejects(
      prepare(vault.path, [record], { maxInputTokens: 80 }, undefined, {
        id: '../injected', attemptToken: 'attempt-001', fileIds: [record.id],
      }),
      (error: any) => error.code === 'PREPARE_ARGUMENT_INVALID',
    );
    vault.cleanup();
  });

  it('chunks external normalized Markdown by its normalized extension', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'report.pptx', 'source bytes', 'docling');
    const paths = workspaceModule.resolveBuildPaths(vault.path);
    mkdirSync(paths.normalized, { recursive: true });
    const normalized = join(paths.normalized, 'report.md');
    writeFileSync(normalized, '# Normalized heading\n' + 'x'.repeat(300), 'utf8');
    const result = await prepare(vault.path, [record], { maxInputTokens: 60 }, [{
      fileId: record.id, sourcePath: record.path, normalizedPath: normalized,
      processor: 'docling', processorVersion: '2.x',
    }], undefined, { chunk: true });
    assert.equal(result.workItems[0].heading, 'Normalized heading');
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

  it('returns file-level work items by default without chunking', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'notes.md', '# Heading\nSome content here');
    const result = await prepare(vault.path, [record], { maxInputTokens: 20000 });
    assert.equal(result.strategy, 'file-level');
    assert.equal(result.workItems.length, 1);
    assert.equal(result.workItems[0].fileId, record.id);
    assert.equal(result.workItems[0].path, 'notes.md');
    assert.ok(result.workItems[0].contentHash);
    assert.ok(result.workItems[0].estimatedTokens > 0);
    assert.equal(result.workItems[0].tooLarge, false);
    vault.cleanup();
  });

  it('marks oversized files as tooLarge in file-level mode', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'big.md', 'x'.repeat(300));
    const result = await prepare(vault.path, [record], { maxInputTokens: 10 });
    assert.equal(result.workItems.length, 1);
    assert.equal(result.workItems[0].tooLarge, true);
    vault.cleanup();
  });

  it('chunks oversized files when chunk option is true', async () => {
    const vault = makeVault();
    const record = fixtureFile(vault.path, 'big.md', '# Title\n' + 'x'.repeat(300));
    const result = await prepare(vault.path, [record], {
      maxInputTokens: 30, fallbackWindowChars: 60, overlapChars: 6,
    }, undefined, undefined, { chunk: true });
    assert.ok(result.workItems.length > 1);
    assert.ok(result.workItems.every((item: any) => item.estimatedTokens <= 30));
    vault.cleanup();
  });
});
