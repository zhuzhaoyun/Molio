import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanTree,
  readFile,
  resolveCanonicalPath,
  writeFile,
  deleteFile,
  renamePath,
  deleteDirectory,
  createDirectory,
  importFiles,
} from '../../src/core/knowledge.js';
import { createDirectoryLink, removeDirectoryLink } from '../../src/core/external-roots.js';

function setup() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
  fs.writeFileSync(path.join(ext, 'mem.md'), '# memory');
  fs.mkdirSync(path.join(vault, 'external'), { recursive: true });
  createDirectoryLink(ext, path.join(vault, 'external', 'AgentA'));
  return { vault, ext };
}

const find = (nodes: any[], p: string): any =>
  nodes.some((n) => n.path === p) ? nodes.find((n) => n.path === p)
  : nodes.reduce((acc, n) => acc ?? (n.children ? find(n.children, p) : undefined), undefined);

describe('scanTree follows external-root links', () => {
  it('shows mounted content as external/<label>/...', () => {
    const { vault, ext } = setup();
    const tree = scanTree(vault, '', { externalRoots: [{ label: 'AgentA', target: fs.realpathSync(ext) }] });
    assert.ok(find(tree, 'external/AgentA/mem.md'), 'mounted file should appear');
  });

  it('hides the link when it is not a registered root', () => {
    const { vault } = setup();
    const tree = scanTree(vault); // no roots → link is unregistered
    assert.equal(find(tree, 'external/AgentA/mem.md'), undefined);
  });

  it('does not diverge when the link target is missing', () => {
    const { vault, ext } = setup();
    // removeDirectoryLink, not rmSync: it is the cross-platform "delete the link,
    // never the target" primitive (Windows junctions reject a plain unlink).
    removeDirectoryLink(path.join(vault, 'external', 'AgentA'));
    fs.rmSync(ext, { recursive: true });
    const tree = scanTree(vault, '', { externalRoots: [{ label: 'AgentA', target: ext }] });
    assert.equal(find(tree, 'external/AgentA'), undefined);
  });

  // Dangling link: the entry still exists on disk (lstat succeeds) but its target
  // is gone, so realpathSync throws. Must skip, never throw out of scanTree.
  it('skips a dangling link instead of failing the scan', () => {
    const { vault, ext } = setup();
    fs.rmSync(ext, { recursive: true });
    assert.doesNotThrow(() => fs.lstatSync(path.join(vault, 'external', 'AgentA')));
    const tree = scanTree(vault, '', { externalRoots: [{ label: 'AgentA', target: ext }] });
    assert.equal(find(tree, 'external/AgentA'), undefined);
  });

  // Second-hop escape: the mount itself is whitelisted, so only the REALPATH of a
  // nested link can expose the escape. withinBoundary compares the path it is
  // handed verbatim — this pins that we resolve the link before asking.
  it('stays invisible when a link inside a root points outside the whitelist', () => {
    const { vault, ext } = setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-out-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), '# secret');
    createDirectoryLink(fs.realpathSync(outside), path.join(ext, 'sneak'));
    const tree = scanTree(vault, '', { externalRoots: [{ label: 'AgentA', target: fs.realpathSync(ext) }] });
    assert.equal(find(tree, 'external/AgentA/sneak/secret.md'), undefined);
    assert.ok(find(tree, 'external/AgentA/mem.md'), 'sibling content must still render');
  });

  // A link back to an already-entered root is a pure duplicate of the mount, so
  // it must be cut — otherwise the walk descends until the OS raises ELOOP.
  it('terminates when a root contains a link back to itself', () => {
    const { vault, ext } = setup();
    createDirectoryLink(fs.realpathSync(ext), path.join(ext, 'loop'));
    const tree = scanTree(vault, '', { externalRoots: [{ label: 'AgentA', target: fs.realpathSync(ext) }] });
    assert.ok(find(tree, 'external/AgentA/mem.md'), 'cycle must not abort the scan');
    assert.equal(find(tree, 'external/AgentA/loop'), undefined);
  });
});

// The tree lists mounted files as `external/<label>/...`; reading has to accept
// that virtual path and then prove the real file is inside the whitelist.
describe('external reads', () => {
  const rootsFor = (ext: string) => [{ label: 'AgentA', target: fs.realpathSync(ext) }];

  it('reads a mounted file through the virtual path', () => {
    const { vault, ext } = setup();
    const file = readFile(vault, 'external/AgentA/mem.md', { externalRoots: rootsFor(ext) });
    assert.equal(file.content, '# memory');
    // response echoes the caller's path (same contract as in-vault reads)
    assert.equal(file.path, 'external/AgentA/mem.md');
  });

  it('rejects an unregistered external path', () => {
    const { vault } = setup();
    assert.throws(
      () => readFile(vault, 'external/AgentA/mem.md', { externalRoots: [] }),
      /Path traversal|not found/i,
    );
  });

  // No registry == pre-feature behaviour: the namespace is not readable at all.
  it('rejects the virtual namespace when no roots are passed', () => {
    const { vault } = setup();
    assert.throws(() => readFile(vault, 'external/AgentA/mem.md'), /Path traversal|not found/i);
  });

  it('still reports a missing file inside a registered root as not found', () => {
    const { vault, ext } = setup();
    assert.throws(
      () => readFile(vault, 'external/AgentA/nope.md', { externalRoots: rootsFor(ext) }),
      { code: 'ENOENT' },
    );
  });

  // Second-hop escape: the mount itself is whitelisted, so only the REALPATH of a
  // nested link can expose the escape — withinBoundary compares verbatim.
  it('refuses to read through a link nested inside a root that escapes it', () => {
    const { vault, ext } = setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-out-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), '# secret');
    createDirectoryLink(fs.realpathSync(outside), path.join(ext, 'sneak'));
    assert.throws(
      () => readFile(vault, 'external/AgentA/sneak/secret.md', { externalRoots: rootsFor(ext) }),
      /Path traversal/,
    );
  });

  // `..` inside the virtual path must not walk out of the registered target,
  // even when the escaped-to file genuinely exists.
  it('refuses a `..` escape out of the registered target', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-parent-'));
    const ext = path.join(parent, 'inner');
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(ext, 'mem.md'), '# memory');
    fs.writeFileSync(path.join(parent, 'secret.md'), '# secret');
    fs.mkdirSync(path.join(vault, 'external'), { recursive: true });
    createDirectoryLink(fs.realpathSync(ext), path.join(vault, 'external', 'AgentA'));
    assert.throws(
      () => readFile(vault, 'external/AgentA/../secret.md', { externalRoots: rootsFor(ext) }),
      /Path traversal/,
    );
    assert.equal(readFile(vault, 'external/AgentA/mem.md', { externalRoots: rootsFor(ext) }).content, '# memory');
  });
});

// resolveCanonicalPath backs "open from an assistant link / molio:// / wiki
// link", so it needs the same virtual-path support as readFile.
describe('resolveCanonicalPath in the external namespace', () => {
  it('returns the virtual path for a mounted file', () => {
    const { vault, ext } = setup();
    assert.equal(
      resolveCanonicalPath(vault, 'external/AgentA/mem.md', [{ label: 'AgentA', target: fs.realpathSync(ext) }]),
      'external/AgentA/mem.md',
    );
  });

  it('returns null without the root registry', () => {
    const { vault } = setup();
    assert.equal(resolveCanonicalPath(vault, 'external/AgentA/mem.md'), null);
  });

  it('returns null when the target file is gone', () => {
    const { vault, ext } = setup();
    fs.rmSync(ext, { recursive: true });
    assert.equal(
      resolveCanonicalPath(vault, 'external/AgentA/mem.md', [{ label: 'AgentA', target: ext }]),
      null,
    );
  });
});

// Read-only guarantee: the mount is a link into a folder Molio does not own, so
// every mutation touching the namespace is refused before it reaches disk.
describe('external namespace is read-only', () => {
  it('refuses to write a file under external/', () => {
    const { vault } = setup();
    assert.throws(
      () => writeFile(vault, 'external/AgentA/new.md', 'x'),
      { code: 'E_EXTERNAL_READONLY', message: /read-only/i },
    );
  });

  it('refuses the external/ mount directory itself', () => {
    const { vault } = setup();
    assert.throws(() => writeFile(vault, 'external', 'x'), { code: 'E_EXTERNAL_READONLY' });
    assert.throws(() => createDirectory(vault, 'external'), { code: 'E_EXTERNAL_READONLY' });
  });

  it('refuses to delete a mounted file or directory', async () => {
    const { vault } = setup();
    await assert.rejects(() => deleteFile(vault, 'external/AgentA/mem.md'), { code: 'E_EXTERNAL_READONLY' });
    await assert.rejects(() => deleteDirectory(vault, 'external/AgentA'), { code: 'E_EXTERNAL_READONLY' });
    // the link target survives — the rejection happens before the trash call
    assert.equal(await fs.promises.readFile(path.join(vault, 'external', 'AgentA', 'mem.md'), 'utf-8'), '# memory');
  });

  it('refuses to rename within the namespace', () => {
    const { vault } = setup();
    assert.throws(
      () => renamePath(vault, 'external/AgentA/mem.md', 'external/AgentA/m2.md'),
      { code: 'E_EXTERNAL_READONLY' },
    );
  });

  it('refuses to move a vault file into the namespace', () => {
    const { vault } = setup();
    writeFile(vault, 'note.md', 'hi');
    assert.throws(
      () => renamePath(vault, 'note.md', 'external/AgentA/note.md'),
      { code: 'E_EXTERNAL_READONLY' },
    );
    // the source file was not touched
    assert.equal(readFile(vault, 'note.md').content, 'hi');
  });

  it('refuses to create a directory inside the namespace', () => {
    const { vault } = setup();
    assert.throws(() => createDirectory(vault, 'external/AgentB'), { code: 'E_EXTERNAL_READONLY' });
  });

  // The guard keys off the path STRING, so an obfuscated form must not slip
  // through: `path.resolve` (used by every write) collapses these to the mount.
  it('sees through `..` / `./` obfuscation of the namespace', () => {
    const { vault } = setup();
    assert.throws(() => writeFile(vault, 'notes/../external/AgentA/new.md', 'x'), { code: 'E_EXTERNAL_READONLY' });
    assert.throws(() => writeFile(vault, './external/AgentA/new.md', 'x'), { code: 'E_EXTERNAL_READONLY' });
    assert.throws(() => writeFile(vault, 'external\\AgentA\\new.md', 'x'), { code: 'E_EXTERNAL_READONLY' });
  });

  // No false positives: `..` inside an ordinary vault path still writes.
  it('leaves `..` inside the vault alone', () => {
    const { vault } = setup();
    createDirectory(vault, 'notes');
    writeFile(vault, 'notes/../top.md', 'hi');
    assert.equal(readFile(vault, 'top.md').content, 'hi');
  });
});

// importFiles collects per-file errors instead of throwing (it is a bulk API);
// it must report the namespace target rather than writing into the mount.
describe('importFiles rejects the external namespace', () => {
  it('reports external_readonly and writes nothing', () => {
    const { vault, ext } = setup();
    const res = importFiles(vault, [{ name: 'new.md', buffer: Buffer.from('x') }], 'external/AgentA', 'skip');
    assert.deepEqual(res.imported, []);
    assert.deepEqual(res.errors, [{ file: 'new.md', reason: 'external_readonly' }]);
    assert.equal(fs.existsSync(path.join(fs.realpathSync(ext), 'new.md')), false);
  });

  it('still imports into a normal vault directory', () => {
    const { vault } = setup();
    const res = importFiles(vault, [{ name: 'new.md', buffer: Buffer.from('x') }], 'notes', 'skip');
    assert.deepEqual(res.imported, ['notes/new.md']);
    assert.equal(readFile(vault, 'notes/new.md').content, 'x');
  });
});
