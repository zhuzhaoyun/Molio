import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanTree } from '../../src/core/knowledge.js';
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
