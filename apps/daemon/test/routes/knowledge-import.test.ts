/**
 * Import API route tests.
 *
 * Coverage:
 * - Single/multi-file import to root and subdirectories
 * - Unsupported format errors (non-blocking)
 * - 50MB size guard (413)
 * - Illegal filename chars
 * - Protected directory rejection (wiki/, docling_output/)
 * - conflict: rename / skip / replace / ask strategies
 * - Recursive intermediate directory creation
 * - Internal rename: protected-dir guards
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Hono } from 'hono';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { VaultWatcher } from '../../src/core/vault-watcher.js';

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

function makeFormData(fields: Record<string, string | File | File[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      value.forEach((f) => fd.append(key, f));
    } else {
      fd.append(key, value);
    }
  }
  return fd;
}

function makeFile(name: string, content: string | Buffer): File {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  return new File([buf], name);
}

describe('Knowledge routes — file import', () => {
  let app: Hono;
  let vaultDir: string;
  let tempDir: string;
  let vaultId: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-import-test-'));
    vaultDir = join(tempDir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    const db = openDatabase(tempDir);
    const rm = new RunManager();
    const vw = new VaultWatcher(db);
    app = knowledgeRoutes(db, rm, vw);
    // Mount the routes under /api/knowledge to match URL construction
    const root = new Hono();
    root.route('/api/knowledge', app);
    app = root;
    const vault = createVault(db, 'test', vaultDir, '');
    vaultId = vault.id;
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── basic import ───

  it('imports a single file to vault root', async () => {
    const fd = makeFormData({ files: [makeFile('hello.md', '# Hello')] });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 200);
    const data = await json(res);
    const imported = data['imported'] as string[];
    assert.deepEqual(imported, ['hello.md']);
    const errors = data['errors'] as unknown[];
    assert.equal(errors.length, 0);
    assert.ok(existsSync(join(vaultDir, 'hello.md')));
  });

  it('imports multiple files', async () => {
    const fd = makeFormData({
      files: [makeFile('a.md', '# A'), makeFile('b.txt', 'B')],
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 200);
    const data = await json(res);
    const imported = data['imported'] as string[];
    assert.equal(imported.length, 2);
  });

  // ─── targetDir ───

  it('imports to a subdirectory (creates dirs recursively)', async () => {
    const fd = makeFormData({
      files: [makeFile('notes.md', '# Notes')],
      targetDir: 'raw/sub',
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 200);
    const data = await json(res);
    const imported = data['imported'] as string[];
    assert.ok(imported[0]!.startsWith('raw/sub/'));
    assert.ok(existsSync(join(vaultDir, 'raw', 'sub', 'notes.md')));
  });

  // ─── unsupported format ───

  it('records unsupported format in errors, does not block other files', async () => {
    const fd = makeFormData({
      files: [makeFile('good.md', '# Good'), makeFile('virus.exe', Buffer.alloc(10))],
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 200);
    const data = await json(res);
    const imported = data['imported'] as string[];
    assert.equal(imported.length, 1);
    const errors = data['errors'] as Array<{ file: string; reason: string }>;
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.file, 'virus.exe');
    assert.equal(errors[0]!.reason, 'unsupported_format');
  });

  // ─── size guard ───

  it('returns 413 when Content-Length exceeds 50MB', async () => {
    const fd = new FormData();
    fd.append('files', new File([Buffer.alloc(100)], 'huge.bin'));
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
      headers: { 'Content-Length': String(51 * 1024 * 1024) },
    });
    const res = await app.request(req);
    assert.equal(res.status, 413);
  });

  // ─── illegal chars ───

  it('rejects filenames with illegal characters', async () => {
    const fd = makeFormData({ files: [makeFile('bad:file.md', '# Bad')] });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 200);
    const data = await json(res);
    const errors = data['errors'] as Array<{ file: string; reason: string }>;
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.reason, 'illegal_chars');
  });

  // ─── protected dirs ───

  it('rejects import into wiki/ directory', async () => {
    mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    const fd = makeFormData({
      files: [makeFile('intruder.md', '# Intruder')],
      targetDir: 'wiki',
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 400);
  });

  it('rejects import into docling_output/ directory', async () => {
    mkdirSync(join(vaultDir, 'docling_output'), { recursive: true });
    const fd = makeFormData({
      files: [makeFile('intruder.md', '# Intruder')],
      targetDir: 'docling_output',
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 400);
  });

  // ─── conflict strategies ───

  it('conflict: rename — appends (1) suffix', async () => {
    writeFileSync(join(vaultDir, 'dup.md'), 'original');
    const fd = makeFormData({
      files: [makeFile('dup.md', 'duplicate')],
      conflict: 'rename',
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 200);
    const data = await json(res);
    const renamed = data['renamed'] as Array<{ from: string; to: string }>;
    assert.equal(renamed.length, 1);
    assert.equal(renamed[0]!.to, 'dup (1).md');
    assert.ok(existsSync(join(vaultDir, 'dup (1).md')));
  });

  it('conflict: skip — does not overwrite', async () => {
    writeFileSync(join(vaultDir, 'keep.md'), 'original');
    const fd = makeFormData({
      files: [makeFile('keep.md', 'new')],
      conflict: 'skip',
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 200);
    const data = await json(res);
    const skipped = data['skipped'] as string[];
    assert.equal(skipped.length, 1);
    assert.equal(readFileSync(join(vaultDir, 'keep.md'), 'utf-8'), 'original');
  });

  it('conflict: replace — overwrites existing file', async () => {
    writeFileSync(join(vaultDir, 'replace.md'), 'original');
    const fd = makeFormData({
      files: [makeFile('replace.md', 'new content')],
      conflict: 'replace',
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 200);
    assert.equal(readFileSync(join(vaultDir, 'replace.md'), 'utf-8'), 'new content');
  });

  it('conflict: ask — returns 409 with conflict list', async () => {
    writeFileSync(join(vaultDir, 'existing.md'), 'original');
    const fd = makeFormData({
      files: [makeFile('existing.md', 'new'), makeFile('new.md', '# New')],
      conflict: 'ask',
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 409);
    const data = await json(res);
    const errors = data['errors'] as Array<{ file: string; reason: string }>;
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.reason, 'conflict');
  });

  it('conflict: ask — returns 200 when no conflicts exist', async () => {
    const fd = makeFormData({
      files: [makeFile('unique.md', '# Unique')],
      conflict: 'ask',
    });
    const req = new Request(`http://localhost/api/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: fd,
    });
    const res = await app.request(req);
    assert.equal(res.status, 200);
  });

  // ─── protected-dir rename guard ───

  it('rename: rejects moving file out of wiki/', async () => {
    mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    writeFileSync(join(vaultDir, 'wiki', 'page.md'), '# Wiki Page');
    const req = new Request(
      `http://localhost/api/knowledge/vaults/${vaultId}/files/wiki/page.md`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPath: 'page.md' }),
      },
    );
    const res = await app.request(req);
    assert.equal(res.status, 400);
  });

  it('rename: rejects moving file into wiki/', async () => {
    writeFileSync(join(vaultDir, 'normal.md'), '# Normal');
    mkdirSync(join(vaultDir, 'wiki'), { recursive: true });
    const req = new Request(
      `http://localhost/api/knowledge/vaults/${vaultId}/files/normal.md`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPath: 'wiki/normal.md' }),
      },
    );
    const res = await app.request(req);
    assert.equal(res.status, 400);
  });
});
