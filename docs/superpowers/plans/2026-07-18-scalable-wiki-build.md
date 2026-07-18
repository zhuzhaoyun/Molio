# Scalable Wiki Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, resumable Wiki build workflow that scans large vaults safely, freezes an approved semantic topic plan, executes bounded batches, and generates recursively layered indexes without adding a daemon API.

**Architecture:** A pure Node.js CLI ships inside the built-in wiki-build Skill. The CLI owns inventory, plan validation, state transitions, checkpoint journals, and index generation under .molio/wiki-build; the runtime Agent owns semantic classification, document conversion, and Wiki prose. Existing daemon code continues to launch runtime agents, while the query prompt learns to walk recursive INDEX files.

**Tech Stack:** Node.js 24 standard library, ECMAScript modules, TypeScript 5.8 tests, node:test, pnpm workspace scripts.

## Global Constraints

- Installed Skill scripts may use only the Node.js standard library.
- Store build working data under .molio/wiki-build; do not place process files in the vault root.
- Do not write wiki pages or wiki indexes before the user approves the plan.
- Preserve source files byte-for-byte; scanners and preprocessors may only read them.
- Use semantic grouping before capacity splitting; unrelated single files may form separate leaf topics.
- Default capacity values are maxLeafPages=200, maxLeafIndexTokens=12000, and maxTopicDepth=6.
- A capacity split must create at least two children and use the fewest coherent children that satisfy the limits.
- Use deterministic index shards when a topic cannot split or reaches depth six.
- Do not reject a build solely because topic depth, page count, or INDEX size exceeds a leaf capacity limit.
- Execute one batch at a time in phase one.
- Keep legacy flat Wikis readable and queryable; do not migrate them automatically.
- Keep MAX_DIR_ENTRIES=1000 and MAX_TOTAL=50000 aligned with apps/daemon/src/core/vault-prune.ts.
- Do not add FTS5, BM25, vector search, a Wiki search API, or a runtime-to-daemon callback.
- Do not add a daemon endpoint for build state; the CLI and files remain the execution boundary.

---

## File Structure

### New production files

- apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs
  - CLI argument parsing, JSON output envelope, command dispatch, and exit codes.
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/contracts.mjs
  - Schema constants, JSDoc data contracts, extension support, capacity defaults, and state enums.
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/workspace.mjs
  - Vault path validation, safe relative paths, atomic writes, JSON/JSONL helpers, hashing, and mutation locks.
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/inventory.mjs
  - Bounded traversal, filtering, lightweight samples, fingerprints, support detection, duplicate candidates, and inventory digest.
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/plan.mjs
  - Plan validation, topic-tree validation, file coverage, batch validation, version freeze, and approved-plan history.
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/preprocess.mjs
  - Text, JSONL, large JSON, and externally normalized document work-item preparation with bounded chunks.
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/state.mjs
  - Initial state, status, next-batch claim, attempt fencing, recovery, failure isolation, staging, commit journals, and idempotent checkpoint.
- apps/daemon/src/tools/skills/wiki-build/scripts/lib/indexes.mjs
  - Bottom-up topic summaries, leaf indexes, deterministic shards, ancestor indexes, final coverage checks, and targeted ingest reindexing.

### New tests and documentation

- apps/daemon/test/tools/wiki-build-test-helpers.ts
- apps/daemon/test/tools/wiki-build-cli.test.ts
- apps/daemon/test/tools/wiki-build-scan.test.ts
- apps/daemon/test/tools/wiki-build-plan.test.ts
- apps/daemon/test/tools/wiki-build-preprocess.test.ts
- apps/daemon/test/tools/wiki-build-state.test.ts
- apps/daemon/test/tools/wiki-build-indexes.test.ts
- apps/daemon/test/tools/wiki-build-workflow.test.ts
- apps/daemon/test/routes/graph.test.ts
- apps/desktop/test/wiki-build-resources.test.js
- docs/wiki-build-acceptance.md

### Existing files to modify

- apps/daemon/src/tools/skills/wiki-build/SKILL.md
- apps/daemon/src/tools/skills/wiki-ingest/SKILL.md
- apps/daemon/src/core/wiki-prompts.ts
- apps/daemon/test/tools/builtin-skills.test.ts
- apps/daemon/test/core/skill-installer.test.ts
- apps/daemon/test/core/weixin/wiki-sys-prompt-files.test.ts
- apps/daemon/src/routes/graph.ts

---

### Task 1: Establish the CLI, contracts, and safe workspace primitives

**Files:**
- Create: apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs
- Create: apps/daemon/src/tools/skills/wiki-build/scripts/lib/contracts.mjs
- Create: apps/daemon/src/tools/skills/wiki-build/scripts/lib/workspace.mjs
- Create: apps/daemon/test/tools/wiki-build-test-helpers.ts
- Create: apps/daemon/test/tools/wiki-build-cli.test.ts

**Interfaces:**
- Produces: resolveBuildPaths(vaultPath) returning absolute paths for root, inventory, plan, state, samples, normalized, staging, journals, and planHistory.
- Produces: atomicWriteJson(path, value), writeJsonLines(path, records), readJson(path), sha256(value), and withMutationLock(paths, fn).
- Produces: runWikiBuildCli(vaultPath, args) test helper returning parsed stdout, stderr, and exit status.
- Produces: CLI envelope { ok, command, data?, error?: { code, message, details? } }.

- [ ] **Step 1: Write the failing CLI contract test**

~~~ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeVault, runWikiBuildCli } from './wiki-build-test-helpers.js';

describe('wiki-build CLI', () => {
  it('reports not_started without creating wiki/', () => {
    const vault = makeVault();
    const result = runWikiBuildCli(vault.path, ['status', '--json']);
    assert.equal(result.status, 0);
    assert.deepEqual(result.json, {
      ok: true,
      command: 'status',
      data: { phase: 'not_started' },
    });
    assert.equal(existsSync(join(vault.path, 'wiki')), false);
    vault.cleanup();
  });

  it('rejects a vault-relative path that escapes the vault', () => {
    const vault = makeVault();
    const result = runWikiBuildCli(vault.path, ['scan', '--include', '../outside.md', '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'PATH_OUTSIDE_VAULT');
    vault.cleanup();
  });
});
~~~

- [ ] **Step 2: Add the shared test helper**

~~~ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const daemonRoot = resolve(import.meta.dirname, '..', '..', '..');
const cli = join(
  daemonRoot,
  'src',
  'tools',
  'skills',
  'wiki-build',
  'scripts',
  'wiki-build.mjs',
);

export function makeVault() {
  const path = mkdtempSync(join(tmpdir(), 'molio-wiki-build-'));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function runWikiBuildCli(vaultPath: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, '--vault', vaultPath], {
    cwd: vaultPath,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}
~~~

- [ ] **Step 3: Run the test and verify the missing CLI failure**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-cli.test.js
~~~

Expected: FAIL because scripts/wiki-build.mjs does not exist.

- [ ] **Step 4: Implement contracts, safe paths, atomic writes, and status**

Add these exact exported constants to contracts.mjs:

~~~js
export const SCHEMA_VERSION = 1;
export const MAX_DIR_ENTRIES = 1000;
export const MAX_TOTAL = 50000;
export const DEFAULT_CAPACITY = Object.freeze({
  maxLeafPages: 200,
  maxLeafIndexTokens: 12000,
  maxTopicDepth: 6,
});
export const FILE_STATUSES = Object.freeze([
  'pending', 'running', 'succeeded', 'failed', 'skipped',
]);
export const BATCH_STATUSES = FILE_STATUSES;
export const BUILD_PHASES = Object.freeze([
  'not_started', 'scanned', 'draft', 'approved', 'running',
  'paused', 'completed', 'completed_with_errors',
]);
~~~

Implement workspace.mjs so every mutation:

1. resolves the vault with realpath,
2. rejects paths outside that root,
3. writes a sibling .tmp file,
4. fsyncs and renames the file,
5. uses .molio/wiki-build/.lock with openSync(..., 'wx') around state mutations,
6. removes the lock in a finally block.

Implement wiki-build.mjs with a parseArgs function and a status handler. Status reads state.json when present, then plan.json, then inventory.jsonl, and otherwise returns phase=not_started. Print one JSON object to stdout for --json; write errors to the same JSON envelope and exit with status 2.

- [ ] **Step 5: Run the focused test**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-cli.test.js
~~~

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-test-helpers.ts apps/daemon/test/tools/wiki-build-cli.test.ts
git commit -m "feat(wiki): add deterministic build cli"
~~~

---

### Task 2: Generate a bounded inventory and lightweight samples

**Files:**
- Create: apps/daemon/src/tools/skills/wiki-build/scripts/lib/inventory.mjs
- Create: apps/daemon/test/tools/wiki-build-scan.test.ts
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs

**Interfaces:**
- Produces: scanVault({ vaultPath, includePaths?, contentHash?, maxDirEntries?, maxTotal?, sampleBytes? }).
- Produces: InventoryRecord with id, path, extension, size, mtimeMs, quickFingerprint, contentHash?, title, encoding, samplePath?, processor, support, duplicateOf?, and risks.
- Consumes: atomic JSONL and hashing helpers from Task 1.

- [ ] **Step 1: Write scanner tests for filtering, sampling, formats, and caps**

~~~ts
it('writes deterministic inventory without reading wiki or hidden workspaces', () => {
  const vault = makeVault();
  writeFile(vault.path, 'notes/economy.md', '# Economy\n' + 'x'.repeat(20_000));
  writeFile(vault.path, 'slides.pptx', 'fake-office');
  writeFile(vault.path, 'archive.zip', 'fake-zip');
  writeFile(vault.path, 'wiki/old.md', 'ignore me');
  writeFile(vault.path, '.molio/private.md', 'ignore me');

  const result = runWikiBuildCli(vault.path, ['scan', '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.json.data.counts.total, 3);

  const records = readInventory(vault.path);
  assert.deepEqual(records.map((record) => record.path), [
    'archive.zip',
    'notes/economy.md',
    'slides.pptx',
  ]);
  assert.equal(records[1].title, 'Economy');
  assert.equal(records[1].processor, 'text');
  assert.equal(records[2].processor, 'docling');
  assert.equal(records[0].support, 'needs-confirmation');
  assert.ok(records[1].samplePath.startsWith('.molio/wiki-build/samples/'));
  vault.cleanup();
});

it('records directory and total-limit errors instead of crashing', () => {
  const vault = makeVault();
  createFiles(vault.path, 'dump', 4);
  const result = runWikiBuildCli(vault.path, [
    'scan', '--max-dir-entries', '3', '--max-total', '2', '--json',
  ]);
  assert.equal(result.status, 0);
  assert.ok(result.json.data.errors.some((error) => error.code === 'DIRECTORY_LIMIT'));
  vault.cleanup();
});
~~~

The local writeFile helper in this test must create parent directories before writing. readInventory parses inventory.jsonl line by line.

- [ ] **Step 2: Run the scanner tests and confirm failure**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-scan.test.js
~~~

Expected: FAIL because the scan command is not registered.

- [ ] **Step 3: Implement deterministic traversal and samples**

Use these format groups in contracts.mjs:

~~~js
export const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.html',
]);
export const DOCLING_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
]);
export const CONFIRM_EXTENSIONS = new Set(['.zip', '.rar', '.ifc']);
export const PRUNED_NAMES = new Set([
  'wiki', 'node_modules', 'bower_components', 'jspm_packages',
  'dist', 'build', 'out', 'target', '__pycache__', '.venv',
]);
~~~

inventory.mjs must:

- sort directory entries by normalized relative path,
- skip dot-prefixed directories and PRUNED_NAMES,
- read at most sampleBytes from the head and sampleBytes from the tail,
- validate UTF-8 with TextDecoder('utf-8', { fatal: true }),
- detect the first Markdown heading as title and otherwise use the filename stem,
- hash size, mtimeMs, head bytes, and tail bytes for quickFingerprint,
- compute contentHash only when --content-hash is present,
- mark same-size and same quickFingerprint records as duplicate candidates,
- write inventory.jsonl and a SHA-256 digest over its exact bytes,
- leave wiki/ absent.

Register scan in wiki-build.mjs. A full scan writes inventory.jsonl. scan --include PATH writes ingest-candidate.jsonl and must not replace the frozen inventory.

- [ ] **Step 4: Run focused and existing traversal tests**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-scan.test.js apps/daemon/dist/test/core/knowledge.test.js
~~~

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-scan.test.ts
git commit -m "feat(wiki): add bounded vault inventory"
~~~

---

### Task 3: Validate, version, and freeze semantic topic plans

**Files:**
- Create: apps/daemon/src/tools/skills/wiki-build/scripts/lib/plan.mjs
- Create: apps/daemon/test/tools/wiki-build-plan.test.ts
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs
- Modify: apps/daemon/test/tools/wiki-build-test-helpers.ts

**Interfaces:**
- Produces: validatePlan(candidate, inventory, inventoryDigest).
- Produces: saveDraft(paths, candidate) and approvePlan(paths, candidate).
- Produces: TopicNode, FileAssignment, and Batch contracts.
- Consumes: DEFAULT_CAPACITY and safe atomic writers.

- [ ] **Step 1: Add exact plan fixture builders**

Add makePlanFixture to wiki-build-test-helpers.ts. Its return value must use this shape:

~~~ts
{
  schemaVersion: 1,
  planVersion: 1,
  status: 'draft',
  inventoryDigest,
  createdAt: '2026-07-18T00:00:00.000Z',
  capacity: {
    maxLeafPages: 200,
    maxLeafIndexTokens: 12000,
    maxTopicDepth: 6,
  },
  topics: [
    {
      id: 'economy',
      name: '经济',
      slug: '经济',
      kind: 'leaf',
      depth: 1,
      summary: '经济政策与市场',
      rationale: '该文件讨论宏观经济。',
      estimatedPages: 1,
      estimatedIndexTokens: 40,
      fileIds: ['economy-file'],
      indexStrategy: 'inline',
    },
    {
      id: 'motorcycle',
      name: '摩托车维修',
      slug: '摩托车维修',
      kind: 'leaf',
      depth: 1,
      summary: '摩托车故障诊断与维修',
      rationale: '该文件讨论机械维修。',
      estimatedPages: 1,
      estimatedIndexTokens: 40,
      fileIds: ['motorcycle-file'],
      indexStrategy: 'inline',
    },
  ],
  assignments: [
    { fileId: 'economy-file', primaryTopicId: 'economy', relatedTopicIds: [], processor: 'text' },
    { fileId: 'motorcycle-file', primaryTopicId: 'motorcycle', relatedTopicIds: [], processor: 'text' },
  ],
  batches: [
    { id: 'economy-001', topicId: 'economy', order: 1, fileIds: ['economy-file'], estimatedInputTokens: 500 },
    { id: 'motorcycle-001', topicId: 'motorcycle', order: 2, fileIds: ['motorcycle-file'], estimatedInputTokens: 500 },
  ],
  batchPolicy: {
    maxFiles: 50,
    contextWindowTokens: 100000,
    maxInputFraction: 0.2,
    maxInputTokens: 20000,
  },
  excluded: [],
  undecided: [],
}
~~~

- [ ] **Step 2: Write plan validation and freeze tests**

~~~ts
it('accepts unrelated single-file leaf topics', () => {
  const fixture = makeScannedTwoFileVault();
  const candidate = makePlanFixture(fixture.inventoryDigest);
  const result = runPlan(fixture.vault, candidate, 'validate');
  assert.equal(result.status, 0);
  assert.equal(result.json.data.topicCounts.leaf, 2);
  assert.equal(existsSync(join(fixture.vault, 'wiki')), false);
});

it('rejects a branch with one child and a capacity branch below its limit', () => {
  const fixture = makeScannedTwoFileVault();
  const candidate = makePlanFixture(fixture.inventoryDigest);
  candidate.topics = [{
    id: 'root-child',
    name: '多余层级',
    slug: '多余层级',
    kind: 'branch',
    depth: 1,
    splitReason: 'capacity',
    estimatedPages: 2,
    estimatedIndexTokens: 80,
    children: [candidate.topics[0]],
  }];
  const result = runPlan(fixture.vault, candidate, 'validate');
  assert.equal(result.status, 2);
  assert.deepEqual(result.json.error.details.codes, [
    'BRANCH_REQUIRES_TWO_CHILDREN',
    'CAPACITY_SPLIT_BELOW_LIMIT',
  ]);
});

it('freezes an approved version and refuses in-place overwrite', () => {
  const fixture = makeScannedTwoFileVault();
  const candidate = makePlanFixture(fixture.inventoryDigest);
  assert.equal(runPlan(fixture.vault, candidate, 'approve').status, 0);
  const second = runPlan(fixture.vault, candidate, 'approve');
  assert.equal(second.status, 2);
  assert.equal(second.json.error.code, 'PLAN_VERSION_FROZEN');
});
~~~

- [ ] **Step 3: Run the plan tests and confirm failure**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-plan.test.js
~~~

Expected: FAIL because the plan command is not registered.

- [ ] **Step 4: Implement schema and structural validation**

validatePlan must return all validation errors in one response and enforce:

- inventoryDigest matches the scan,
- planVersion is a positive integer,
- each topic id and slug is unique,
- topic depth matches its location and is at most maxTopicDepth,
- branches have at least two children and no fileIds,
- leaves have fileIds and no children,
- single-file leaves are valid,
- capacity branches declare splitReason=capacity and exceed a configured limit,
- leaves over a limit either split or declare indexStrategy=shards,
- reserved names INDEX.md, log.md, hot.md, and meta cannot be topic slugs,
- every inventory file appears exactly once in assignments, excluded, or undecided,
- every assignment points to a leaf,
- batchPolicy.maxInputFraction is between 0.2 and 0.3, maxInputTokens equals floor(contextWindowTokens * maxInputFraction), batches are globally ordered, topic-local order is stable, file ids exist, ordinary batches contain at most 50 files, and estimatedInputTokens does not exceed maxInputTokens.

validate mode writes plan-draft.json only. approve mode writes plan.json with status=approved, approvedAt, and planDigest; it also copies the immutable version to plan-history/plan-v0001.json. A later plan must increment planVersion and preserve the prior history file.

- [ ] **Step 5: Run focused tests**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-plan.test.js
~~~

Expected: all plan tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-plan.test.ts apps/daemon/test/tools/wiki-build-test-helpers.ts
git commit -m "feat(wiki): freeze validated topic plans"
~~~

---

### Task 4: Prepare bounded work items for text, JSON, and normalized documents

**Files:**
- Create: apps/daemon/src/tools/skills/wiki-build/scripts/lib/preprocess.mjs
- Create: apps/daemon/test/tools/wiki-build-preprocess.test.ts
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/lib/contracts.mjs

**Interfaces:**
- Produces: prepareWorkItems({ paths, batch, inputManifest, policy }).
- Produces: chunkMarkdown(text, policy), chunkPlainText(text, policy), chunkJsonl(path, policy), and summarizeJsonStream(path, fieldPolicy).
- Consumes an external normalization entry { fileId, sourcePath, normalizedPath, processor, processorVersion } for PDF, PPTX, and DOCX.
- Produces prepared work items with id, fileId, normalizedPath, byteStart, byteEnd, estimatedTokens, overlap, and contentHash.

- [ ] **Step 1: Write bounded preprocessing tests**

~~~ts
it('splits Markdown on headings before using overlapping windows', () => {
  const fixture = markdownPreparationFixture([
    '# One',
    'a'.repeat(120),
    '# Two',
    'b'.repeat(120),
  ].join('\n'), { maxInputTokens: 60 });
  const result = prepareWorkItems(fixture);
  assert.ok(result.workItems.length >= 2);
  assert.equal(result.workItems[0].heading, 'One');
  assert.equal(result.workItems[1].heading, 'Two');
  assert.ok(result.workItems.every((item) => item.estimatedTokens <= 60));
});

it('streams JSONL into bounded parts without loading the whole file', () => {
  const fixture = jsonlPreparationFixture(100, { maxInputTokens: 80 });
  const result = prepareWorkItems(fixture);
  assert.ok(result.workItems.length > 1);
  assert.equal(result.strategy, 'jsonl-stream');
  assert.ok(result.workItems.every((item) => item.byteEnd > item.byteStart));
});

it('requires a field policy for a large JSON object', () => {
  const fixture = largeJsonPreparationFixture();
  assert.throws(
    () => prepareWorkItems(fixture),
    (error) => error.code === 'JSON_FIELD_POLICY_REQUIRED',
  );
});

it('hashes and registers docling Markdown without changing the source', () => {
  const fixture = officePreparationFixture('report.pptx');
  const before = readFileSync(fixture.source);
  const normalized = writeNormalizedMarkdown(fixture.vault, '# Report');
  const result = prepareWorkItems({
    ...fixture,
    external: [{
      fileId: fixture.fileId,
      sourcePath: 'report.pptx',
      normalizedPath: normalized,
      processor: 'docling',
      processorVersion: '2.x',
    }],
  });
  assert.deepEqual(readFileSync(fixture.source), before);
  assert.match(result.workItems[0].contentHash, /^[a-f0-9]{64}$/);
});
~~~

- [ ] **Step 2: Run the preprocessing tests and verify failure**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-preprocess.test.js
~~~

Expected: FAIL because lib/preprocess.mjs does not exist.

- [ ] **Step 3: Implement deterministic chunk preparation**

Use this exact policy contract:

~~~js
{
  maxInputTokens: 20000,
  tokenEstimate: 'utf8-bytes-div-3',
  fallbackWindowChars: 30000,
  overlapChars: 1000,
  jsonlMaxLines: 500,
}
~~~

preprocess.mjs must:

- calculate estimatedTokens as Math.ceil(Buffer.byteLength(text, 'utf8') / 3),
- preserve heading text and source byte ranges for Markdown chunks,
- use fallbackWindowChars with overlapChars when a heading section remains too large,
- stream JSONL with node:readline and close each part before it exceeds maxInputTokens,
- scan large JSON with a string/escape/depth state machine that records top-level keys and value types without retaining values,
- require an approved fieldPolicy before extracting large JSON values,
- verify external normalized paths live under .molio/wiki-build/normalized,
- record processor name, version, source content hash, and normalized content hash,
- write prepared/<batchId>-<attemptToken>.json atomically,
- refuse any work item whose estimatedTokens exceeds maxInputTokens.

Task 5 registers prepare --batch-id ID --attempt-token TOKEN --input MANIFEST --json after state.mjs can validate the active batch and attempt token.

- [ ] **Step 4: Run preprocessing and scanner tests**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-preprocess.test.js apps/daemon/dist/test/tools/wiki-build-scan.test.js
~~~

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-preprocess.test.ts
git commit -m "feat(wiki): prepare bounded build inputs"
~~~

---

### Task 5: Add resumable state, fenced attempts, and idempotent checkpoint journals

**Files:**
- Create: apps/daemon/src/tools/skills/wiki-build/scripts/lib/state.mjs
- Create: apps/daemon/test/tools/wiki-build-state.test.ts
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/lib/plan.mjs
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/lib/preprocess.mjs

**Interfaces:**
- Produces: initializeState(plan), getStatus(paths), claimNextBatch(paths), recoverRunning(paths), and checkpointBatch(paths, result).
- Produces: prepareClaimedBatch(paths, batchId, attemptToken, inputManifest), which validates the claim before calling prepareWorkItems.
- Produces: skipFile(paths, fileId, reason) and retryFailedFile(paths, fileId).
- next returns batchId, attemptToken, attempt, topicId, file records, and stagingDir.
- checkpoint consumes { batchId, attemptToken, files, pages, error? }.
- A page result contains path, topicId, type, title, summary, stagedPath, and sha256.

- [ ] **Step 1: Write state transition, failure isolation, and stale-attempt tests**

~~~ts
it('claims one batch and fences stale workers after recovery', () => {
  const fixture = approveTwoBatchPlan();
  const first = runWikiBuildCli(fixture.vault, ['next', '--json']);
  assert.equal(first.json.data.batch.id, 'economy-001');
  assert.ok(first.json.data.attemptToken);

  const blocked = runWikiBuildCli(fixture.vault, ['next', '--json']);
  assert.equal(blocked.status, 2);
  assert.equal(blocked.json.error.code, 'BATCH_ALREADY_RUNNING');

  runWikiBuildCli(fixture.vault, ['status', '--recover', '--json']);
  const retried = runWikiBuildCli(fixture.vault, ['next', '--json']);
  assert.notEqual(retried.json.data.attemptToken, first.json.data.attemptToken);

  const stale = checkpoint(fixture.vault, {
    batchId: 'economy-001',
    attemptToken: first.json.data.attemptToken,
    files: [],
    pages: [],
  });
  assert.equal(stale.status, 2);
  assert.equal(stale.json.error.code, 'STALE_ATTEMPT');
});

it('isolates one failed file and retries checkpoint without duplicate output', () => {
  const fixture = approveOneBatchPlanWithTwoFiles();
  const claim = runWikiBuildCli(fixture.vault, ['next', '--json']).json.data;
  stagePage(fixture.vault, claim.stagingDir, 'wiki/经济/sources/经济.md', '# 经济');

  const payload = {
    batchId: claim.batch.id,
    attemptToken: claim.attemptToken,
    files: [
      { fileId: 'economy-file', status: 'succeeded', contentHash: 'a'.repeat(64) },
      { fileId: 'bad-file', status: 'failed', error: { code: 'PREPROCESS_FAILED', message: 'docling exit 1' } },
    ],
    pages: [{
      path: 'wiki/经济/sources/经济.md',
      topicId: 'economy',
      type: 'source',
      title: '经济',
      summary: '经济摘要',
      stagedPath: 'wiki/经济/sources/经济.md',
    }],
  };

  assert.equal(checkpoint(fixture.vault, payload).status, 0);
  assert.equal(checkpoint(fixture.vault, payload).status, 0);
  assert.equal(readFileSync(join(fixture.vault, payload.pages[0].path), 'utf8'), '# 经济');
  assert.equal(readState(fixture.vault).files['bad-file'].status, 'failed');
});

it('skips pending work and retries only the selected failed file', () => {
  const fixture = approvedPlanWithFailedAndPendingFiles();
  const skipped = runWikiBuildCli(fixture.vault, [
    'skip', '--file-id', 'pending-file', '--reason', 'unsupported format', '--json',
  ]);
  assert.equal(skipped.status, 0);
  assert.equal(readState(fixture.vault).files['pending-file'].status, 'skipped');

  const retried = runWikiBuildCli(fixture.vault, [
    'retry', '--file-id', 'failed-file', '--json',
  ]);
  assert.equal(retried.status, 0);
  assert.equal(retried.json.data.batch.fileIds.length, 1);
  assert.deepEqual(retried.json.data.batch.fileIds, ['failed-file']);
  assert.equal(readState(fixture.vault).files['already-succeeded'].status, 'succeeded');
});

it('refuses a batch when a source changed after plan approval', () => {
  const fixture = approveOneBatchPlan();
  appendFileSync(join(fixture.vault, 'economy.md'), '\nchanged after approval');
  const result = runWikiBuildCli(fixture.vault, ['next', '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.json.error.code, 'SOURCE_CHANGED_SINCE_SCAN');
  assert.equal(existsSync(join(fixture.vault, 'wiki')), false);
});
~~~

- [ ] **Step 2: Run the state tests and verify failure**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-state.test.js
~~~

Expected: FAIL because next, recovery, and checkpoint are not registered.

- [ ] **Step 3: Implement initial state and serial claims**

approvePlan must create state.json in the same mutation lock. State contains:

~~~js
{
  schemaVersion: 1,
  planVersion: 1,
  planDigest: '...',
  phase: 'approved',
  activeBatchId: null,
  batches: {
    'economy-001': {
      status: 'pending',
      attempts: 0,
      attemptToken: null,
      lastError: null,
    },
  },
  files: {
    'economy-file': {
      status: 'pending',
      attempts: 0,
      contentHash: null,
      lastError: null,
    },
  },
  pages: {},
  updatedAt: '...',
}
~~~

claimNextBatch must refuse while activeBatchId is non-null, select the lowest pending global order, increment attempts, assign randomUUID() as attemptToken, create staging/<attemptToken>, and atomically persist state before returning.

Before claiming, compare each source path, size, mtimeMs, and quick fingerprint with the approved inventory. Refuse the claim with SOURCE_CHANGED_SINCE_SCAN when a planned source changed or disappeared; do not substitute current content into the frozen plan.

status --recover must change running batch and file states to pending, clear activeBatchId, and preserve attempt counts and errors. A recovered claim receives a new attemptToken.

Register prepare in wiki-build.mjs. It must validate batchId and attemptToken, call prepareWorkItems, write prepared/<batchId>-<attemptToken>.json atomically, and return the bounded work items without changing the batch status.

Register skip and retry in wiki-build.mjs. skip accepts pending or failed files, stores the reason, and marks a batch skipped when it has no remaining processable files. retry accepts a failed file, resets only that file to pending, and appends a one-file retry batch with a stable id retry-<fileId>-<nextAttempt>; it must not reset succeeded sibling files.

- [ ] **Step 4: Implement journaled checkpoint**

checkpointBatch must:

1. hash the canonical payload and inspect an existing journal,
2. return the stored result when a completed journal has the same payload hash,
3. validate batchId and attemptToken for a new or unfinished journal,
4. validate staged paths stay inside staging/<attemptToken>,
5. compute page hashes itself,
6. write journals/<batchId>.json with phase=prepared and the desired page map,
7. atomically replace each destination Wiki page,
8. write journal phase=applied,
9. update file, batch, page-manifest, and build states atomically,
10. write journal phase=completed,
11. keep the staging files until the state write succeeds.

If a completed journal receives the same payload, return the saved result. If a prepared or applied journal exists after a crash, replay files whose destination hash differs and finish the state transition. Reject a different payload for the same batch with CHECKPOINT_CONFLICT.

Failed file results do not fail succeeded siblings. A batch with both statuses returns succeeded_with_errors in its result summary while its queue status becomes succeeded, allowing next to continue.

- [ ] **Step 5: Run state and CLI tests**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-state.test.js apps/daemon/dist/test/tools/wiki-build-cli.test.js
~~~

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-state.test.ts
git commit -m "feat(wiki): add resumable batch checkpoints"
~~~

---

### Task 6: Generate recursive indexes, deterministic shards, and completion reports

**Files:**
- Create: apps/daemon/src/tools/skills/wiki-build/scripts/lib/indexes.mjs
- Create: apps/daemon/test/tools/wiki-build-indexes.test.ts
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs

**Interfaces:**
- Produces: estimateIndexTokens(markdown), buildIndexModel(plan, pages, summaries), writeIndexes(paths, model), verifyCoverage(model), and finalizeBuild(paths, summaries).
- Produces: reindexTopicAndAncestors({ paths, plan, state, topicId, pageUpdates, summaries }).
- finalize consumes a JSON map { [topicId]: { summary: string } }.
- Produces: root, branch, leaf, and shard INDEX Markdown plus a structured completion report.

- [ ] **Step 1: Write recursive hierarchy and shard tests**

~~~ts
it('writes root, branch, and leaf indexes bottom-up', () => {
  const fixture = completedThreeLevelBuild();
  const summaries = writeSummaries(fixture.vault, {
    engineering: { summary: '工程知识' },
    review: { summary: '规范审查' },
    fire: { summary: '消防规范' },
  });
  const result = runWikiBuildCli(fixture.vault, [
    'finalize', '--summaries', summaries, '--json',
  ]);
  assert.equal(result.status, 0);
  assert.match(readWiki(fixture.vault, 'INDEX.md'), /\[\[建筑工程\/INDEX\|建筑工程\]\]/);
  assert.match(readWiki(fixture.vault, '建筑工程/INDEX.md'), /\[\[建筑工程\/规范审查\/INDEX\|规范审查\]\]/);
  assert.match(readWiki(fixture.vault, '建筑工程/规范审查/消防规范/INDEX.md'), /sources\/消防规范/);
});

it('creates stable shards when actual leaf output exceeds capacity', () => {
  const fixture = completedLeafBuild({ maxLeafPages: 2, pageCount: 5 });
  const first = finalize(fixture);
  const firstFiles = listFiles(join(fixture.vault, 'wiki/topic/index-shards'));
  assert.deepEqual(firstFiles, ['concept-0001.md', 'concept-0002.md', 'concept-0003.md']);

  const second = finalize(fixture);
  assert.deepEqual(second.hashes, first.hashes);
  assert.match(readWiki(fixture.vault, 'topic/INDEX.md'), /concept-0001/);
});

it('refuses completion when succeeded sources or index entries are missing', () => {
  const fixture = completedLeafBuild({ deleteSourcePage: true });
  const result = finalize(fixture);
  assert.equal(result.status, 2);
  assert.deepEqual(result.json.error.details.codes, ['SOURCE_PAGE_MISSING']);
});

it('registers ingest page metadata and rebuilds only its ancestor chain', () => {
  const fixture = completedThreeLevelBuild();
  const beforeUnrelated = hashWiki(fixture.vault, '企业数字化/INDEX.md');
  const input = writeIngestResult(fixture.vault, {
    topicId: 'fire',
    pages: [{
      path: 'wiki/建筑工程/规范审查/消防规范/sources/新规范.md',
      type: 'source',
      title: '新规范',
      summary: '新增消防规范',
      sha256: 'b'.repeat(64),
    }],
  });
  const result = runWikiBuildCli(fixture.vault, [
    'reindex', '--topic-id', 'fire', '--input', input,
    '--summaries', fixture.summaries, '--json',
  ]);
  assert.equal(result.status, 0);
  assert.match(readWiki(fixture.vault, '建筑工程/规范审查/消防规范/INDEX.md'), /新规范/);
  assert.equal(hashWiki(fixture.vault, '企业数字化/INDEX.md'), beforeUnrelated);
});
~~~

- [ ] **Step 2: Run the index tests and verify failure**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-indexes.test.js
~~~

Expected: FAIL because finalize is not registered.

- [ ] **Step 3: Implement bottom-up index models**

Use Math.ceil(Buffer.byteLength(markdown, 'utf8') / 3) as the documented conservative token estimate. The index model must:

- map every page manifest record to one leaf topic,
- group leaf pages by type in this order: sources, entities, concepts, comparisons, questions, then lexical type order,
- sort entries by normalized title and relative path,
- render each entry as a path-qualified wikilink plus one-line summary,
- render branch indexes from direct child summaries only,
- render wiki/INDEX.md from top-level summaries only,
- require summaries for every topic,
- avoid reading descendant page bodies when rendering ancestors.

When a leaf exceeds either capacity limit, write index-shards/<type>-NNNN.md. Split after rendering entries so each shard respects both page count and token limits. Leaf INDEX lists shard type, title range, count, and summary.

- [ ] **Step 4: Implement completion validation and atomic output**

finalize must reject pending or running batches. It may complete with failed or skipped files, but must:

- report phase=completed_with_errors,
- require a source page for every succeeded source file,
- list every generated page exactly once across leaf indexes and shards,
- reject duplicate paths, missing files, path escapes, and dead internal index links,
- write all indexes through atomic text replacement,
- update state phase only after all index files pass a post-write verification scan.

Add a targeted reindex export for wiki-ingest:

~~~js
export async function reindexTopicAndAncestors({
  paths,
  plan,
  state,
  topicId,
  pageUpdates,
  summaries,
}) {
  const nextState = mergePageUpdates(state, pageUpdates);
  await atomicWriteJson(paths.state, nextState);
  return rebuildTopicChain({ paths, plan, state: nextState, topicId, summaries });
}
~~~

Register reindex --topic-id ID --input INGEST_RESULT --summaries SUMMARIES --json. Validate every page path exists, its hash matches, and its topicId equals the requested leaf before merging page metadata.

- [ ] **Step 5: Run focused tests**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-indexes.test.js apps/daemon/dist/test/tools/wiki-build-state.test.js
~~~

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-indexes.test.ts
git commit -m "feat(wiki): generate recursive topic indexes"
~~~

---

### Task 7: Prove the complete CLI workflow with crash recovery

**Files:**
- Create: apps/daemon/test/tools/wiki-build-workflow.test.ts
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/wiki-build.mjs
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/lib/state.mjs
- Modify: apps/daemon/src/tools/skills/wiki-build/scripts/lib/indexes.mjs

**Interfaces:**
- Consumes every CLI command: scan, plan, status, next, prepare, checkpoint, skip, retry, reindex, and finalize.
- Produces a stable command contract for both wiki-build and wiki-ingest Skill instructions.

- [ ] **Step 1: Write an end-to-end fixture test**

~~~ts
it('runs scan through finalize and resumes after a simulated crash', () => {
  const vault = createWorkflowVault({
    'economy.md': '# Economy\nMarkets',
    'motorcycle.md': '# Motorcycle repair\nCarburetor',
  });

  assert.equal(runWikiBuildCli(vault.path, ['scan', '--json']).status, 0);
  const candidate = writeTwoDomainPlan(vault.path);
  assert.equal(runWikiBuildCli(vault.path, [
    'plan', '--input', candidate, '--mode', 'validate', '--json',
  ]).status, 0);
  assert.equal(existsSync(join(vault.path, 'wiki')), false);
  assert.equal(runWikiBuildCli(vault.path, [
    'plan', '--input', candidate, '--mode', 'approve', '--json',
  ]).status, 0);

  const economy = claim(vault.path);
  prepareClaimedBatch(vault.path, economy);
  stageSourcePage(vault.path, economy, '经济');
  checkpointSucceeded(vault.path, economy);

  const motorcycleBeforeCrash = claim(vault.path);
  assert.equal(readState(vault.path).activeBatchId, motorcycleBeforeCrash.batch.id);
  runWikiBuildCli(vault.path, ['status', '--recover', '--json']);

  const motorcycleAfterCrash = claim(vault.path);
  assert.notEqual(motorcycleAfterCrash.attemptToken, motorcycleBeforeCrash.attemptToken);
  prepareClaimedBatch(vault.path, motorcycleAfterCrash);
  stageSourcePage(vault.path, motorcycleAfterCrash, '摩托车维修');
  checkpointSucceeded(vault.path, motorcycleAfterCrash);

  const summaries = writeTopicSummaries(vault.path);
  const final = runWikiBuildCli(vault.path, [
    'finalize', '--summaries', summaries, '--json',
  ]);
  assert.equal(final.json.data.phase, 'completed');
  assert.match(readFileSync(join(vault.path, 'wiki', 'INDEX.md'), 'utf8'), /经济/);
  assert.match(readFileSync(join(vault.path, 'wiki', 'INDEX.md'), 'utf8'), /摩托车维修/);
});
~~~

- [ ] **Step 2: Run the workflow test**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/wiki-build-workflow.test.js
~~~

Expected: PASS. Any failure indicates command names, state fields, preprocessing contracts, or finalization assumptions drifted in Tasks 1-6; correct the owning task before continuing.

- [ ] **Step 3: Run the complete tool test group**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test "apps/daemon/dist/test/tools/wiki-build-*.test.js"
~~~

Expected: all wiki-build tool tests pass.

- [ ] **Step 4: Commit**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build/scripts apps/daemon/test/tools/wiki-build-workflow.test.ts
git commit -m "test(wiki): cover resumable build workflow"
~~~

---

### Task 8: Replace prompt-only build and ingest procedures with the CLI workflow

**Files:**
- Modify: apps/daemon/src/tools/skills/wiki-build/SKILL.md
- Modify: apps/daemon/src/tools/skills/wiki-ingest/SKILL.md
- Modify: apps/daemon/test/tools/builtin-skills.test.ts
- Modify: apps/daemon/test/core/skill-installer.test.ts

**Interfaces:**
- Consumes the stable CLI commands from Task 7.
- Produces wiki-build Skill version 2.0.0 and wiki-ingest Skill version 2.0.0.
- wiki-ingest consumes inventory.jsonl, plan.json, state.json, and reindexTopicAndAncestors behavior through the CLI reindex command.

- [ ] **Step 1: Write installed-Skill workflow assertions**

Add to builtin-skills.test.ts:

~~~ts
it('installs the wiki build CLI and approval workflow', () => {
  const buildDir = path.join(skillsDir, 'wiki-build');
  assert.ok(fs.existsSync(path.join(buildDir, 'scripts', 'wiki-build.mjs')));
  assert.ok(fs.existsSync(path.join(buildDir, 'scripts', 'lib', 'inventory.mjs')));

  const build = fs.readFileSync(path.join(buildDir, 'SKILL.md'), 'utf8');
  assert.match(build, /^version:\s*2\.0\.0$/m);
  assert.match(build, /scan --json/);
  assert.match(build, /plan .*--mode validate/);
  assert.match(build, /等待用户批准/);
  assert.match(build, /plan .*--mode approve/);
  assert.ok(
    build.indexOf('等待用户批准') < build.indexOf('--mode approve'),
    'approval must precede plan freeze and wiki writes',
  );
  assert.match(build, /status --recover/);
  assert.match(build, /checkpoint/);
  assert.match(build, /skip --file-id/);
  assert.match(build, /retry --file-id/);
  assert.match(build, /finalize/);
});

it('installs recursive ingest instructions', () => {
  const ingest = fs.readFileSync(path.join(skillsDir, 'wiki-ingest', 'SKILL.md'), 'utf8');
  assert.match(ingest, /^version:\s*2\.0\.0$/m);
  assert.match(ingest, /scan --include/);
  assert.match(ingest, /逐级读取/);
  assert.match(ingest, /祖先 INDEX/);
  assert.match(ingest, /legacy/);
});
~~~

- [ ] **Step 2: Run the Skill tests and confirm version/content failure**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/builtin-skills.test.js apps/daemon/dist/test/core/skill-installer.test.js
~~~

Expected: FAIL because the installed Skill is still version 1.4.0 and lacks CLI instructions.

- [ ] **Step 3: Rewrite the wiki-build execution section**

Keep existing page/frontmatter guidance, then replace the old scan-to-write steps with this mandatory order:

~~~markdown
1. Run node "<wiki-build-skill>/scripts/wiki-build.mjs" scan --json.
2. Read inventory.jsonl and samples only; do not traverse or read the whole vault again.
3. Group files by semantic domain. Unrelated files remain separate even when a topic contains one file.
4. Apply capacity splitting and write the candidate plan JSON.
5. Run plan --input "<candidate>" --mode validate --json.
6. Show topics, assignments, exclusions, undecided files, risks, and workload in chat.
7. 等待用户批准. Do not run approve and do not write wiki/ before explicit approval.
8. Run plan --input "<candidate>" --mode approve --json.
9. Run status --json. On a resumed session, show remaining work and obtain confirmation before status --recover.
10. Loop next -> normalize bounded inputs -> write complete pages under returned stagingDir -> checkpoint.
11. On user-directed exclusions run skip --file-id; on retryable failures run retry --file-id.
12. Write topic-summaries.json and run finalize --summaries "<path>" --json.
13. Report completed, failed, skipped, and unresolved files from the final JSON result.
~~~

Document docling output under .molio/wiki-build/normalized, text heading/window splitting, JSON streaming strategy, and unsupported-file confirmation. Require the attemptToken in checkpoint input.

- [ ] **Step 4: Rewrite wiki-ingest for recursive Wikis**

The Skill must:

- detect legacy flat Wiki and retain the old path,
- call scan --include "<source>" --content-hash --json for a new file,
- walk root and child INDEX files to propose a leaf topic,
- allow the user to select a different topic,
- allow a new single-file semantic topic,
- update source and knowledge pages,
- run reindex --topic-id "<id>" so the leaf or shards and every ancestor update,
- avoid rebuilding unrelated topics,
- preserve source files.

- [ ] **Step 5: Bump versions and verify installer upgrades**

Update the installer migration test so a version 1.4.0 destination is replaced by 2.0.0 and contains scripts/wiki-build.mjs. Then run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/builtin-skills.test.js apps/daemon/dist/test/core/skill-installer.test.js
~~~

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add apps/daemon/src/tools/skills/wiki-build apps/daemon/src/tools/skills/wiki-ingest apps/daemon/test/tools/builtin-skills.test.ts apps/daemon/test/core/skill-installer.test.ts
git commit -m "feat(wiki): make build and ingest resumable"
~~~

---

### Task 9: Teach the always-on query prompt to navigate recursive indexes

**Files:**
- Modify: apps/daemon/src/core/wiki-prompts.ts
- Modify: apps/daemon/src/routes/graph.ts
- Modify: apps/daemon/test/core/weixin/wiki-sys-prompt-files.test.ts
- Create: apps/daemon/test/routes/graph.test.ts

**Interfaces:**
- Produces an updated VAULT_STRUCTURE covering recursive and legacy layouts.
- Produces a WIKI_QUERY_PROMPT loop from wiki/INDEX.md through branch, leaf, and shard indexes.
- Produces exported buildGraph(vaultPath): GraphData for graph-route regression tests.
- Resolves path-qualified wikilinks exactly before basename and fuzzy fallbacks.
- Keeps QUERY_SYS_PROMPT_FILE and daemon run routing unchanged.

- [ ] **Step 1: Write query prompt and path-qualified graph assertions**

~~~ts
it('the query frame walks recursive indexes and preserves legacy fallback', () => {
  ensureWikiSysPromptFiles(dir);
  const query = readFileSync(join(dir, 'query.txt'), 'utf8');
  assert.match(query, /wiki\/INDEX\.md/);
  assert.match(query, /逐级读取候选主题/);
  assert.match(query, /叶主题/);
  assert.match(query, /index-shards/);
  assert.match(query, /legacy/);
  assert.match(query, /路径限定/);
  assert.match(query, /信息不足.*源文件/s);
});
~~~

Create apps/daemon/test/routes/graph.test.ts:

~~~ts
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildGraph } from '../../src/routes/graph.js';

const roots: string[] = [];

function write(root: string, relative: string, content: string): void {
  const target = join(root, ...relative.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('buildGraph path-qualified wikilinks', () => {
  it('resolves the exact nested page before duplicate-basename fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'molio-graph-path-'));
    roots.push(root);
    write(root, 'wiki/INDEX.md',
      '[[建筑工程/规范审查/消防规范/concepts/防火分区|消防防火分区]]');
    write(root, 'wiki/建筑工程/规范审查/消防规范/concepts/防火分区.md', '# 消防');
    write(root, 'wiki/经济学/concepts/防火分区.md', '# 经济学同名页');

    const graph = buildGraph(root);
    assert.deepEqual(graph.deadLinks, []);
    assert.ok(graph.edges.some((edge) =>
      [edge.source, edge.target].includes('wiki/INDEX.md')
      && [edge.source, edge.target].includes(
        'wiki/建筑工程/规范审查/消防规范/concepts/防火分区.md',
      )));
    assert.ok(!graph.edges.some((edge) =>
      [edge.source, edge.target].includes('wiki/INDEX.md')
      && [edge.source, edge.target].includes('wiki/经济学/concepts/防火分区.md')));
  });
});
~~~

- [ ] **Step 2: Run the prompt test and verify failure**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/core/weixin/wiki-sys-prompt-files.test.js apps/daemon/dist/test/routes/graph.test.js
~~~

Expected: FAIL because the prompt still describes one flat INDEX and buildGraph is not exported.

- [ ] **Step 3: Update VAULT_STRUCTURE and WIKI_QUERY_PROMPT**

Replace the flat-only directory claims with:

~~~text
- wiki/INDEX.md lists top-level topics in a recursive Wiki.
- A branch INDEX lists direct child topics and summaries.
- A leaf INDEX lists pages or links to index-shards/.
- A legacy Wiki may still use one flat wiki/INDEX.md; follow it without migration.
~~~

Set the query sequence to:

~~~text
1. Read wiki/hot.md when present.
2. Read wiki/INDEX.md.
3. While the selected entry points to another topic INDEX, read that INDEX.
4. At a leaf, read the relevant page entries or the relevant index shard.
5. Open the most relevant Wiki pages and related pages.
6. Read source files only when the Wiki lacks enough evidence.
~~~

Require path-qualified links with display aliases for nested pages and duplicate basenames, for example [[建筑工程/规范审查/消防规范/concepts/防火分区|防火分区]]. Bare links remain valid for unique legacy pages. Retain the current non-Wiki activity-query escape hatch and archive suggestion behavior.

- [ ] **Step 4: Resolve path-qualified graph links before basename fallback**

Export buildGraph, register a normalized lower-case alias for every Markdown path, and perform exact checks before reading nameIndex:

~~~ts
export function buildGraph(vaultPath: string): GraphData {
  // existing scan and index construction
  for (const f of mdFiles) {
    const relPath = f.path;
    const key = relPath;
    pathToKey.set(relPath, key);
    pathToKey.set(relPath.replace(/\\/g, '/').toLowerCase(), key);
    // existing basename, node type, and link-count setup
  }
  // existing edge and node construction
}

function resolveLink(
  rawName: string,
  sourcePath: string,
  nameIndex: Map<string, string[]>,
  pathToKey: Map<string, string>,
): string | null {
  const normalizedTarget = rawName
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|^\.\//g, '')
    .replace(/\.md$/i, '')
    .toLowerCase();

  if (rawName.match(/\.(png|jpg|jpeg|gif|svg|webp|pdf|docx?|xlsx?)$/i)) {
    return null;
  }

  const exactCandidates = [`${normalizedTarget}.md`];
  if (sourcePath.startsWith('wiki/') && !normalizedTarget.startsWith('wiki/')) {
    exactCandidates.push(`wiki/${normalizedTarget}.md`);
  }
  for (const candidate of exactCandidates) {
    const exact = pathToKey.get(candidate);
    if (exact) return exact;
  }

  const cleanName = normalizedTarget;
  // retain the existing basename, fuzzy, same-directory, and first-match fallbacks
}
~~~

- [ ] **Step 5: Run prompt, graph, and route regression tests**

Run:

~~~bash
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/core/weixin/wiki-sys-prompt-files.test.js apps/daemon/dist/test/routes/graph.test.js apps/daemon/dist/test/routes/runs-wiki-skill.test.js
~~~

Expected: all selected tests pass; run routing still attaches QUERY_SYS_PROMPT_FILE without adding a daemon operation branch.

- [ ] **Step 6: Commit**

~~~bash
git add apps/daemon/src/core/wiki-prompts.ts apps/daemon/src/routes/graph.ts apps/daemon/test/core/weixin/wiki-sys-prompt-files.test.ts apps/daemon/test/routes/graph.test.ts
git commit -m "feat(wiki): navigate recursive topic indexes"
~~~

---

### Task 10: Verify development, installed-vault, and packaged-resource copies

**Files:**
- Create: apps/desktop/test/wiki-build-resources.test.js
- Modify: apps/daemon/test/tools/builtin-skills.test.ts
- Modify: apps/daemon/test/core/skill-installer.test.ts

**Interfaces:**
- Consumes recursive copyDirSync in skill-installer.ts.
- Consumes recursive cpSync in apps/desktop/scripts/prepare-resources.mjs.
- Produces regression coverage for every wiki-build script and lib module in installed and packaged layouts.

- [ ] **Step 1: Add packaged-resource regression tests**

~~~js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const prepareSource = readFileSync(
  resolve(desktopRoot, 'scripts', 'prepare-resources.mjs'),
  'utf8',
);

describe('wiki-build packaged resources', () => {
  it('uses recursive skill copying', () => {
    assert.match(prepareSource, /cpSync\(skillsSrc,\s*skillsDest,\s*\{\s*recursive:\s*true/);
  });

  it('ships the CLI source and every required module', () => {
    const sourceRoot = resolve(
      repoRoot,
      'apps/daemon/src/tools/skills/wiki-build/scripts',
    );
    for (const relative of [
      'wiki-build.mjs',
      'lib/contracts.mjs',
      'lib/workspace.mjs',
      'lib/inventory.mjs',
      'lib/plan.mjs',
      'lib/preprocess.mjs',
      'lib/state.mjs',
      'lib/indexes.mjs',
    ]) {
      assert.ok(existsSync(resolve(sourceRoot, relative)), relative);
    }
  });

  it('contains the scripts in packaged resources when prepare has run', () => {
    const daemonBundle = resolve(desktopRoot, 'resources/daemon/daemon.mjs');
    if (!existsSync(daemonBundle)) return;
    assert.ok(existsSync(resolve(
      desktopRoot,
      'resources/daemon/skills/wiki-build/scripts/wiki-build.mjs',
    )));
  });
});
~~~

- [ ] **Step 2: Run desktop and installer tests**

Run:

~~~bash
node --test apps/desktop/test/wiki-build-resources.test.js
pnpm --filter @molio/daemon build
node --test apps/daemon/dist/test/tools/builtin-skills.test.js apps/daemon/dist/test/core/skill-installer.test.js
~~~

Expected: all selected tests pass.

- [ ] **Step 3: Run prepare-resources and verify the concrete packaged path**

Run:

~~~bash
pnpm --filter @molio/desktop build
node --test apps/desktop/test/wiki-build-resources.test.js
~~~

Expected: the conditional packaged-resource test executes its assertion because resources/daemon/daemon.mjs exists.

- [ ] **Step 4: Commit**

~~~bash
git add apps/desktop/test/wiki-build-resources.test.js apps/daemon/test/tools/builtin-skills.test.ts apps/daemon/test/core/skill-installer.test.ts
git commit -m "test(wiki): verify build tool packaging"
~~~

---

### Task 11: Document and run Molio-triggered articles-1 acceptance

**Files:**
- Create: docs/wiki-build-acceptance.md

**Interfaces:**
- Consumes the final CLI, installed Skill, knowledge-base UI entry, daemon run path, and runtime Agent workflow.
- Produces a reproducible acceptance record with the UI-triggered run identity, inventory digest, counts by support class, recovery evidence, final coverage counts, and representative query results.

- [ ] **Step 1: Write the acceptance runbook**

docs/wiki-build-acceptance.md must contain these commands and expected evidence:

~~~powershell
$cli = "D:\work\02-code\Molio-wiki-build-scalable\apps\daemon\src\tools\skills\wiki-build\scripts\wiki-build.mjs"
$vault = "D:\work\articles-1"
node $cli scan --vault $vault --json
node $cli status --vault $vault --json

Set-Location "D:\work\02-code\Molio-wiki-build-scalable"
pnpm dev:desktop
~~~

Record:

- inventory digest,
- Molio run/conversation id, selected runtime Agent, installed wiki-build Skill version, and the auto-sent wiki-build prompt,
- total visible files,
- supported, needs-confirmation, and scan-error counts,
- total bytes by extension,
- plan/excluded/undecided count equality with inventory,
- approved plan version and digest,
- batch count and maximum estimated token load,
- a cancellation after at least one checkpoint,
- recovery output proving completed batches were not reclaimed,
- final succeeded, failed, and skipped file counts,
- leaf/shard page coverage and dead-link count,
- representative questions, selected index path, Wiki pages used, and source fallback used.

The runbook must state that counts reflect the scan snapshot and are not product promises.

- [ ] **Step 2: Run the complete automated verification suite**

Run:

~~~bash
pnpm --filter @molio/daemon test
node --test apps/desktop/test/wiki-build-resources.test.js
pnpm typecheck
~~~

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 3: Run the articles-1 pre-scan**

Run the two PowerShell commands from the runbook. Expected:

- exit status 0,
- inventory count equals supported + needs-confirmation + scan-error file records,
- no wiki/ directory is created by scan,
- inventory and samples exist only under D:\work\articles-1\.molio\wiki-build.

Do not approve or execute the plan until the Agent displays the generated topic tree, assignments, risks, and workload to the user.

- [ ] **Step 4: Trigger wiki-build from Molio and record results**

Start Molio with pnpm dev:desktop from this worktree, open or add D:\work\articles-1 as the selected knowledge base, select the runtime Agent under test, and click 构建 Wiki. Confirm that the chat auto-sends the wiki-build prompt and the runtime loads wiki-build Skill version 2.0.0 from the vault-installed Skill directory.

Before approving the proposed plan, verify that:

- the Agent displays the recursive topic tree, file assignments, exclusions, undecided files, risks, batch count, and estimated workload,
- unrelated domains remain separate even when a topic contains one source file,
- no wiki/ page exists yet,
- all build process files stay under D:\work\articles-1\.molio\wiki-build.

Approve the plan in chat. Let at least one batch reach a succeeded checkpoint, cancel the run from Molio, then click 构建 Wiki again. Confirm that the Agent reports remaining work, requests confirmation before recovery, obtains a new attempt token, and does not reclaim a succeeded batch. Resume, process the remaining batches, and finalize the indexes.

Ask representative questions through the same knowledge-base chat. Record the index path, Wiki pages, related pages, and any source fallback used for each answer. Add the run ids, relevant chat transcript excerpts, state counts, final coverage, and observed failures to docs/wiki-build-acceptance.md.

- [ ] **Step 5: Run final regression verification**

Run:

~~~bash
pnpm --filter @molio/daemon test
pnpm --filter @molio/desktop test
pnpm typecheck
git diff --check
git status --short
~~~

Expected: tests and typecheck pass, git diff reports no whitespace errors, and status lists only the acceptance documentation changes intended for this task.

- [ ] **Step 6: Commit**

~~~bash
git add docs/wiki-build-acceptance.md
git commit -m "docs: record scalable wiki build acceptance"
~~~

---

## Execution Order and Review Gates

1. Tasks 1-4 establish bounded input handling and user-approved planning. Review that no wiki/ write occurs before approval.
2. Tasks 5-7 establish resumable mutation. Review fencing, journal replay, and idempotency before allowing Skill execution.
3. Tasks 8-10 expose the workflow to runtime Agents and packaged builds. Review legacy behavior and installed paths.
4. Task 11 runs the real data acceptance only after all automated gates pass.

Each task must keep the branch buildable and end with the listed focused tests plus its commit. Do not combine commits across review gates.
