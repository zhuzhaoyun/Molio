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
  searchFiles,
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

  const twinRoots = (ext: string) => [
    { label: 'AgentA', target: fs.realpathSync(ext) },
    { label: 'AgentB', target: fs.realpathSync(ext) },
  ];

  // The cycle guard is a STACK, not a global visited set: it is released when
  // the recursion unwinds. Two sibling links naming the same real folder are
  // two mounts, not a cycle, so both must render — and which one wins must not
  // depend on readdir order.
  it('shows two sibling mounts of the same real folder', () => {
    const { vault, ext } = setup();
    createDirectoryLink(fs.realpathSync(ext), path.join(vault, 'external', 'AgentB'));
    const tree = scanTree(vault, '', { externalRoots: twinRoots(ext) });
    assert.ok(find(tree, 'external/AgentA/mem.md'), 'first mount renders');
    assert.ok(find(tree, 'external/AgentB/mem.md'), 'second mount renders too');
  });

  // Pruning is name-based on the LINK name, so `notes -> <vault>/node_modules`
  // is not caught by the entry-name check — it would be walked straight into
  // the artifact tree vault-prune exists to keep out of the traversal.
  it('hides a link whose real target is a pruned directory', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    fs.mkdirSync(path.join(vault, 'external'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'node_modules', 'dep.md'), '# dep');
    createDirectoryLink(path.join(vault, 'node_modules'), path.join(vault, 'external', 'notes'));
    const tree = scanTree(vault, '', {
      externalRoots: [{ label: 'notes', target: path.join(vault, 'node_modules') }],
    });
    assert.equal(find(tree, 'external/notes'), undefined);
    assert.equal(find(tree, 'external/notes/dep.md'), undefined);
  });
});

// Search is the other traversal of the vault: a mounted folder the tree shows
// but search cannot see would be a silent hole in "search the knowledge base".
describe('searchFiles follows external-root links', () => {
  const rootsFor = (ext: string) => [{ label: 'AgentA', target: fs.realpathSync(ext) }];

  it('finds a text file inside a mounted root', () => {
    const { vault, ext } = setup();
    fs.writeFileSync(path.join(ext, 'note.md'), 'hello needle world');
    const { results } = searchFiles(vault, 'needle', 20, rootsFor(ext));
    assert.deepEqual(results.map((r) => r.filePath), ['external/AgentA/note.md']);
    assert.ok(results[0]!.snippet.includes('needle'));
  });

  // The registry is the whitelist: without it a mount link is just an
  // unregistered symlink and stays invisible, exactly as in scanTree.
  it('does not search a mounted root when no roots are passed', () => {
    const { vault, ext } = setup();
    fs.writeFileSync(path.join(ext, 'note.md'), 'hello needle world');
    assert.deepEqual(searchFiles(vault, 'needle').results, []);
    assert.deepEqual(searchFiles(vault, 'needle', 20, []).results, []);
  });

  it('reports the virtual path, not the link target', () => {
    const { vault, ext } = setup();
    fs.mkdirSync(path.join(ext, 'sub'));
    fs.writeFileSync(path.join(ext, 'sub', 'note.md'), 'needle');
    const { results } = searchFiles(vault, 'needle', 20, rootsFor(ext));
    assert.deepEqual(results.map((r) => r.filePath), ['external/AgentA/sub/note.md']);
  });

  // Same stack-not-set cycle guard as scanTree: two sibling mounts of one real
  // folder are two results, and each is still found exactly once.
  it('searches both of two sibling mounts of the same real folder', () => {
    const { vault, ext } = setup();
    createDirectoryLink(fs.realpathSync(ext), path.join(vault, 'external', 'AgentB'));
    fs.writeFileSync(path.join(ext, 'note.md'), 'needle');
    const { results } = searchFiles(vault, 'needle', 20, [
      { label: 'AgentA', target: fs.realpathSync(ext) },
      { label: 'AgentB', target: fs.realpathSync(ext) },
    ]);
    assert.deepEqual(
      results.map((r) => r.filePath).sort(),
      ['external/AgentA/note.md', 'external/AgentB/note.md'],
    );
  });

  it('does not search a link whose real target is a pruned directory', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    fs.mkdirSync(path.join(vault, 'external'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'node_modules', 'dep.md'), 'needle');
    createDirectoryLink(path.join(vault, 'node_modules'), path.join(vault, 'external', 'notes'));
    const { results } = searchFiles(vault, 'needle', 20, [
      { label: 'notes', target: path.join(vault, 'node_modules') },
    ]);
    assert.deepEqual(results, []);
  });

  // A mount link whose target is a folder of links, one of which escapes the
  // whitelist: only the whitelisted side is searched.
  it('stops at a nested link that leaves the whitelist', () => {
    const { vault, ext } = setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-out-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), 'needle');
    createDirectoryLink(fs.realpathSync(outside), path.join(ext, 'sneak'));
    const { results } = searchFiles(vault, 'needle', 20, rootsFor(ext));
    assert.deepEqual(results, []);
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

  // Unknown label → normal vault resolution; the real mount link is then
  // refused by the realpath boundary (the link target is outside the vault).
  it('rejects an unregistered external path', () => {
    const { vault } = setup();
    assert.throws(
      () => readFile(vault, 'external/AgentA/mem.md', { externalRoots: [] }),
      /Path traversal|not found/i,
    );
  });

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

  // R8: `external/` is only reserved while a mount is registered. With no
  // registry, a genuine folder of that name is an ordinary vault folder and
  // reads exactly as it did before this feature.
  it('reads a plain vault folder named external/ when no root is registered', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    fs.mkdirSync(path.join(vault, 'external', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'external', 'notes', 'real.md'), '# real');
    assert.equal(readFile(vault, 'external/notes/real.md').content, '# real');
    assert.equal(resolveCanonicalPath(vault, 'external/notes/real.md'), 'external/notes/real.md');
  });

  // ...and an unknown label stays an ordinary folder even while ANOTHER label
  // is mounted: the registry miss must not turn into "not found".
  it('still reads a plain folder under external/ when other labels are mounted', () => {
    const { vault, ext } = setup();
    fs.mkdirSync(path.join(vault, 'external', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'external', 'notes', 'real.md'), '# real');
    const roots = rootsFor(ext); // AgentA mounted, `notes` is not
    assert.equal(readFile(vault, 'external/notes/real.md', { externalRoots: roots }).content, '# real');
    assert.equal(
      resolveCanonicalPath(vault, 'external/notes/real.md', roots),
      'external/notes/real.md',
    );
    // the mounted label is still resolved through the registry, not the vault
    assert.equal(readFile(vault, 'external/AgentA/mem.md', { externalRoots: roots }).content, '# memory');
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

  it('refuses the mount root itself', () => {
    const { vault } = setup();
    assert.throws(() => writeFile(vault, 'external/AgentA', 'x'), { code: 'E_EXTERNAL_READONLY' });
    assert.throws(() => createDirectory(vault, 'external/AgentA'), { code: 'E_EXTERNAL_READONLY' });
  });

  // The guard is resolved, not string-matched, so it also covers aliases the
  // path string cannot spell — here a vault-internal link into an external root.
  it('refuses writes through a vault-internal link into an external root', async () => {
    const { vault, ext } = setup();
    createDirectoryLink(fs.realpathSync(ext), path.join(vault, 'alias'));
    assert.throws(() => writeFile(vault, 'alias/new.md', 'x'), { code: 'E_EXTERNAL_READONLY' });
    await assert.rejects(() => deleteFile(vault, 'alias/mem.md'), { code: 'E_EXTERNAL_READONLY' });
    assert.equal(fs.existsSync(path.join(fs.realpathSync(ext), 'new.md')), false);
    assert.equal(fs.readFileSync(path.join(fs.realpathSync(ext), 'mem.md'), 'utf-8'), '# memory');
  });

  // win32 and default macOS filesystems are case-insensitive, so a case variant
  // names the SAME junction. A case-sensitive host instead creates a brand-new
  // directory there (no data loss), which makes the probe meaningless — hence
  // the gate.
  it('refuses case variants of the mount (case-insensitive filesystems)', async (t) => {
    const { vault, ext } = setup();
    if (!fs.existsSync(path.join(vault, 'EXTERNAL', 'AgentA'))) {
      t.skip('case-sensitive filesystem: External/ is a distinct directory, not the mount');
      return;
    }
    assert.throws(() => writeFile(vault, 'External/AgentA/new.md', 'x'), { code: 'E_EXTERNAL_READONLY' });
    assert.throws(() => createDirectory(vault, 'EXTERNAL/AgentA/sub'), { code: 'E_EXTERNAL_READONLY' });
    await assert.rejects(() => deleteFile(vault, 'External/AgentA/mem.md'), { code: 'E_EXTERNAL_READONLY' });
    // nothing landed in, and nothing was removed from, the user's folder
    assert.equal(fs.existsSync(path.join(fs.realpathSync(ext), 'new.md')), false);
    assert.equal(fs.existsSync(path.join(fs.realpathSync(ext), 'sub')), false);
    assert.equal(fs.readFileSync(path.join(fs.realpathSync(ext), 'mem.md'), 'utf-8'), '# memory');
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

  it('refuses to create a directory inside a mounted root', () => {
    const { vault } = setup();
    assert.throws(() => createDirectory(vault, 'external/AgentA/sub'), { code: 'E_EXTERNAL_READONLY' });
  });

  // The mount is the link BELOW `external/`, not the container itself, so a
  // not-yet-mounted name there is an ordinary (in-vault) directory.
  it('allows creating a directory for an unmounted label', () => {
    const { vault, ext } = setup();
    createDirectory(vault, 'external/AgentB');
    assert.ok(fs.existsSync(path.join(vault, 'external', 'AgentB')));
    assert.equal(fs.existsSync(path.join(fs.realpathSync(ext), 'AgentB')), false);
  });

  // `path.resolve` (used by every write) collapses these onto the mount, and
  // the resolved guard must see through all of them.
  it('sees through `..` / `./` obfuscation of the namespace', () => {
    const { vault } = setup();
    assert.throws(() => writeFile(vault, 'notes/../external/AgentA/new.md', 'x'), { code: 'E_EXTERNAL_READONLY' });
    assert.throws(() => writeFile(vault, './external/AgentA/new.md', 'x'), { code: 'E_EXTERNAL_READONLY' });
  });

  // Backslash is a path separator on win32 only; on POSIX it is a legal
  // filename character, so `external\AgentA\new.md` is a file in the vault
  // rather than a mount write — nothing to refuse there.
  it('sees through backslash separators on win32', { skip: process.platform !== 'win32' }, () => {
    const { vault } = setup();
    assert.throws(() => writeFile(vault, 'external\\AgentA\\new.md', 'x'), { code: 'E_EXTERNAL_READONLY' });
  });

  // No false positives: `..` inside an ordinary vault path still writes.
  it('leaves `..` inside the vault alone', () => {
    const { vault } = setup();
    createDirectory(vault, 'notes');
    writeFile(vault, 'notes/../top.md', 'hi');
    assert.equal(readFile(vault, 'top.md').content, 'hi');
  });

  // R8's write half: with no registry the `external/` container is Molio's own
  // in-vault directory (the mount is the link BELOW it), so writing there is
  // just a vault write — the mount target stays untouched.
  it('writes into a plain external/ folder when no root is registered', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    fs.mkdirSync(path.join(vault, 'external', 'notes'), { recursive: true });
    writeFile(vault, 'external/notes/real.md', '# updated');
    assert.equal(readFile(vault, 'external/notes/real.md').content, '# updated');
  });

  it('allows a vault write next to a registered mount', () => {
    const { vault, ext } = setup();
    writeFile(vault, 'external/plain.md', 'in-vault file');
    assert.equal(readFile(vault, 'external/plain.md').content, 'in-vault file');
    assert.equal(fs.existsSync(path.join(fs.realpathSync(ext), 'plain.md')), false);
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
