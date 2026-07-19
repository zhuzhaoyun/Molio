import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SCHEMA_VERSION } from './contracts.mjs';
import { assertPathWithinVault, atomicWriteJson, readJson, sha256 } from './workspace.mjs';
import { prepareWorkItems } from './preprocess.mjs';

/**
 * @typedef {object} PageResult
 * @property {string} path
 * @property {string} topicId
 * @property {string} type
 * @property {string} title
 * @property {string} summary
 * @property {string} stagedPath
 * @property {string} [sha256]
 */

/**
 * @typedef {object} FileResult
 * @property {string} fileId
 * @property {'succeeded'|'failed'} status
 * @property {string} [contentHash]
 * @property {{ code: string, message: string }} [error]
 */

/**
 * @typedef {object} CheckpointPayload
 * @property {string} batchId
 * @property {string} attemptToken
 * @property {FileResult[]} files
 * @property {PageResult[]} pages
 * @property {{ code: string, message: string }} [error]
 */

const SAMPLE_BYTES = 16 * 1024;

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function vaultFromPaths(paths) {
  // paths.root = <vault>/.molio/wiki-build
  return resolve(paths.root, '..', '..');
}

function stagingDirRelative(attemptToken) {
  return join('.molio', 'wiki-build', 'staging', attemptToken);
}

function stagingDirAbsolute(paths, attemptToken) {
  return join(paths.staging, attemptToken);
}

function readInventory(paths) {
  if (!existsSync(paths.inventory)) {
    throw codedError('INVENTORY_NOT_FOUND', 'Scan the vault before claiming batches');
  }
  return readFileSync(paths.inventory, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function readPlan(paths) {
  if (!existsSync(paths.plan)) {
    throw codedError('PLAN_NOT_FOUND', 'Approve a plan before claiming batches');
  }
  return readJson(paths.plan);
}

function readState(paths) {
  if (!existsSync(paths.state)) {
    throw codedError('STATE_NOT_FOUND', 'State has not been initialized');
  }
  return readJson(paths.state);
}

function writeState(paths, state) {
  atomicWriteJson(paths.state, { ...state, updatedAt: new Date().toISOString() });
}

function batchOrder(state, plan, batchId) {
  if (state.retryBatches?.[batchId]) return state.retryBatches[batchId].order;
  const planBatch = plan.batches.find((batch) => batch.id === batchId);
  if (!planBatch) throw codedError('BATCH_NOT_FOUND', `Batch ${batchId} not in plan`, { batchId });
  return planBatch.order;
}

function batchFileIds(state, plan, batchId) {
  if (state.retryBatches?.[batchId]) return [...state.retryBatches[batchId].fileIds];
  const planBatch = plan.batches.find((batch) => batch.id === batchId);
  if (!planBatch) throw codedError('BATCH_NOT_FOUND', `Batch ${batchId} not in plan`, { batchId });
  return [...planBatch.fileIds];
}

function batchTopicId(state, plan, batchId) {
  if (state.retryBatches?.[batchId]) return state.retryBatches[batchId].topicId;
  const planBatch = plan.batches.find((batch) => batch.id === batchId);
  if (!planBatch) throw codedError('BATCH_NOT_FOUND', `Batch ${batchId} not in plan`, { batchId });
  return planBatch.topicId;
}

function batchFull(state, plan, batchId) {
  if (state.retryBatches?.[batchId]) {
    const retry = state.retryBatches[batchId];
    return {
      id: retry.id, topicId: retry.topicId, order: retry.order,
      fileIds: [...retry.fileIds], estimatedInputTokens: 0,
      source: 'retry', originalBatchId: retry.originalBatchId,
    };
  }
  const planBatch = plan.batches.find((batch) => batch.id === batchId);
  if (!planBatch) throw codedError('BATCH_NOT_FOUND', `Batch ${batchId} not in plan`, { batchId });
  return { ...planBatch, source: 'plan' };
}

function recomputeQuickFingerprint(absolutePath, stats) {
  const head = Buffer.alloc(Math.min(stats.size, SAMPLE_BYTES));
  const tail = stats.size > SAMPLE_BYTES
    ? Buffer.alloc(Math.min(stats.size - SAMPLE_BYTES, SAMPLE_BYTES))
    : Buffer.alloc(0);
  const descriptor = openSync(absolutePath, 'r');
  try {
    readSync(descriptor, head, 0, head.length, 0);
    if (tail.length) readSync(descriptor, tail, 0, tail.length, stats.size - tail.length);
  } finally {
    closeSync(descriptor);
  }
  return sha256(Buffer.concat([
    Buffer.from(`${stats.size}\0${stats.mtimeMs}\0`),
    head,
    Buffer.from('\0'),
    tail,
  ]));
}

function sourceMatchesInventory(vault, inventoryRecord) {
  const absoluteSource = resolve(vault, inventoryRecord.path);
  if (!existsSync(absoluteSource)) return false;
  const stats = statSync(absoluteSource);
  if (stats.size !== inventoryRecord.size) return false;
  if (stats.mtimeMs !== inventoryRecord.mtimeMs) return false;
  return recomputeQuickFingerprint(absoluteSource, stats) === inventoryRecord.quickFingerprint;
}

/**
 * Build the initial state object from an approved plan. Does not write.
 * @param {object} plan
 */
export function initializeState(plan) {
  if (!plan || plan.status !== 'approved') {
    throw codedError('PLAN_NOT_APPROVED', 'Plan must be approved before initializing state');
  }
  if (!plan.planDigest) throw codedError('PLAN_DIGEST_MISSING', 'Approved plan must carry a planDigest');
  if (!Array.isArray(plan.batches)) throw codedError('BATCHES_INVALID', 'Plan must declare batches');
  const batches = {};
  const files = {};
  for (const batch of plan.batches) {
    if (batches[batch.id]) {
      throw codedError('BATCH_ID_DUPLICATE', `Duplicate batch id ${batch.id}`, { id: batch.id });
    }
    batches[batch.id] = { status: 'pending', attempts: 0, attemptToken: null, lastError: null };
    for (const fileId of batch.fileIds ?? []) {
      if (!files[fileId]) {
        files[fileId] = { status: 'pending', attempts: 0, contentHash: null, lastError: null };
      }
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    planVersion: plan.planVersion,
    planDigest: plan.planDigest,
    phase: 'approved',
    activeBatchId: null,
    batches,
    files,
    pages: {},
    updatedAt: new Date().toISOString(),
  };
}

export function getStatus(paths) {
  return readState(paths);
}

/**
 * Hash a checkpoint payload for journal idempotency.
 * @param {CheckpointPayload} payload
 */
export function computePayloadHash(payload) {
  return sha256(JSON.stringify({
    batchId: payload.batchId,
    attemptToken: payload.attemptToken,
    files: payload.files ?? [],
    pages: payload.pages ?? [],
    error: payload.error ?? null,
  }));
}

/**
 * Compute the sha256 of a staged page's contents. Don't trust submitted hashes.
 * @param {string} absolutePath
 */
export function computePageSha256(absolutePath) {
  return sha256(readFileSync(absolutePath));
}

/**
 * Claim the next pending batch (smallest global order).
 * @returns {{ batchId: string, attemptToken: string, attempt: number, topicId: string, files: object[], stagingDir: string, batch: object }}
 */
export function claimNextBatch(paths) {
  const vault = vaultFromPaths(paths);
  const plan = readPlan(paths);
  const state = readState(paths);
  const inventory = readInventory(paths);
  if (state.activeBatchId) {
    throw codedError('BATCH_ALREADY_RUNNING', `Batch ${state.activeBatchId} is already running`, { activeBatchId: state.activeBatchId });
  }

  const pending = Object.keys(state.batches)
    .filter((id) => state.batches[id].status === 'pending')
    .map((id) => ({ id, order: batchOrder(state, plan, id) }))
    .sort((left, right) => left.order - right.order);
  if (pending.length === 0) throw codedError('NO_PENDING_BATCH', 'No pending batches remain');

  const batchId = pending[0].id;
  const fileIds = batchFileIds(state, plan, batchId);
  const inventoryById = new Map(inventory.map((record) => [record.id, record]));
  for (const fileId of fileIds) {
    const record = inventoryById.get(fileId);
    if (!record) {
      throw codedError('SOURCE_CHANGED_SINCE_SCAN', `Source ${fileId} vanished from inventory`, { fileId });
    }
    if (!sourceMatchesInventory(vault, record)) {
      throw codedError('SOURCE_CHANGED_SINCE_SCAN', `Source ${record.path} changed after plan approval`, { fileId });
    }
  }

  const attemptToken = randomUUID();
  const stagingAbsolute = stagingDirAbsolute(paths, attemptToken);
  mkdirSync(stagingAbsolute, { recursive: true });

  const next = structuredClone(state);
  next.batches[batchId].status = 'running';
  next.batches[batchId].attempts += 1;
  next.batches[batchId].attemptToken = attemptToken;
  next.activeBatchId = batchId;
  for (const fileId of fileIds) {
    next.files[fileId].status = 'running';
    next.files[fileId].attempts += 1;
    next.files[fileId].lastError = null;
  }
  next.phase = 'running';
  writeState(paths, next);

  const batch = batchFull(next, plan, batchId);
  const files = fileIds.map((id) => inventoryById.get(id));
  return {
    batchId,
    attemptToken,
    attempt: next.batches[batchId].attempts,
    topicId: batchTopicId(next, plan, batchId),
    files,
    stagingDir: stagingDirRelative(attemptToken),
    batch,
  };
}

/**
 * Recover running batches and files back to pending. Preserves attempts and
 * lastError. Clears activeBatchId so the next claim gets a fresh attemptToken.
 * Short-circuits the state write when nothing was running (no-op recovery).
 */
export function recoverRunning(paths) {
  const state = readState(paths);
  const next = structuredClone(state);
  let changed = false;
  if (next.activeBatchId !== null) {
    next.activeBatchId = null;
    changed = true;
  }
  for (const batchId of Object.keys(next.batches)) {
    const batch = next.batches[batchId];
    if (batch.status === 'running') {
      batch.status = 'pending';
      batch.attemptToken = null;
      changed = true;
    }
  }
  for (const fileId of Object.keys(next.files)) {
    const file = next.files[fileId];
    if (file.status === 'running') {
      file.status = 'pending';
      changed = true;
    }
  }
  if (changed) writeState(paths, next);
  return next;
}

function validateStagedPath(paths, attemptToken, stagedPath) {
  const vault = vaultFromPaths(paths);
  const stagingRoot = stagingDirAbsolute(paths, attemptToken);
  if (!existsSync(stagingRoot)) {
    throw codedError('STAGED_PATH_INVALID', 'Staging dir does not exist', { attemptToken });
  }
  const resolved = resolve(stagingRoot, stagedPath);
  const rel = relative(stagingRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw codedError('STAGED_PATH_INVALID', `Staged path escapes staging dir: ${stagedPath}`, { stagedPath });
  }
  // assertPathWithinVault validates the realpath stays inside the vault; return
  // the realpath so a symlink planted in staging can't materialize arbitrary
  // vault files through the subsequent readFileSync/move.
  assertPathWithinVault(vault, resolved);
  if (!existsSync(resolved)) {
    throw codedError('STAGED_PATH_INVALID', `Staged page not found: ${stagedPath}`, { stagedPath });
  }
  return realpathSync(resolved);
}

function atomicReplaceFile(targetPath, content) {
  const directory = dirname(targetPath);
  mkdirSync(directory, { recursive: true });
  const temporary = `${targetPath}.tmp`;
  const descriptor = openSync(temporary, 'w');
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (existsSync(targetPath)) {
    try { unlinkSync(targetPath); } catch { /* rename will overwrite */ }
  }
  renameSync(temporary, targetPath);
}

function targetAlreadyMatches(targetAbsolute, expectedSha256) {
  if (!existsSync(targetAbsolute)) return false;
  try {
    return computePageSha256(targetAbsolute) === expectedSha256;
  } catch {
    return false;
  }
}

function journalFile(paths, batchId) {
  return join(paths.journals, `${batchId}.json`);
}

function readJournal(paths, batchId) {
  const path = journalFile(paths, batchId);
  if (!existsSync(path)) return null;
  return readJson(path);
}

function writeJournal(paths, journal) {
  mkdirSync(paths.journals, { recursive: true });
  atomicWriteJson(journalFile(paths, journal.batchId), { ...journal, updatedAt: new Date().toISOString() });
}

function pageEntriesToMap(pages) {
  const map = {};
  for (const page of pages ?? []) {
    map[page.path] = {
      sha256: page.sha256,
      stagedPath: page.stagedPath,
      topicId: page.topicId,
      type: page.type,
      title: page.title,
      summary: page.summary,
    };
  }
  return map;
}

/**
 * Apply a checkpoint result with crash-safe journaling. Idempotent for the
 * same payload; rejects conflicting payloads after completion.
 *
 * Crash recovery: when a `prepared` or `applied` journal already exists, its
 * recorded `payloadHash` authorizes the replay — the `activeBatchId` /
 * `attemptToken` guards are skipped because the state may already reflect the
 * post-step-11 crash window (activeBatchId cleared). The materialize loop and
 * state write are idempotent, so re-running them is safe.
 * @param {object} paths
 * @param {CheckpointPayload} result
 * @returns {Promise<{ summary: 'succeeded'|'failed'|'succeeded_with_errors', pages: object[], files: object[] }>}
 */
export async function checkpointBatch(paths, result) {
  if (!result?.batchId || !result?.attemptToken) {
    throw codedError('CHECKPOINT_ARGUMENT_INVALID', 'batchId and attemptToken are required');
  }
  const payloadHash = computePayloadHash(result);
  const existing = readJournal(paths, result.batchId);

  if (existing?.phase === 'completed') {
    if (existing.payloadHash !== payloadHash) {
      throw codedError('CHECKPOINT_CONFLICT', `Batch ${result.batchId} already completed with a different payload`, { batchId: result.batchId });
    }
    return existing.result;
  }

  // Crash replay: a prepared/applied journal authorizes the replay via its own
  // payloadHash — the activeBatchId/attemptToken guards must be skipped because
  // the state may already have been advanced past step 11 (activeBatchId cleared).
  const resuming = existing?.phase === 'prepared' || existing?.phase === 'applied';
  if (resuming && existing.payloadHash !== payloadHash) {
    throw codedError('CHECKPOINT_CONFLICT', `Batch ${result.batchId} already recorded a different payload`, { batchId: result.batchId });
  }

  const state = readState(paths);
  const plan = readPlan(paths);

  if (!resuming) {
    if (state.activeBatchId !== result.batchId) {
      throw codedError('BATCH_NOT_ACTIVE', `Batch ${result.batchId} is not the active batch`, { activeBatchId: state.activeBatchId });
    }
    const batchState = state.batches[result.batchId];
    if (!batchState) {
      throw codedError('BATCH_NOT_FOUND', `Batch ${result.batchId} not in state`, { batchId: result.batchId });
    }
    if (batchState.attemptToken !== result.attemptToken) {
      throw codedError('STALE_ATTEMPT', `Attempt token ${result.attemptToken} is stale for batch ${result.batchId}`, { batchId: result.batchId });
    }
  }

  const vault = vaultFromPaths(paths);

  // Build target page map (compute sha256 ourselves, don't trust submitted).
  const pages = {};
  for (const page of result.pages ?? []) {
    const stagedAbsolute = validateStagedPath(paths, result.attemptToken, page.stagedPath);
    const targetAbsolute = assertPathWithinVault(vault, resolve(vault, page.path));
    const pageSha = computePageSha256(stagedAbsolute);
    pages[page.path] = {
      sha256: pageSha,
      stagedPath: page.stagedPath,
      topicId: page.topicId,
      type: page.type,
      title: page.title,
      summary: page.summary,
      targetAbsolute,
      stagedAbsolute,
    };
  }

  // Write/refresh journal in 'prepared' phase with the target page map.
  const journal = existing ?? {
    batchId: result.batchId,
    attemptToken: result.attemptToken,
    payloadHash,
    phase: 'prepared',
    pages: pageEntriesToMap(result.pages ?? []),
    files: result.files ?? [],
    createdAt: new Date().toISOString(),
  };
  journal.payloadHash = payloadHash;
  journal.attemptToken = result.attemptToken;
  journal.phase = 'prepared';
  if (!journal.files || journal.files.length === 0) journal.files = result.files ?? [];
  if (!journal.pages || Object.keys(journal.pages).length === 0) {
    journal.pages = pageEntriesToMap(result.pages ?? []);
  }
  writeJournal(paths, journal);

  // Apply: move each target page (skip when target already matches the recorded hash).
  for (const entry of Object.values(pages)) {
    if (targetAlreadyMatches(entry.targetAbsolute, entry.sha256)) continue;
    const content = readFileSync(entry.stagedAbsolute);
    atomicReplaceFile(entry.targetAbsolute, content);
  }

  // Mark journal 'applied' (files moved, state not yet updated).
  journal.phase = 'applied';
  writeJournal(paths, journal);

  // Update state: files, batch, pages manifest, phase, activeBatchId.
  const next = structuredClone(state);
  const fileResults = new Map((result.files ?? []).map((file) => [file.fileId, file]));
  const fileIdsForBatch = batchFileIds(next, plan, result.batchId);
  let anySucceeded = false;
  let anyFailed = false;
  for (const fileId of fileIdsForBatch) {
    const fileResult = fileResults.get(fileId);
    if (!fileResult) continue;
    const fileState = next.files[fileId];
    if (fileResult.status === 'succeeded') {
      fileState.status = 'succeeded';
      fileState.contentHash = fileResult.contentHash ?? fileState.contentHash;
      anySucceeded = true;
    } else if (fileResult.status === 'failed') {
      fileState.status = 'failed';
      fileState.lastError = fileResult.error ?? null;
      anyFailed = true;
    }
  }
  const batchStateNext = next.batches[result.batchId];
  batchStateNext.attemptToken = null;
  batchStateNext.lastError = anyFailed
    ? (result.error ?? { code: 'PARTIAL_FAILURE', message: 'Some files failed' })
    : null;
  if (anySucceeded && anyFailed) {
    batchStateNext.status = 'succeeded';
  } else if (anySucceeded) {
    batchStateNext.status = 'succeeded';
  } else if (anyFailed) {
    batchStateNext.status = 'failed';
  } else {
    batchStateNext.status = 'succeeded';
  }
  next.activeBatchId = null;
  for (const [path, entry] of Object.entries(pages)) {
    next.pages[path] = {
      sha256: entry.sha256,
      batchId: result.batchId,
      attemptToken: result.attemptToken,
      topicId: entry.topicId,
      type: entry.type,
      title: entry.title,
      summary: entry.summary,
      stagedPath: entry.stagedPath,
      updatedAt: new Date().toISOString(),
    };
  }
  // Phase remains 'running' while work remains; task 6 will flip to completed.
  next.phase = 'running';
  writeState(paths, next);

  const summary = anySucceeded && anyFailed
    ? 'succeeded_with_errors'
    : anyFailed
      ? 'failed'
      : 'succeeded';
  const savedResult = { summary, pages: result.pages ?? [], files: result.files ?? [] };
  journal.phase = 'completed';
  journal.result = savedResult;
  writeJournal(paths, journal);
  return savedResult;
}

/**
 * Validate the active claim, then produce bounded work items for the batch.
 * Delegates to {@link prepareWorkItems} after verifying batchId + attemptToken.
 */
export async function prepareClaimedBatch(paths, batchId, attemptToken, inputManifest) {
  const state = readState(paths);
  if (state.activeBatchId !== batchId) {
    throw codedError('BATCH_NOT_ACTIVE', `Batch ${batchId} is not the active batch`, { activeBatchId: state.activeBatchId });
  }
  const batchState = state.batches[batchId];
  if (!batchState) {
    throw codedError('BATCH_NOT_FOUND', `Batch ${batchId} not in state`, { batchId });
  }
  if (batchState.attemptToken !== attemptToken) {
    throw codedError('STALE_ATTEMPT', `Attempt token ${attemptToken} is stale for batch ${batchId}`, { batchId });
  }
  const plan = readPlan(paths);
  const fileIds = batchFileIds(state, plan, batchId);
  return prepareWorkItems({
    paths,
    batch: { id: batchId, attemptToken, fileIds },
    inputManifest,
  });
}

/**
 * Skip a pending or failed file. Marks the file skipped and, if the batch has
 * no remaining processable files, marks the batch skipped too.
 */
export function skipFile(paths, fileId, reason) {
  const state = readState(paths);
  const plan = readPlan(paths);
  if (!state.files[fileId]) {
    throw codedError('FILE_NOT_FOUND', `File ${fileId} not in state`, { fileId });
  }
  const status = state.files[fileId].status;
  if (status !== 'pending' && status !== 'failed') {
    throw codedError('FILE_NOT_SKIPPABLE', `File ${fileId} is ${status}, expected pending or failed`, { fileId, status });
  }
  const next = structuredClone(state);
  next.files[fileId].status = 'skipped';
  next.files[fileId].lastError = { code: 'SKIPPED', message: reason ?? 'skipped', reason };
  for (const batchId of Object.keys(next.batches)) {
    const ids = batchFileIds(next, plan, batchId);
    if (!ids.includes(fileId)) continue;
    const hasProcessable = ids.some((id) => {
      const s = next.files[id]?.status;
      return s === 'pending' || s === 'running';
    });
    if (!hasProcessable) next.batches[batchId].status = 'skipped';
  }
  writeState(paths, next);
  return { fileId, status: 'skipped' };
}

function batchTopicIdForFile(state, plan, fileId) {
  for (const batch of plan.batches ?? []) {
    if ((batch.fileIds ?? []).includes(fileId)) return batch.topicId;
  }
  for (const retryId of Object.keys(state.retryBatches ?? {})) {
    const retry = state.retryBatches[retryId];
    if ((retry.fileIds ?? []).includes(fileId)) return retry.topicId;
  }
  return 'unknown';
}

function findOriginalBatchId(state, plan, fileId) {
  for (const batch of plan.batches ?? []) {
    if ((batch.fileIds ?? []).includes(fileId)) return batch.id;
  }
  for (const retryId of Object.keys(state.retryBatches ?? {})) {
    if ((state.retryBatches[retryId].fileIds ?? []).includes(fileId)) return retryId;
  }
  return null;
}

function buildRetryBatchResponse(state, retryId) {
  const retry = state.retryBatches[retryId];
  return {
    id: retry.id,
    topicId: retry.topicId,
    order: retry.order,
    fileIds: [...retry.fileIds],
    source: 'retry',
    originalBatchId: retry.originalBatchId,
  };
}

/**
 * Reset a failed file to pending and append a single-file retry batch with a
 * stable id `retry-<fileId>-<nextAttempt>`. Does not reset succeeded peers.
 */
export function retryFailedFile(paths, fileId) {
  const state = readState(paths);
  const plan = readPlan(paths);
  if (!state.files[fileId]) {
    throw codedError('FILE_NOT_FOUND', `File ${fileId} not in state`, { fileId });
  }
  if (state.files[fileId].status !== 'failed') {
    throw codedError('FILE_NOT_FAILED', `File ${fileId} is ${state.files[fileId].status}, expected failed`, { fileId, status: state.files[fileId].status });
  }
  const next = structuredClone(state);
  next.files[fileId].status = 'pending';
  next.files[fileId].lastError = null;
  const nextAttempt = (next.files[fileId].attempts ?? 0) + 1;
  const retryId = `retry-${fileId}-${nextAttempt}`;
  // Collision-resilience: the retry id is a stable (fileId, nextAttempt) pair,
  // so concurrent retry calls for the same failed file dedupe instead of
  // creating orphan retry batches. The idempotent guard below keeps state
  // consistent if the same retry is requested twice.
  if (!next.batches[retryId]) {
    const assignment = plan.assignments?.find((item) => item.fileId === fileId);
    const topicId = assignment?.primaryTopicId ?? batchTopicIdForFile(state, plan, fileId);
    let maxOrder = 0;
    for (const batch of plan.batches ?? []) maxOrder = Math.max(maxOrder, batch.order);
    for (const retryId2 of Object.keys(next.retryBatches ?? {})) {
      maxOrder = Math.max(maxOrder, next.retryBatches[retryId2].order);
    }
    const order = maxOrder + 1;
    next.batches[retryId] = { status: 'pending', attempts: 0, attemptToken: null, lastError: null };
    if (!next.retryBatches) next.retryBatches = {};
    next.retryBatches[retryId] = {
      id: retryId,
      fileIds: [fileId],
      topicId,
      order,
      originalBatchId: findOriginalBatchId(state, plan, fileId),
      createdAt: new Date().toISOString(),
    };
  }
  writeState(paths, next);
  return { batch: buildRetryBatchResponse(next, retryId) };
}
