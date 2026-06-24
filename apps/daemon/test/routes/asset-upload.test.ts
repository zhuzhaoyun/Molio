import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';

/**
 * Asset upload route tests — image paste feature (Task 1).
 *
 * Coverage:
 * - Vault not found → 404
 * - Non-image MIME types → 400
 * - Successful PNG upload → 201 with correct filePath + url
 * - Oversized file (Content-Length > 50MB) → 413
 */

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

/** Minimal valid 1x1 PNG image bytes */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xD7, 0x63, 0x68, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
  0xAE, 0x42, 0x60, 0x82,
]);

/** Build a multipart/form-data body for a file upload */
function buildMultipartBody(
  fieldName: string,
  fileName: string,
  contentType: string,
  fileBytes: Uint8Array,
): { body: Uint8Array; boundary: string } {
  const boundary = '----MolioTestBoundary';
  const CRLF = '\r\n';
  const encoder = new TextEncoder();

  const parts: Uint8Array[] = [];

  // Part header
  const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"${CRLF}Content-Type: ${contentType}${CRLF}${CRLF}`;
  parts.push(encoder.encode(header));

  // File bytes
  parts.push(fileBytes);

  // Closing boundary
  parts.push(encoder.encode(`${CRLF}--${boundary}--${CRLF}`));

  // Concatenate all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return { body: result, boundary };
}

describe('Asset upload routes', () => {
  let app: Hono;
  let vaultDir: string;
  let tempDir: string;
  let vaultId: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-asset-test-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'molio-asset-vault-'));
    const db = openDatabase(tempDir);
    const vault = createVault(db, 'test-vault', vaultDir);
    vaultId = vault.id;
    // Mount sub-app at /api/knowledge
    const root = new Hono();
    root.route('/api/knowledge', knowledgeRoutes(db, new RunManager()));
    app = root;
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  // ─── Test 1: Vault not found → 404 ───

  it('should return 404 when vault not found', async () => {
    const { body, boundary } = buildMultipartBody(
      'file',
      'test.png',
      'image/png',
      PNG_BYTES,
    );

    const res = await app.request('/api/knowledge/vaults/non-existent/assets/upload', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    assert.equal(res.status, 404);
    const data = await json(res);
    assert.equal((data['error'] as Record<string, unknown>)?.['code'], 'NOT_FOUND');
  });

  // ─── Test 2: Non-image file type → 400 ───

  it('should reject non-image file types with 400', async () => {
    const textBytes = new TextEncoder().encode('hello world');
    const { body, boundary } = buildMultipartBody(
      'file',
      'test.txt',
      'text/plain',
      textBytes,
    );

    const res = await app.request(`/api/knowledge/vaults/${vaultId}/assets/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    assert.equal(res.status, 400);
    const data = await json(res);
    assert.equal((data['error'] as Record<string, unknown>)?.['code'], 'BAD_REQUEST');
  });

  // ─── Test 3: Successful PNG upload → 201 ───

  it('should upload a PNG image successfully and return 201', async () => {
    const { body, boundary } = buildMultipartBody(
      'file',
      'test.png',
      'image/png',
      PNG_BYTES,
    );

    const res = await app.request(`/api/knowledge/vaults/${vaultId}/assets/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    assert.equal(res.status, 201);
    const data = await json(res);

    // Verify filePath
    const filePath = data['filePath'] as string;
    assert.ok(filePath, 'filePath should be present');
    assert.ok(filePath.startsWith('.molio/assets/'), `filePath should start with .molio/assets/, got: ${filePath}`);
    assert.ok(filePath.endsWith('.png'), `filePath should end with .png, got: ${filePath}`);

    // Verify URL
    const url = data['url'] as string;
    assert.ok(url, 'url should be present');
    assert.ok(url.startsWith('/api/knowledge/'), `url should start with /api/knowledge/, got: ${url}`);
    assert.ok(url.includes('/raw/'), `url should contain /raw/, got: ${url}`);
    assert.ok(url.endsWith('.png'), `url should end with .png, got: ${url}`);

    // Verify file exists on disk with correct bytes
    const absPath = join(vaultDir, filePath);
    assert.ok(existsSync(absPath), `File should exist at ${absPath}`);
    const diskBytes = readFileSync(absPath);
    assert.deepEqual(diskBytes, Buffer.from(PNG_BYTES));
  });

  // ─── Test 4: Oversized file → 413 ───

  it('should reject oversized files with 413', async () => {
    const { body, boundary } = buildMultipartBody(
      'file',
      'large.png',
      'image/png',
      PNG_BYTES,
    );

    // Fake Content-Length to exceed 50 MB
    const fauxSize = 51 * 1024 * 1024 + 1; // 51 MB + 1 byte

    const res = await app.request(`/api/knowledge/vaults/${vaultId}/assets/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(fauxSize),
      },
      body,
    });

    assert.equal(res.status, 413);
    const data = await json(res);
    assert.equal((data['error'] as Record<string, unknown>)?.['code'], 'PAYLOAD_TOO_LARGE');
  });

  // ─── Test 5: No file field → 400 ───

  it('should return 400 when no file is provided', async () => {
    const boundary = '----MolioTestBoundary';
    const encoder = new TextEncoder();
    // Multipart body without a "file" field — just a text field
    const body = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nvalue\r\n--${boundary}--\r\n`,
    );

    const res = await app.request(`/api/knowledge/vaults/${vaultId}/assets/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    assert.equal(res.status, 400);
    const data = await json(res);
    assert.equal((data['error'] as Record<string, unknown>)?.['code'], 'BAD_REQUEST');
  });
});
