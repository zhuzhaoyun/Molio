import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  approveOneBatchPlan,
  completedBuildWithMixedResults,
  completedLeafBuild,
  completedThreeLevelBuild,
  makeScannedVaultWithFiles,
  makePlanFixtureForFiles,
  readState,
  runPlan,
  runWikiBuildCli,
  writeCompletedBuildState,
} from './wiki-build-test-helpers.js';

const daemonRoot = resolve(import.meta.dirname, '..', '..', '..');
const indexesModule = await import(pathToFileURL(join(
  daemonRoot, 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'indexes.mjs',
)).href);
const workspaceModule = await import(pathToFileURL(join(
  daemonRoot, 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'workspace.mjs',
)).href);

function writeSummaries(vaultPath: string, summaries: object) {
  const path = join(vaultPath, 'summaries.json');
  writeFileSync(path, `${JSON.stringify(summaries)}\n`);
  return path;
}

function finalize(vaultPath: string, summariesPath: string) {
  return runWikiBuildCli(vaultPath, ['finalize', '--summaries', summariesPath, '--json']);
}

function reindex(vaultPath: string, topicId: string, inputPath: string, summariesPath: string) {
  return runWikiBuildCli(vaultPath, [
    'reindex', '--topic-id', topicId, '--input', inputPath,
    '--summaries', summariesPath, '--json',
  ]);
}

describe('wiki-build indexes — three-level hierarchy', () => {
  it('generates bottom-up indexes for a three-level topic tree', () => {
    const fixture = completedThreeLevelBuild();
    const summariesPath = writeSummaries(fixture.vault, fixture.summaries);

    const result = finalize(fixture.vault, summariesPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.data.phase, 'completed');

    // Root index lists top-level topics
    const rootIndex = readFileSync(join(fixture.vault, 'wiki/INDEX.md'), 'utf8');
    assert.match(rootIndex, /\[\[engineering\/INDEX\|engineering\]\]/);
    assert.match(rootIndex, /\[\[digitalization\/INDEX\|digitalization\]\]/);

    // Branch index lists direct children
    const engIndex = readFileSync(join(fixture.vault, 'wiki/engineering/INDEX.md'), 'utf8');
    assert.match(engIndex, /\[\[engineering\/review\/INDEX\|review\]\]/);
    assert.match(engIndex, /\[\[engineering\/fire\/INDEX\|fire\]\]/);

    // Leaf index lists source pages
    const fireIndex = readFileSync(join(fixture.vault, 'wiki/engineering/fire/INDEX.md'), 'utf8');
    assert.match(fireIndex, /sources/);
    assert.match(fireIndex, /Fire Protection/);

    // Digitalization branch index
    const digIndex = readFileSync(join(fixture.vault, 'wiki/digitalization/INDEX.md'), 'utf8');
    assert.match(digIndex, /\[\[digitalization\/standards\/INDEX\|standards\]\]/);
    assert.match(digIndex, /\[\[digitalization\/tools\/INDEX\|tools\]\]/);

    // State phase is completed
    const state = readState(fixture.vault);
    assert.equal(state.phase, 'completed');

    fixture.cleanup();
  });
});

describe('wiki-build indexes — deterministic sharding', () => {
  it('creates deterministic shards when leaf exceeds maxLeafPages', () => {
    const fixture = completedLeafBuild({ maxLeafPages: 2, pageCount: 5 });
    const summariesPath = writeSummaries(fixture.vault, fixture.summaries);

    const first = finalize(fixture.vault, summariesPath);
    assert.equal(first.status, 0, first.stderr);

    // Verify shard files exist
    assert.ok(existsSync(join(fixture.vault, 'wiki/topic/index-shards/sources-0001.md')));
    assert.ok(existsSync(join(fixture.vault, 'wiki/topic/index-shards/sources-0002.md')));
    assert.ok(existsSync(join(fixture.vault, 'wiki/topic/index-shards/sources-0003.md')));

    // Leaf INDEX.md references shards
    const leafIndex = readFileSync(join(fixture.vault, 'wiki/topic/INDEX.md'), 'utf8');
    assert.match(leafIndex, /sources-0001/);
    assert.match(leafIndex, /sources-0002/);
    assert.match(leafIndex, /sources-0003/);

    // Second call produces the same hashes (idempotent)
    const second = finalize(fixture.vault, summariesPath);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(first.json.data.indexes, second.json.data.indexes);

    fixture.cleanup();
  });

  it('removes stale index-shards/ when topic transitions from sharded to inline', () => {
    const fixture = completedLeafBuild({ maxLeafPages: 2, pageCount: 5 });
    const summariesPath = writeSummaries(fixture.vault, fixture.summaries);

    // First finalize creates shards
    const first = finalize(fixture.vault, summariesPath);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(join(fixture.vault, 'wiki/topic/index-shards')));

    // Reduce page count below maxLeafPages by deleting pages from state
    const statePath = join(fixture.vault, '.molio', 'wiki-build', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const pagePaths = Object.keys(state.pages);
    // Keep only 2 pages (equal to maxLeafPages)
    for (let index = 2; index < pagePaths.length; index += 1) {
      const path = pagePaths[index]!;
      delete state.pages[path];
    }
    // Reset phase back to running so finalize can run again
    state.phase = 'running';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    // Re-finalize: should produce inline index and remove stale shards
    const second = finalize(fixture.vault, summariesPath);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(existsSync(join(fixture.vault, 'wiki/topic/index-shards')), false);

    // Leaf INDEX.md should be inline (no shard references)
    const leafIndex = readFileSync(join(fixture.vault, 'wiki/topic/INDEX.md'), 'utf8');
    assert.doesNotMatch(leafIndex, /index-shards/);

    fixture.cleanup();
  });
});

describe('wiki-build indexes — source page missing', () => {
  it('rejects finalize when a succeeded source page is missing from disk', () => {
    const fixture = completedLeafBuild({ deleteSourcePage: true });
    const summariesPath = writeSummaries(fixture.vault, fixture.summaries);

    const result = finalize(fixture.vault, summariesPath);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'SOURCE_PAGE_MISSING');
    assert.ok(result.json.error.details.codes.includes('SOURCE_PAGE_MISSING'));

    fixture.cleanup();
  });
});

describe('wiki-build indexes — reindex only affected chain', () => {
  it('rebuilds only the topic chain being reindexed, not unrelated topics', () => {
    const fixture = completedThreeLevelBuild();
    const summariesPath = writeSummaries(fixture.vault, fixture.summaries);

    // First finalize to create all indexes
    const initResult = finalize(fixture.vault, summariesPath);
    assert.equal(initResult.status, 0, initResult.stderr);

    // Hash digitalization INDEX before reindex
    const digIndexPath = join(fixture.vault, 'wiki/digitalization/INDEX.md');
    const digBefore = readFileSync(digIndexPath, 'utf8');
    const digHashBefore = workspaceModule.sha256(digBefore);

    // Create a new page for fire topic
    const newPagePath = 'wiki/engineering/fire/sources/New Page.md';
    const newPageAbsPath = join(fixture.vault, newPagePath);
    mkdirSync(dirname(newPageAbsPath), { recursive: true });
    writeFileSync(newPageAbsPath, '# New Page\nNew content');

    // Create ingest result
    const ingestResult = {
      pageUpdates: [{
        path: newPagePath,
        topicId: 'fire',
        type: 'sources',
        title: 'New Page',
        summary: 'New page summary',
        sha256: workspaceModule.sha256('# New Page\nNew content'),
      }],
    };
    const inputPath = join(fixture.vault, 'ingest-result.json');
    writeFileSync(inputPath, `${JSON.stringify(ingestResult)}\n`);

    // Run reindex
    const result = reindex(fixture.vault, 'fire', inputPath, summariesPath);
    assert.equal(result.status, 0, result.stderr);

    // fire INDEX.md now contains the new page
    const fireIndex = readFileSync(join(fixture.vault, 'wiki/engineering/fire/INDEX.md'), 'utf8');
    assert.match(fireIndex, /New Page/);

    // digitalization INDEX.md hash is unchanged
    const digAfter = readFileSync(digIndexPath, 'utf8');
    const digHashAfter = workspaceModule.sha256(digAfter);
    assert.equal(digHashBefore, digHashAfter);

    // Returned hashes include fire chain but not digitalization
    const hashes = result.json.data.hashes;
    assert.ok('wiki/engineering/fire/INDEX.md' in hashes);
    assert.ok(!('wiki/digitalization/INDEX.md' in hashes));

    // State has the new page
    const state = readState(fixture.vault);
    assert.ok(newPagePath in state.pages);
    assert.equal(state.pages[newPagePath].title, 'New Page');

    fixture.cleanup();
  });
});

describe('wiki-build indexes — reject finalize with pending batches', () => {
  it('rejects finalize when activeBatchId is set', () => {
    const fixture = approveOneBatchPlan();
    const statePath = join(fixture.vault, '.molio', 'wiki-build', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.activeBatchId = 'economy-file-001';
    state.batches['economy-file-001'].status = 'running';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const summariesPath = writeSummaries(fixture.vault, { 'economy-file': { summary: 'test' } });
    const result = finalize(fixture.vault, summariesPath);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'BATCHES_STILL_PENDING');

    fixture.cleanup();
  });

  it('rejects finalize when any batch is pending', () => {
    const fixture = approveOneBatchPlan();
    // State already has batch in 'pending' status after approval
    const summariesPath = writeSummaries(fixture.vault, { 'economy-file': { summary: 'test' } });
    const result = finalize(fixture.vault, summariesPath);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'BATCHES_STILL_PENDING');

    fixture.cleanup();
  });
});

describe('wiki-build indexes — completed_with_errors phase', () => {
  it('sets phase to completed_with_errors when some files failed', () => {
    const fixture = completedBuildWithMixedResults();
    const summariesPath = writeSummaries(fixture.vault, fixture.summaries);

    const result = finalize(fixture.vault, summariesPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.data.phase, 'completed_with_errors');
    assert.equal(result.json.data.succeeded, 1);
    assert.equal(result.json.data.failed, 1);

    const state = readState(fixture.vault);
    assert.equal(state.phase, 'completed_with_errors');

    fixture.cleanup();
  });
});

describe('wiki-build indexes — verifyCoverage', () => {
  it('detects duplicate page paths in coverage', () => {
    const model = {
      indexes: {},
      hashes: {},
      coverage: ['wiki/topic/sources/A.md', 'wiki/topic/sources/A.md'],
      expectedPages: ['wiki/topic/sources/A.md'],
      missing: [],
    };
    const result = indexesModule.verifyCoverage(model);
    assert.equal(result.ok, false);
    assert.ok(result.duplicates.includes('wiki/topic/sources/A.md'));
  });

  it('detects missing pages not in coverage', () => {
    const model = {
      indexes: {},
      hashes: {},
      coverage: [],
      expectedPages: ['wiki/topic/sources/A.md'],
      missing: [],
    };
    const result = indexesModule.verifyCoverage(model);
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes('wiki/topic/sources/A.md'));
  });
});

describe('wiki-build indexes — token-based sharding', () => {
  it('shards when index tokens exceed maxLeafIndexTokens even if page count is under maxLeafPages', () => {
    // maxLeafPages=200 (high), maxLeafIndexTokens=50 (low), 3 pages
    // Each entry line is ~66 bytes = 22 tokens, 3 entries = 66 tokens > 50
    const fixture = completedLeafBuild({
      maxLeafPages: 200,
      maxLeafIndexTokens: 50,
      pageCount: 3,
    });
    const summariesPath = writeSummaries(fixture.vault, fixture.summaries);

    const result = finalize(fixture.vault, summariesPath);
    assert.equal(result.status, 0, result.stderr);

    // Sharding should have occurred
    assert.ok(existsSync(join(fixture.vault, 'wiki/topic/index-shards/sources-0001.md')));
    assert.ok(existsSync(join(fixture.vault, 'wiki/topic/index-shards/sources-0002.md')));

    // Leaf INDEX.md references shards
    const leafIndex = readFileSync(join(fixture.vault, 'wiki/topic/INDEX.md'), 'utf8');
    assert.match(leafIndex, /sources-0001/);
    assert.match(leafIndex, /sources-0002/);

    fixture.cleanup();
  });
});

describe('wiki-build indexes — estimateIndexTokens', () => {
  it('computes tokens as ceil(bytes / 3)', () => {
    assert.equal(indexesModule.estimateIndexTokens('abc'), 1);
    assert.equal(indexesModule.estimateIndexTokens('abcdef'), 2);
    assert.equal(indexesModule.estimateIndexTokens('a'), 1);
    assert.equal(indexesModule.estimateIndexTokens(''), 0);
  });
});

describe('wiki-build indexes — buildIndexModel', () => {
  it('throws TOPIC_SUMMARY_MISSING when a topic lacks a summary', () => {
    const plan = {
      capacity: { maxLeafPages: 200, maxLeafIndexTokens: 12000, maxTopicDepth: 6 },
      topics: [{
        id: 'topic-a', name: 'A', slug: 'a', kind: 'leaf', depth: 1,
        fileIds: ['f1'], estimatedPages: 1, estimatedIndexTokens: 40,
      }],
    };
    const pages = {};
    const summaries = {}; // missing summary for topic-a
    assert.throws(
      () => indexesModule.buildIndexModel(plan, pages, summaries),
      (error: any) => error.code === 'TOPIC_SUMMARY_MISSING',
    );
  });
});

describe('wiki-build indexes — buildIndexModelLenient', () => {
  it('does not throw when topic summaries are missing', () => {
    const plan = {
      capacity: { maxLeafPages: 200, maxLeafIndexTokens: 12000, maxTopicDepth: 6 },
      topics: [{
        id: 'topic-a', name: 'A', slug: 'a', kind: 'leaf', depth: 1,
        fileIds: ['f1'], estimatedPages: 1, estimatedIndexTokens: 40,
      }],
    };
    const pages = {
      'wiki/a/sources/Page.md': { topicId: 'topic-a', type: 'sources', title: 'Page', summary: 'test' },
    };
    // Should not throw even with empty summaries
    const model = indexesModule.buildIndexModelLenient(plan, pages, {});
    assert.ok(model.indexes['wiki/a/INDEX.md']);
    assert.ok(model.hashes['wiki/a/INDEX.md']);
    assert.ok(model.coverage.includes('wiki/a/sources/Page.md'));
  });
});

describe('wiki-build indexes — appendBuildLog', () => {
  it('creates log.md with header when it does not exist', () => {
    const fixture = completedLeafBuild({ pageCount: 1 });
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    indexesModule.appendBuildLog(paths, {
      batchId: 'batch-001', succeeded: 1, failed: 0, skipped: 0, pages: 1, topics: ['topic'],
    });
    const logPath = join(fixture.vault, 'wiki', 'log.md');
    assert.ok(existsSync(logPath));
    const content = readFileSync(logPath, 'utf8');
    assert.match(content, /# 构建日志/);
    assert.match(content, /checkpoint \| batch-001/);
    assert.match(content, /succeeded:1/);
    assert.match(content, /主题：topic/);
    fixture.cleanup();
  });

  it('prepends new entries to existing log.md', () => {
    const fixture = completedLeafBuild({ pageCount: 1 });
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    indexesModule.appendBuildLog(paths, {
      batchId: 'batch-001', succeeded: 1, failed: 0, skipped: 0, pages: 1, topics: ['topic'],
    });
    indexesModule.appendBuildLog(paths, {
      batchId: 'batch-002', succeeded: 2, failed: 0, skipped: 0, pages: 2, topics: ['topic'],
    });
    const content = readFileSync(join(fixture.vault, 'wiki', 'log.md'), 'utf8');
    // batch-002 should appear before batch-001 (prepended)
    const idx2 = content.indexOf('batch-002');
    const idx1 = content.indexOf('batch-001');
    assert.ok(idx2 < idx1, 'newer entry should be prepended');
    fixture.cleanup();
  });
});

describe('wiki-build indexes — writeHotCache', () => {
  it('generates hot.md from state', () => {
    const fixture = completedLeafBuild({ pageCount: 1 });
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const state = readState(fixture.vault);
    const plan = JSON.parse(readFileSync(join(fixture.vault, '.molio', 'wiki-build', 'plan.json'), 'utf8'));
    indexesModule.writeHotCache(paths, state, plan);
    const hotPath = join(fixture.vault, 'wiki', 'hot.md');
    assert.ok(existsSync(hotPath));
    const content = readFileSync(hotPath, 'utf8');
    assert.match(content, /# 构建状态缓存/);
    assert.match(content, /Phase/);
    assert.match(content, /批次进度/);
    fixture.cleanup();
  });
});

describe('wiki-build indexes — rebuildAfterCheckpoint', () => {
  it('rebuilds only the affected topic chain', () => {
    const fixture = completedThreeLevelBuild();
    const paths = workspaceModule.resolveBuildPaths(fixture.vault);
    const state = readState(fixture.vault);
    const plan = JSON.parse(readFileSync(join(fixture.vault, '.molio', 'wiki-build', 'plan.json'), 'utf8'));

    const result = indexesModule.rebuildAfterCheckpoint(paths, plan, state, 'fire', {
      batchId: 'test-batch', succeeded: 1, failed: 0, skipped: 0, pages: 1, topics: ['fire'],
    });

    assert.ok(result.indexesWritten > 0);
    assert.equal(result.logAppended, true);

    // fire INDEX.md should exist
    assert.ok(existsSync(join(fixture.vault, 'wiki', 'engineering', 'fire', 'INDEX.md')));
    // log.md and hot.md should exist
    assert.ok(existsSync(join(fixture.vault, 'wiki', 'log.md')));
    assert.ok(existsSync(join(fixture.vault, 'wiki', 'hot.md')));

    fixture.cleanup();
  });
});
