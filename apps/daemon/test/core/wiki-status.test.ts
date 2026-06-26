import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { annotateTreeStatus, invalidateLogCache } from '../../src/core/wiki-status.js';
import { scanTree } from '../../src/core/knowledge.js';
import type { TreeNode } from '@molio/contracts';

/**
 * wiki-status derives ingest state from wiki/log.md (the Agent-maintained
 * truth), so legacy vaults work without migration. Tests cover the log parser
 * + three-state annotation, with mtimes controlled via utimesSync.
 */

function setMtime(file: string, dateStr: string): void {
  const s = Math.floor(new Date(dateStr).getTime() / 1000);
  utimesSync(file, s, s);
}

function findFile(nodes: TreeNode[], relPath: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === relPath) return n;
    if (n.children) {
      const f = findFile(n.children, relPath);
      if (f) return f;
    }
  }
  return null;
}

function statusOf(nodes: TreeNode[], relPath: string): string | undefined {
  return findFile(nodes, relPath)?.ingestStatus;
}

function writeLog(vault: string, body: string): void {
  mkdirSync(join(vault, 'wiki'), { recursive: true });
  writeFileSync(join(vault, 'wiki', 'log.md'), body, 'utf-8');
}

describe('wiki-status (log.md-derived ingest state)', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'molio-wiki-status-'));
  });

  afterEach(() => {
    invalidateLogCache(vault);
    rmSync(vault, { recursive: true, force: true });
  });

  it('leaves the tree untouched when there is no wiki/log.md', async () => {
    writeFileSync(join(vault, 'a.md'), 'A');
    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    assert.equal(statusOf(nodes, 'a.md'), undefined);
  });

  it('marks a file ingested (clean) when mtime <= ingest date', async () => {
    const f = join(vault, 'a.md');
    writeFileSync(f, 'A');
    setMtime(f, '2026-06-20T10:00:00');
    writeLog(vault, '## 2026-06-25 12:00 | ingest | a.md\n- created 1 page\n');

    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    assert.equal(statusOf(nodes, 'a.md'), 'tracked-clean');
  });

  it('marks a file stale (modified) when mtime > ingest date', async () => {
    const f = join(vault, 'b.md');
    writeFileSync(f, 'B');
    setMtime(f, '2026-06-30T10:00:00'); // after the ingest date
    writeLog(vault, '## 2026-06-25 12:00 | ingest | b.md\n');

    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    assert.equal(statusOf(nodes, 'b.md'), 'tracked-modified');
  });

  it('marks a file pending when it is not in the log', async () => {
    writeFileSync(join(vault, 'c.md'), 'C');
    writeLog(vault, '## 2026-06-25 12:00 | ingest | other.md\n');

    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    assert.equal(statusOf(nodes, 'c.md'), 'pending');
  });

  it('uses the latest ingest date when multiple entries exist for a file', async () => {
    const f = join(vault, 'a.md');
    writeFileSync(f, 'A');
    setMtime(f, '2026-06-28T10:00:00'); // after first ingest, before second
    writeLog(vault, [
      '## 2026-06-27 10:00 | ingest | a.md',
      '## 2026-06-29 10:00 | ingest | a.md',
      '',
    ].join('\n'));

    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    // latest ingest 06-29 >= mtime 06-28 → clean
    assert.equal(statusOf(nodes, 'a.md'), 'tracked-clean');
  });

  it('parses date-only entries (no time)', async () => {
    const f = join(vault, 'a.md');
    writeFileSync(f, 'A');
    setMtime(f, '2026-06-20T10:00:00');
    writeLog(vault, '## 2026-06-25 | ingest | a.md\n');

    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    assert.equal(statusOf(nodes, 'a.md'), 'tracked-clean');
  });

  it('a build entry covers sources unmodified since build (clean)', async () => {
    const d = join(vault, 'd.md');
    writeFileSync(d, 'D');
    setMtime(d, '2026-06-20T10:00:00'); // unmodified since build
    // build late in the day so file birthtime (now, today) <= build time
    writeLog(vault, '## 2026-06-25 23:59 | build | initial build\n');

    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    assert.equal(statusOf(nodes, 'd.md'), 'tracked-clean');
  });

  it('a build entry leaves sources modified after build (no later ingest) pending', async () => {
    // mtime-only build coverage: a file modified after build with no later
    // ingest shows `pending` (re-ingest needed), not `stale` — the trade-off
    // for avoiding a per-file birthtime stat. Both mean "re-ingest".
    const e = join(vault, 'e.md');
    writeFileSync(e, 'E');
    setMtime(e, '2026-06-30T10:00:00'); // modified after build
    writeLog(vault, '## 2026-06-25 23:59 | build | initial build\n');

    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    assert.equal(statusOf(nodes, 'e.md'), 'pending');
  });

  it('a file modified after build but re-ingested later shows clean', async () => {
    const e = join(vault, 'e.md');
    writeFileSync(e, 'E');
    setMtime(e, '2026-06-28T10:00:00'); // modified after build, before re-ingest
    writeLog(vault, [
      '## 2026-06-25 23:59 | build | initial build',
      '## 2026-06-29 10:00 | ingest | e.md',
      '',
    ].join('\n'));

    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    // latest ingest 06-29 >= mtime 06-28 → clean (ingest path is exact)
    assert.equal(statusOf(nodes, 'e.md'), 'tracked-clean');
  });

  it('directory rollup reflects the worst descendant', async () => {
    mkdirSync(join(vault, 'sub'), { recursive: true });
    const clean = join(vault, 'sub', 'clean.md');
    const pend = join(vault, 'sub', 'pend.md');
    writeFileSync(clean, 'C');
    writeFileSync(pend, 'P');
    setMtime(clean, '2026-06-20T10:00:00');
    writeLog(vault, '## 2026-06-25 12:00 | ingest | clean.md\n');

    const nodes = scanTree(vault);
    await annotateTreeStatus(vault, nodes);
    const dir = findFile(nodes, 'sub');
    assert.equal(dir?.ingestStatus, 'pending'); // pend.md is pending → rollup pending
  });

  it('caches the parse and re-reads when log.md mtime changes', async () => {
    const f = join(vault, 'a.md');
    writeFileSync(f, 'A');
    setMtime(f, '2026-06-20T10:00:00');
    writeLog(vault, '## 2026-06-25 12:00 | ingest | a.md\n');

    const nodes1 = scanTree(vault);
    await annotateTreeStatus(vault, nodes1);
    assert.equal(statusOf(nodes1, 'a.md'), 'tracked-clean');

    // Rewrite log WITHOUT the ingest entry; bump mtime so cache invalidates.
    writeFileSync(join(vault, 'wiki', 'log.md'), '# 构建日志\n');
    setMtime(join(vault, 'wiki', 'log.md'), '2026-06-26T10:00:00');

    const nodes2 = scanTree(vault);
    await annotateTreeStatus(vault, nodes2);
    assert.equal(statusOf(nodes2, 'a.md'), 'pending');
  });

  describe('wiki/sources frontmatter `sources:` signal', () => {
    function writeSourcePage(vault: string, page: string, sources: string[], mtime?: string): void {
      mkdirSync(join(vault, 'wiki', 'sources'), { recursive: true });
      const items = sources.map((s) => `  - "${s}"`).join('\n');
      const body = `---\ntype: source\ntitle: "${page}"\nsources:\n${items}\n---\n# ${page}\n`;
      const p = join(vault, 'wiki', 'sources', page);
      writeFileSync(p, body);
      if (mtime) setMtime(p, mtime);
    }

    it('marks a file ingested when a sources page lists it by path', async () => {
      mkdirSync(join(vault, 'Clippings'), { recursive: true });
      const f = join(vault, 'Clippings', 'foo.md');
      writeFileSync(f, 'F');
      setMtime(f, '2026-06-20T10:00:00');
      writeSourcePage(vault, 'foo.md', ['Clippings/foo.md'], '2026-06-25T10:00:00');

      const nodes = scanTree(vault);
      await annotateTreeStatus(vault, nodes);
      assert.equal(statusOf(nodes, 'Clippings/foo.md'), 'tracked-clean');
    });

    it('marks a file ingested when listed by bare basename', async () => {
      writeFileSync(join(vault, 'bar.pdf'), 'B');
      setMtime(join(vault, 'bar.pdf'), '2026-06-20T10:00:00');
      writeSourcePage(vault, 'bar.md', ['bar.pdf'], '2026-06-25T10:00:00');

      const nodes = scanTree(vault);
      await annotateTreeStatus(vault, nodes);
      assert.equal(statusOf(nodes, 'bar.pdf'), 'tracked-clean');
    });

    it('marks a file ingested via a wiki-link source (no .md)', async () => {
      mkdirSync(join(vault, 'raw', 'wechat', '2026-06-18'), { recursive: true });
      const f = join(vault, 'raw', 'wechat', '2026-06-18', 'note.md');
      writeFileSync(f, 'N');
      setMtime(f, '2026-06-20T10:00:00');
      writeSourcePage(vault, 'note.md', ['[[raw/wechat/2026-06-18/note]]'], '2026-06-25T10:00:00');

      const nodes = scanTree(vault);
      await annotateTreeStatus(vault, nodes);
      assert.equal(statusOf(nodes, 'raw/wechat/2026-06-18/note.md'), 'tracked-clean');
    });

    it('flags a source stale when modified after its sources-page mtime', async () => {
      mkdirSync(join(vault, 'Clippings'), { recursive: true });
      const f = join(vault, 'Clippings', 'foo.md');
      writeFileSync(f, 'F');
      setMtime(f, '2026-06-30T10:00:00'); // modified after the page
      writeSourcePage(vault, 'foo.md', ['Clippings/foo.md'], '2026-06-25T10:00:00');

      const nodes = scanTree(vault);
      await annotateTreeStatus(vault, nodes);
      assert.equal(statusOf(nodes, 'Clippings/foo.md'), 'tracked-modified');
    });

    it('works without log.md (sources pages only)', async () => {
      mkdirSync(join(vault, 'Clippings'), { recursive: true });
      const f = join(vault, 'Clippings', 'foo.md');
      writeFileSync(f, 'F');
      setMtime(f, '2026-06-20T10:00:00');
      writeSourcePage(vault, 'foo.md', ['Clippings/foo.md'], '2026-06-25T10:00:00');
      // No wiki/log.md at all.
      assert.ok(!existsSync(join(vault, 'wiki', 'log.md')));

      const nodes = scanTree(vault);
      await annotateTreeStatus(vault, nodes);
      assert.equal(statusOf(nodes, 'Clippings/foo.md'), 'tracked-clean');
    });
  });
});
