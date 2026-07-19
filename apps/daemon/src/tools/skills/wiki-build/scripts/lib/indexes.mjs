import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_CAPACITY } from './contracts.mjs';
import { atomicWriteJson, readJson, sha256 } from './workspace.mjs';

/**
 * @typedef {object} IndexModel
 * @property {Record<string, string>} indexes
 * @property {Record<string, string>} hashes
 * @property {string[]} coverage
 * @property {string[]} expectedPages
 */

const TYPE_ORDER = ['sources', 'entities', 'concepts', 'comparisons', 'questions'];

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

/**
 * Get a human-readable topic name, falling back to slug then id.
 * Plans may omit `name` (only slug/id are required by validation).
 * @param {object} topic
 * @returns {string}
 */
function topicDisplayName(topic) {
  return topic.name ?? topic.slug ?? topic.id ?? 'unknown';
}

/**
 * Estimate token count of a markdown string using utf8-bytes / 3.
 * @param {string} markdown
 * @returns {number}
 */
export function estimateIndexTokens(markdown) {
  return Math.ceil(Buffer.byteLength(markdown, 'utf8') / 3);
}

/**
 * Sort type names: fixed order first, then lexicographic.
 * @param {string[]} types
 * @returns {string[]}
 */
function sortTypes(types) {
  const fixed = new Set(TYPE_ORDER);
  const known = TYPE_ORDER.filter((type) => types.includes(type));
  const other = types.filter((type) => !fixed.has(type)).sort();
  return [...known, ...other];
}

/**
 * Build topic lookup maps from the plan's topic tree.
 * @param {Array} topics
 * @returns {{ topicById: Map, topicPathMap: Map, parentMap: Map, pathToTopic: Map }}
 */
function buildTopicMaps(topics) {
  const topicById = new Map();
  const topicPathMap = new Map();
  const parentMap = new Map();
  const pathToTopic = new Map();

  const walk = (nodes, parentPath, parentId) => {
    for (const node of nodes) {
      const segments = [...parentPath, node.slug];
      topicById.set(node.id, node);
      topicPathMap.set(node.id, segments);
      parentMap.set(node.id, parentId);
      pathToTopic.set(segments.join('/'), node.id);
      if (node.kind === 'branch' && node.children) {
        walk(node.children, segments, node.id);
      }
    }
  };
  walk(topics ?? [], [], null);

  return { topicById, topicPathMap, parentMap, pathToTopic };
}

/**
 * Render a single page entry as a wikilink line.
 * Derives the link target from page.path (e.g. "wiki/知识系统/LLM-Wiki.md"
 * → "知识系统/LLM-Wiki") so the link matches the actual flat page location,
 * NOT a type/title composite path that doesn't exist on disk.
 * @param {object} page
 * @param {string[]} topicPath
 * @returns {string}
 */
function renderEntry(page, topicPath) {
  // page.path is like "wiki/<topic>/.../<title>.md" — strip wiki/ prefix and .md suffix
  const linkTarget = (page.path ?? '').replace(/^wiki\//, '').replace(/\.md$/i, '');
  return `- [[${linkTarget}|${page.title}]] — ${page.summary}\n`;
}

/**
 * Split sorted entries into shards respecting both maxLeafPages and maxLeafIndexTokens.
 * @param {Array} entries
 * @param {string[]} topicPath
 * @param {string} type
 * @param {object} capacity
 * @returns {Array<Array>}
 */
function shardEntries(entries, topicPath, type, capacity) {
  const shards = [];
  let current = [];
  let currentEntryTokens = 0;

  for (const entry of entries) {
    const line = renderEntry(entry, topicPath);
    const lineTokens = estimateIndexTokens(line);

    const newLength = current.length + 1;
    const newEntryTokens = currentEntryTokens + lineTokens;
    const header = `# ${type} (${newLength})\n\n`;
    const headerTokens = estimateIndexTokens(header);
    const newTotal = headerTokens + newEntryTokens;

    if (current.length > 0
        && (newLength > capacity.maxLeafPages || newTotal > capacity.maxLeafIndexTokens)) {
      shards.push(current);
      current = [entry];
      currentEntryTokens = lineTokens;
    } else {
      current.push(entry);
      currentEntryTokens = newEntryTokens;
    }
  }

  if (current.length > 0) shards.push(current);
  return shards;
}

/**
 * Build a leaf index (inline or sharded).
 * @returns {{ indexes: Record<string, string>, coverage: string[] }}
 */
function buildLeafIndex(topic, pages, topicPath, capacity) {
  const indexes = {};
  const coverage = [];
  const topicPathStr = topicPath.join('/');
  const indexPath = `wiki/${topicPathStr}/INDEX.md`;

  // Group pages by type
  const byType = new Map();
  for (const page of pages) {
    if (!byType.has(page.type)) byType.set(page.type, []);
    byType.get(page.type).push(page);
  }

  const types = sortTypes([...byType.keys()]);

  // Sort entries within each type
  for (const [, entries] of byType) {
    entries.sort((a, b) => {
      const titleA = a.title.toLowerCase();
      const titleB = b.title.toLowerCase();
      if (titleA < titleB) return -1;
      if (titleA > titleB) return 1;
      return a.path.localeCompare(b.path);
    });
  }

  // Check if sharding is needed.
  // Note: totalTokens here sums only entry lines, omitting the per-type header
  // ("# type\n") and section dividers. shardEntries() re-estimates per-shard
  // including headers, so this is a conservative underestimate at the boundary
  // — a leaf right at the token limit might not shard here but will shard
  // inside shardEntries. This is acceptable: sharding is idempotent and the
  // boundary is rare in practice.
  const totalEntries = pages.length;
  let totalTokens = 0;
  for (const page of pages) {
    totalTokens += estimateIndexTokens(renderEntry(page, topicPath));
  }
  const needsShards = totalEntries > capacity.maxLeafPages
    || totalTokens > capacity.maxLeafIndexTokens;

  if (needsShards) {
    // Build shards per type
    const allShards = [];
    for (const type of types) {
      const entries = byType.get(type) ?? [];
      const shards = shardEntries(entries, topicPath, type, capacity);
      for (const shard of shards) {
        allShards.push({ type, entries: shard });
      }
      for (const entry of entries) {
        coverage.push(entry.path);
      }
    }

    // Render shard files
    const typeCounters = {};
    const shardInfo = [];
    for (const shard of allShards) {
      const counter = (typeCounters[shard.type] ?? 0) + 1;
      typeCounters[shard.type] = counter;
      const shardName = `${shard.type}-${String(counter).padStart(4, '0')}`;
      const shardPath = `wiki/${topicPathStr}/index-shards/${shardName}.md`;

      const lines = [`# ${shard.type} (${shard.entries.length})\n`];
      for (const entry of shard.entries) {
        lines.push(renderEntry(entry, topicPath));
      }
      indexes[shardPath] = lines.join('');

      shardInfo.push({
        type: shard.type,
        shardName,
        firstTitle: shard.entries[0].title,
        lastTitle: shard.entries[shard.entries.length - 1].title,
        count: shard.entries.length,
      });
    }

    // Render leaf index listing shards
    const indexLines = [`# ${topicDisplayName(topic)}\n`];
    let lastType = null;
    for (const info of shardInfo) {
      if (info.type !== lastType) {
        indexLines.push(`\n## ${info.type}\n`);
        lastType = info.type;
      }
      const titleRange = info.firstTitle === info.lastTitle
        ? info.firstTitle
        : `${info.firstTitle}–${info.lastTitle}`;
      indexLines.push(`- [[${topicPathStr}/index-shards/${info.shardName}|${info.shardName}]] — ${titleRange} (${info.count} entries)\n`);
    }
    indexes[indexPath] = indexLines.join('');
  } else {
    // Build inline index
    const indexLines = [`# ${topicDisplayName(topic)}\n`];
    for (const type of types) {
      const entries = byType.get(type) ?? [];
      if (entries.length === 0) continue;
      indexLines.push(`\n## ${type}\n`);
      for (const entry of entries) {
        indexLines.push(renderEntry(entry, topicPath));
        coverage.push(entry.path);
      }
    }
    indexes[indexPath] = indexLines.join('');
  }

  return { indexes, coverage };
}

/**
 * Build a branch index listing direct children.
 */
function buildBranchIndex(topic, summaries, topicPath) {
  const topicPathStr = topicPath.join('/');
  const indexPath = `wiki/${topicPathStr}/INDEX.md`;
  const lines = [`# ${topicDisplayName(topic)}\n`];
  for (const child of (topic.children ?? [])) {
    const childSummary = summaries[child.id]?.summary ?? '';
    const childPath = [...topicPath, child.slug].join('/');
    lines.push(`- [[${childPath}/INDEX|${topicDisplayName(child)}]] — ${childSummary}\n`);
  }
  return { [indexPath]: lines.join('') };
}

/**
 * Build the root index listing top-level topics.
 */
function buildRootIndex(topics, summaries) {
  const lines = ['# Index\n'];
  for (const topic of topics) {
    const summary = summaries[topic.id]?.summary ?? '';
    lines.push(`- [[${topic.slug}/INDEX|${topicDisplayName(topic)}]] — ${summary}\n`);
  }
  return { 'wiki/INDEX.md': lines.join('') };
}

/**
 * Build a structured model of all indexes without writing.
 * @param {object} plan
 * @param {Record<string, object>} pages - state.pages manifest
 * @param {Record<string, { summary: string }>} summaries
 * @returns {IndexModel}
 */
export function buildIndexModel(plan, pages, summaries) {
  const capacity = plan.capacity ?? DEFAULT_CAPACITY;
  const topics = plan.topics ?? [];
  const { topicById, topicPathMap } = buildTopicMaps(topics);

  // Validate summaries
  for (const [topicId] of topicById) {
    if (!summaries[topicId]?.summary) {
      throw codedError('TOPIC_SUMMARY_MISSING',
        `Missing summary for topic ${topicId}`, { topicId });
    }
  }

  // Group pages by topicId
  const pagesByTopic = new Map();
  const missing = [];
  for (const [pagePath, page] of Object.entries(pages)) {
    if (!topicById.has(page.topicId)) {
      missing.push(pagePath);
      continue;
    }
    if (!pagesByTopic.has(page.topicId)) pagesByTopic.set(page.topicId, []);
    pagesByTopic.get(page.topicId).push({ path: pagePath, ...page });
  }

  const allIndexes = {};
  const allCoverage = [];

  // Build leaf indexes
  for (const [topicId, topic] of topicById) {
    if (topic.kind !== 'leaf') continue;
    const topicPath = topicPathMap.get(topicId);
    const topicPages = pagesByTopic.get(topicId) ?? [];
    const { indexes, coverage } = buildLeafIndex(topic, topicPages, topicPath, capacity);
    Object.assign(allIndexes, indexes);
    allCoverage.push(...coverage);
  }

  // Build branch indexes
  for (const [topicId, topic] of topicById) {
    if (topic.kind !== 'branch') continue;
    const topicPath = topicPathMap.get(topicId);
    const indexes = buildBranchIndex(topic, summaries, topicPath);
    Object.assign(allIndexes, indexes);
  }

  // Build root index
  Object.assign(allIndexes, buildRootIndex(topics, summaries));

  // Compute hashes
  const hashes = {};
  for (const [path, content] of Object.entries(allIndexes)) {
    hashes[path] = sha256(content);
  }

  return {
    indexes: allIndexes,
    hashes,
    coverage: allCoverage,
    expectedPages: Object.keys(pages),
    missing,
  };
}

/**
 * Build an index model without requiring all topic summaries.
 * Missing summaries are replaced with empty strings (leaf indexes don't need
 * summaries; only root/branch indexes reference them, best-effort).
 * @param {object} plan
 * @param {Record<string, object>} pages - state.pages manifest
 * @param {Record<string, { summary: string }>} [summaries]
 * @returns {IndexModel}
 */
export function buildIndexModelLenient(plan, pages, summaries = {}) {
  const capacity = plan.capacity ?? DEFAULT_CAPACITY
  const topics = plan.topics ?? []
  const { topicById, topicPathMap } = buildTopicMaps(topics)

  // Group pages by topicId
  const pagesByTopic = new Map()
  const missing = []
  for (const [pagePath, page] of Object.entries(pages)) {
    if (!topicById.has(page.topicId)) {
      missing.push(pagePath)
      continue
    }
    if (!pagesByTopic.has(page.topicId)) pagesByTopic.set(page.topicId, [])
    pagesByTopic.get(page.topicId).push({ path: pagePath, ...page })
  }

  const allIndexes = {}
  const allCoverage = []

  // Build leaf indexes (never need summaries)
  for (const [topicId, topic] of topicById) {
    if (topic.kind !== 'leaf') continue
    const topicPath = topicPathMap.get(topicId)
    const topicPages = pagesByTopic.get(topicId) ?? []
    const { indexes, coverage } = buildLeafIndex(topic, topicPages, topicPath, capacity)
    Object.assign(allIndexes, indexes)
    allCoverage.push(...coverage)
  }

  // Build branch indexes (best-effort with missing summaries)
  for (const [topicId, topic] of topicById) {
    if (topic.kind !== 'branch') continue
    const topicPath = topicPathMap.get(topicId)
    const indexes = buildBranchIndex(topic, summaries, topicPath)
    Object.assign(allIndexes, indexes)
  }

  // Build root index (best-effort with missing summaries)
  Object.assign(allIndexes, buildRootIndex(topics, summaries))

  // Compute hashes
  const hashes = {}
  for (const [path, content] of Object.entries(allIndexes)) {
    hashes[path] = sha256(content)
  }

  return {
    indexes: allIndexes,
    hashes,
    coverage: allCoverage,
    expectedPages: Object.keys(pages),
    missing,
  }
}

/**
 * Atomically write all index files. Skips files whose hash already matches.
 * Cleans up stale shard files in directories that were written to.
 * @param {object} paths
 * @param {IndexModel} model
 * @returns {Record<string, string>} hashes map
 */
export function writeIndexes(paths, model) {
  const vault = resolve(paths.root, '..', '..');
  const written = {};

  for (const [relPath, content] of Object.entries(model.indexes)) {
    const absPath = join(vault, relPath);
    const expectedHash = model.hashes[relPath];

    // Skip if existing file matches
    if (existsSync(absPath)) {
      try {
        const existingContent = readFileSync(absPath, 'utf8');
        if (sha256(existingContent) === expectedHash) {
          written[relPath] = expectedHash;
          continue;
        }
      } catch {
        // Fall through to write
      }
    }

    // Write atomically
    const dir = dirname(absPath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${absPath}.tmp`;
    const fd = openSync(tmpPath, 'w');
    try {
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Bare renameSync: atomic on POSIX, overwrites on Windows — same pattern
    // as workspace.mjs atomicWrite(). Do NOT unlink first (crash-safety gap).
    renameSync(tmpPath, absPath);
    written[relPath] = expectedHash;
  }

  // Clean up stale shard files in directories we wrote to
  const shardDirs = new Set();
  for (const relPath of Object.keys(model.indexes)) {
    if (relPath.includes('/index-shards/')) {
      shardDirs.add(dirname(join(vault, relPath)));
    }
  }
  for (const shardDir of shardDirs) {
    if (!existsSync(shardDir)) continue;
    for (const file of readdirSync(shardDir)) {
      const absFile = join(shardDir, file);
      const relFile = relative(vault, absFile).replace(/\\/g, '/');
      if (!(relFile in model.indexes)) {
        try { unlinkSync(absFile); } catch { /* best effort */ }
      }
    }
  }

  // Clean up stale index-shards/ directories that are no longer in the model.
  // This handles the sharded→inline transition: when a topic previously had
  // shards but now produces an inline index, the old index-shards/ directory
  // must be removed.
  for (const [relPath] of Object.entries(model.indexes)) {
    if (relPath.endsWith('/INDEX.md') && !relPath.includes('/index-shards/')) {
      const topicDir = dirname(join(vault, relPath));
      const shardDir = join(topicDir, 'index-shards');
      if (existsSync(shardDir)) {
        // Check whether the model includes any shards for this topic
        const topicRelDir = dirname(relPath);
        const hasModelShards = Object.keys(model.indexes).some(
          (p) => p.startsWith(`${topicRelDir}/index-shards/`),
        );
        if (!hasModelShards) {
          for (const file of readdirSync(shardDir)) {
            try { unlinkSync(join(shardDir, file)); } catch { /* best effort */ }
          }
          try { rmdirSync(shardDir); } catch { /* best effort */ }
        }
      }
    }
  }

  return written;
}

/**
 * Check that every succeeded page appears exactly once in the index model.
 * @param {IndexModel} model
 * @returns {{ ok: boolean, missing: string[], duplicates: string[] }}
 */
export function verifyCoverage(model) {
  const coverageSet = new Set();
  const duplicates = [];

  for (const pagePath of model.coverage) {
    if (coverageSet.has(pagePath)) {
      duplicates.push(pagePath);
    } else {
      coverageSet.add(pagePath);
    }
  }

  const missing = (model.expectedPages ?? []).filter(
    (pagePath) => !coverageSet.has(pagePath),
  );

  return {
    ok: duplicates.length === 0 && missing.length === 0,
    missing,
    duplicates,
  };
}

/**
 * Filter an index model to only the indexes in the affected topic chain.
 * @param {IndexModel} model
 * @param {Set<string>} chain - set of topicIds in the affected chain
 * @param {Map<string, string>} pathToTopic - topicPath string → topicId
 * @returns {IndexModel}
 */
export function filterAffectedIndexes(model, chain, pathToTopic) {
  const affectedIndexes = {}
  for (const [indexPath, content] of Object.entries(model.indexes)) {
    if (indexPath === 'wiki/INDEX.md') {
      affectedIndexes[indexPath] = content
      continue
    }
    const relPath = indexPath.replace(/^wiki\//, '')
    const parts = relPath.split('/')
    parts.pop() // remove INDEX.md or shard file
    if (parts[parts.length - 1] === 'index-shards') parts.pop()
    const topicPathStr = parts.join('/')
    const tid = pathToTopic.get(topicPathStr)
    if (tid && chain.has(tid)) {
      affectedIndexes[indexPath] = content
    }
  }
  return {
    indexes: affectedIndexes,
    hashes: Object.fromEntries(
      Object.entries(model.hashes).filter(([path]) => path in affectedIndexes),
    ),
    coverage: model.coverage,
    expectedPages: model.expectedPages,
    missing: model.missing,
  }
}

/**
 * Append (prepend) a build log entry to wiki/log.md.
 * @param {object} paths
 * @param {{ batchId: string, succeeded: number, failed: number, skipped: number, pages: number, topics: string[] }} entry
 */
export function appendBuildLog(paths, entry) {
  const vault = resolve(paths.root, '..', '..')
  const logPath = join(vault, 'wiki', 'log.md')
  const now = new Date()
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const header = `## ${timestamp} | checkpoint | ${entry.batchId} | succeeded:${entry.succeeded} failed:${entry.failed} skipped:${entry.skipped} | pages:${entry.pages}\n`
  const topicLine = `- 主题：${entry.topics.join(', ')}\n`
  const block = `${header}${topicLine}\n`
  mkdirSync(dirname(logPath), { recursive: true })
  if (existsSync(logPath)) {
    const existing = readFileSync(logPath, 'utf8')
    // Insert after the "# 构建日志\n" header line
    const headerEnd = existing.indexOf('\n')
    if (headerEnd >= 0 && existing.startsWith('# ')) {
      writeFileSync(logPath, `${existing.slice(0, headerEnd + 1)}\n${block}${existing.slice(headerEnd + 1)}`, 'utf8')
    } else {
      writeFileSync(logPath, `${block}${existing}`, 'utf8')
    }
  } else {
    writeFileSync(logPath, `# 构建日志\n\n${block}`, 'utf8')
  }
}

/**
 * Rewrite wiki/hot.md with current build status (~500 words).
 * @param {object} paths
 * @param {object} state
 * @param {object} plan
 */
export function writeHotCache(paths, state, plan) {
  const vault = resolve(paths.root, '..', '..')
  const hotPath = join(vault, 'wiki', 'hot.md')
  const totalBatches = Object.keys(state.batches ?? {}).length
  const completedBatches = Object.values(state.batches ?? {}).filter(
    (b) => b.status === 'succeeded' || b.status === 'failed' || b.status === 'skipped',
  ).length

  // Recent 5 topics with page counts
  const topicPageCounts = new Map()
  for (const page of Object.values(state.pages ?? {})) {
    const tid = page.topicId
    topicPageCounts.set(tid, (topicPageCounts.get(tid) ?? 0) + 1)
  }
  const topicById = new Map()
  const walkTopics = (nodes) => {
    for (const node of nodes ?? []) {
      topicById.set(node.id, node)
      if (node.children) walkTopics(node.children)
    }
  }
  walkTopics(plan.topics)
  const recentTopics = [...topicPageCounts.entries()]
    .slice(-5)
    .map(([tid, count]) => `- ${topicById.get(tid)?.name ?? tid}: ${count} 页`)

  // Failed / skipped files
  const failedFiles = Object.entries(state.files ?? {})
    .filter(([, f]) => f.status === 'failed')
    .map(([id]) => id)
  const skippedFiles = Object.entries(state.files ?? {})
    .filter(([, f]) => f.status === 'skipped')
    .map(([id]) => id)

  const lines = [
    '# 构建状态缓存\n',
    `\n- Phase: ${state.phase ?? 'unknown'}`,
    `- 批次进度: ${completedBatches}/${totalBatches}`,
    `\n## 最近主题\n`,
    ...(recentTopics.length > 0 ? recentTopics : ['- （暂无）']),
  ]
  if (failedFiles.length > 0) {
    lines.push(`\n## 失败文件\n`, ...failedFiles.map((f) => `- ${f}`))
  }
  if (skippedFiles.length > 0) {
    lines.push(`\n## 跳过文件\n`, ...skippedFiles.map((f) => `- ${f}`))
  }
  lines.push('')
  mkdirSync(dirname(hotPath), { recursive: true })
  writeFileSync(hotPath, lines.join('\n'), 'utf8')
}

/**
 * Incrementally rebuild indexes after a checkpoint.
 * Rebuilds only the affected leaf topic + ancestor chain, appends to log.md,
 * and rewrites hot.md.
 * @param {object} paths
 * @param {object} plan
 * @param {object} state
 * @param {string} topicId
 * @param {{ succeeded: number, failed: number, skipped: number, pages: number, topics: string[] }} [logEntry]
 * @returns {{ indexesWritten: number, logAppended: boolean }}
 */
export function rebuildAfterCheckpoint(paths, plan, state, topicId, logEntry) {
  const { topicById, topicPathMap, parentMap, pathToTopic } = buildTopicMaps(plan.topics ?? [])

  // Identify the topic chain: topicId and all ancestors
  const chain = new Set()
  let current = topicId
  while (current) {
    chain.add(current)
    current = parentMap.get(current) ?? null
  }

  // Build lenient model (no summaries required).
  // Note: root/branch indexes get empty summaries pre-finalize — this is
  // expected. Real topic summaries arrive at finalize time via buildIndexModel.
  const model = buildIndexModelLenient(plan, state.pages, {})

  // Filter to only affected indexes
  const affectedModel = filterAffectedIndexes(model, chain, pathToTopic)

  // Write only affected indexes
  const hashes = writeIndexes(paths, affectedModel)

  // Append build log
  if (logEntry) {
    appendBuildLog(paths, logEntry)
  }

  // Rewrite hot cache
  writeHotCache(paths, state, plan)

  return { indexesWritten: Object.keys(hashes).length, logAppended: !!logEntry }
}

/**
 * Orchestrate: read state + plan → buildIndexModel → verifyCoverage (optional) →
 * writeIndexes → update state phase.
 * @param {object} paths
 * @param {Record<string, { summary: string }>} summaries
 * @param {{ verify?: boolean }} [options]
 * @returns {{ phase: string, succeeded: number, failed: number, skipped: number, indexes: Record<string, string> }}
 */
export function finalizeBuild(paths, summaries, options = {}) {
  const vault = resolve(paths.root, '..', '..');
  const state = readJson(paths.state);
  const plan = readJson(paths.plan);

  // Reject if activeBatchId is set or any batch is pending/running
  if (state.activeBatchId) {
    throw codedError('BATCHES_STILL_PENDING',
      `Active batch ${state.activeBatchId} must be completed before finalizing`,
      { activeBatchId: state.activeBatchId });
  }
  for (const [batchId, batch] of Object.entries(state.batches)) {
    if (batch.status === 'pending' || batch.status === 'running') {
      throw codedError('BATCHES_STILL_PENDING',
        `Batch ${batchId} is ${batch.status}`,
        { batchId, status: batch.status });
    }
  }

  // Check source pages exist on disk
  const missingPages = [];
  for (const [pagePath] of Object.entries(state.pages)) {
    const absPath = join(vault, pagePath);
    if (!existsSync(absPath)) {
      missingPages.push(pagePath);
    }
  }
  if (missingPages.length > 0) {
    throw codedError('SOURCE_PAGE_MISSING',
      `${missingPages.length} source page(s) missing from disk`,
      { codes: ['SOURCE_PAGE_MISSING'], missingPages });
  }

  // Build index model
  const model = buildIndexModel(plan, state.pages, summaries);

  // Verify coverage (optional, only when --verify is passed)
  if (options.verify) {
    const coverage = verifyCoverage(model);
    if (!coverage.ok) {
      if (coverage.missing.length > 0) {
        throw codedError('SOURCE_PAGE_MISSING',
          'Some pages are not covered by indexes',
          { codes: ['SOURCE_PAGE_MISSING'], missing: coverage.missing });
      }
      if (coverage.duplicates.length > 0) {
        throw codedError('DUPLICATE_PAGE',
          'Some pages appear multiple times in indexes',
          { codes: ['DUPLICATE_PAGE'], duplicates: coverage.duplicates });
      }
    }
  }

  // Write indexes
  const hashes = writeIndexes(paths, model);

  // Determine phase
  const hasFailed = Object.values(state.files).some((f) => f.status === 'failed');
  const hasSkipped = Object.values(state.files).some((f) => f.status === 'skipped');
  const phase = hasFailed || hasSkipped ? 'completed_with_errors' : 'completed';

  // Update state
  state.phase = phase;
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(paths.state, state);

  // Count file statuses
  const succeeded = Object.values(state.files).filter((f) => f.status === 'succeeded').length;
  const failed = Object.values(state.files).filter((f) => f.status === 'failed').length;
  const skipped = Object.values(state.files).filter((f) => f.status === 'skipped').length;

  return { phase, succeeded, failed, skipped, indexes: hashes };
}

/**
 * Merge pageUpdates into state.pages, write state, then rebuild ONLY the
 * index chain for topicId and its ancestors.
 * @param {object} opts
 * @param {object} opts.paths
 * @param {object} opts.plan
 * @param {object} opts.state
 * @param {string} opts.topicId
 * @param {Array} opts.pageUpdates
 * @param {Record<string, { summary: string }>} opts.summaries
 * @returns {{ hashes: Record<string, string> }}
 */
export function reindexTopicAndAncestors({ paths, plan, state, topicId, pageUpdates, summaries }) {
  const vault = resolve(paths.root, '..', '..');
  const { topicById, topicPathMap, parentMap, pathToTopic } = buildTopicMaps(plan.topics ?? []);

  if (!topicById.has(topicId)) {
    throw codedError('TOPIC_NOT_FOUND', `Topic ${topicId} not found in plan`, { topicId });
  }

  // Merge pageUpdates into state.pages
  const next = structuredClone(state);
  for (const update of pageUpdates) {
    if (update.remove) {
      delete next.pages[update.path];
    } else {
      next.pages[update.path] = {
        sha256: update.sha256 ?? null,
        topicId: update.topicId,
        type: update.type,
        title: update.title,
        summary: update.summary,
        updatedAt: new Date().toISOString(),
      };
    }
  }
  next.updatedAt = new Date().toISOString();
  atomicWriteJson(paths.state, next);

  // Identify the topic chain: topicId and all ancestors
  const chain = new Set();
  let current = topicId;
  while (current) {
    chain.add(current);
    current = parentMap.get(current) ?? null;
  }

  // Build full model
  const model = buildIndexModel(plan, next.pages, summaries);

  // Filter to only affected indexes
  const affectedModel = filterAffectedIndexes(model, chain, pathToTopic);

  const hashes = writeIndexes(paths, affectedModel);

  // Clean up stale shard directories for affected leaf topics
  for (const tid of chain) {
    const topic = topicById.get(tid);
    if (topic?.kind !== 'leaf') continue;
    const topicPath = topicPathMap.get(tid);
    const shardDir = join(vault, 'wiki', ...topicPath, 'index-shards');
    if (!existsSync(shardDir)) continue;
    const hasShards = Object.keys(affectedModel.indexes).some(
      (p) => p.includes(`${topicPath.join('/')}/index-shards/`),
    );
    if (!hasShards) {
      for (const file of readdirSync(shardDir)) {
        try { unlinkSync(join(shardDir, file)); } catch { /* best effort */ }
      }
      try { rmdirSync(shardDir); } catch { /* best effort */ }
    }
  }

  return { hashes };
}
