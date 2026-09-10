import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  safeRealpath, isWithinRoot, withinBoundary, validateExternalRoot,
  createDirectoryLink, removeDirectoryLink, isExternalMountPath, resolveVirtualToReal,
} from '../../src/core/external-roots.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'molio-ext-')); }

describe('isWithinRoot', () => {
  it('true for self and descendants, false for siblings', () => {
    assert.equal(isWithinRoot('/a/b', '/a/b'), true);
    assert.equal(isWithinRoot('/a/b', '/a/b/c.md'), true);
    assert.equal(isWithinRoot('/a/b', '/a/bc'), false);   // prefix trap
    assert.equal(isWithinRoot('/a/b', '/a'), false);
  });
});

describe('withinBoundary', () => {
  it('allows vault-internal and registered roots, rejects outside', () => {
    const v = fs.realpathSync(tmp());
    const root = fs.realpathSync(tmp());
    assert.equal(withinBoundary(path.join(v, 'x.md'), v, []), true);
    assert.equal(withinBoundary(path.join(root, 'x.md'), v, [{ label: 'R', target: root }]), true);
    assert.equal(withinBoundary('/etc/passwd', v, [{ label: 'R', target: root }]), false);
  });
});

describe('validateExternalRoot', () => {
  it('rejects non-existent target', () => {
    const v = tmp();
    assert.throws(() => validateExternalRoot(v, path.join(v, 'nope'), []), /not exist|不存在/i);
  });
  it('rejects a target that contains the vault', () => {
    const parent = tmp();
    const v = path.join(parent, 'vault'); fs.mkdirSync(v);
    assert.throws(() => validateExternalRoot(v, parent, []), /disjoint|overlap/i);
  });
  it('rejects a target inside the vault', () => {
    const v = tmp();
    const inner = path.join(v, 'inner'); fs.mkdirSync(inner);
    assert.throws(() => validateExternalRoot(v, inner, []), /disjoint|overlap/i);
  });
  it('rejects overlap with an existing root', () => {
    const v = tmp(); const a = tmp();
    fs.mkdirSync(path.join(a, 'sub'));
    assert.throws(() => validateExternalRoot(v, path.join(a, 'sub'), [{ label: 'A', target: a }]), /disjoint|overlap/i);
  });
  it('accepts a valid disjoint target', () => {
    const v = tmp(); const a = tmp();
    assert.doesNotThrow(() => validateExternalRoot(v, a, []));
  });
});

describe('link create/remove + virtual path', () => {
  it('creates a directory link that resolves through', () => {
    const v = tmp(); const target = tmp();
    fs.writeFileSync(path.join(target, 'note.md'), 'hi');
    const link = path.join(v, 'external', 'AgentA');
    fs.mkdirSync(path.join(v, 'external'), { recursive: true });
    createDirectoryLink(target, link);
    assert.equal(fs.readFileSync(path.join(link, 'note.md'), 'utf-8'), 'hi');
    assert.equal(isExternalMountPath('external/AgentA/note.md'), true);
    assert.equal(isExternalMountPath('notes/x.md'), false);
    assert.equal(
      resolveVirtualToReal(v, [{ label: 'AgentA', target: fs.realpathSync(target) }], 'external/AgentA/note.md'),
      path.join(fs.realpathSync(target), 'note.md'),
    );
    assert.equal(resolveVirtualToReal(v, [], 'external/Ghost/x.md'), null);
    removeDirectoryLink(link);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.existsSync(path.join(target, 'note.md')), true); // target untouched
  });
});
