import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractOutboundMedia } from '../../../src/core/channels/outbound-media.js';

/**
 * Path-traversal protection for `<attach/>` markers: the AI is driven by
 * inbound IM text, so a malicious message could try to trick it into emitting
 * `<attach path="../../.ssh/id_rsa"/>` to exfiltrate files outside the project
 * cwd. The dispatcher must reject such markers without delivering the file.
 */
describe('extractOutboundMedia — path traversal', () => {
  let cwd: string;
  let secretDir: string;
  let secretPath: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'molio-outbound-cwd-'));
    // Sibling directory outside cwd — simulates ~/.ssh/ or another secret.
    secretDir = mkdtempSync(join(tmpdir(), 'molio-outbound-secret-'));
    secretPath = join(secretDir, 'secret.key');
    writeFileSync(secretPath, 'ssh-secret');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  });

  it('rejects a `..` traversal that escapes cwd', () => {
    const marker = `<attach path="../../${basename(secretDir)}/secret.key"/>`;
    // Note: the test deliberately constructs the marker from cwd's parent, so
    // the resolved path lands in secretDir (outside cwd).
    const rel = relativePathToSibling(cwd, secretPath);
    const text = `已附上文件。<attach path="${rel}"/>`;
    const { items, text: clean } = extractOutboundMedia(text, cwd);
    assert.equal(items.length, 0, 'traversal marker must not produce a deliverable');
    // Marker still stripped from text so the IM channel never sees the path.
    assert.ok(!clean.includes(rel));
  });

  it('delivers a file referenced by absolute path inside cwd', () => {
    const sub = join(cwd, 'reports');
    mkdirSync(sub, { recursive: true });
    const pdfPath = join(sub, 'report.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 body');
    const text = `已生成。<attach path="${pdfPath}"/>`;
    const { items } = extractOutboundMedia(text, cwd);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.filePath, pdfPath);
  });

  // Helper: build a `..`-prefixed relative path from cwd to an absolute target.
  function relativePathToSibling(fromDir: string, toAbsPath: string): string {
    const parts = toAbsPath.split(/[\\/]/);
    const cwdParts = fromDir.split(/[\\/]/);
    // Strip common prefix.
    let i = 0;
    while (i < parts.length && i < cwdParts.length && parts[i] === cwdParts[i]) i++;
    const ups = cwdParts.length - i;
    const rel = [...Array(ups).fill('..'), ...parts.slice(i)].join('/');
    return rel;
  }

  function basename(p: string): string {
    return p.split(/[\\/]/).pop() ?? '';
  }
});
