#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanVault } from './lib/inventory.mjs';
import { approvePlan, saveDraft, validatePlan } from './lib/plan.mjs';
import {
  checkpointBatch, claimNextBatch, recoverRunning, retryFailedFile, skipFile, prepareClaimedBatch,
} from './lib/state.mjs';
import { finalizeBuild, reindexTopicAndAncestors } from './lib/indexes.mjs';
import {
  acquireMutationLock, assertPathWithinVault, readJson, resolveBuildPaths, sha256, withMutationLock,
} from './lib/workspace.mjs';

async function withAsyncMutationLock(paths, fn) {
  const release = acquireMutationLock(paths);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function parseArgs(argv) {
  const options = {
    command: undefined, json: false, vault: undefined, include: [], contentHash: false,
    maxDirEntries: undefined, maxTotal: undefined, sampleBytes: undefined,
    input: undefined, mode: undefined,
    recover: false, batchId: undefined, attemptToken: undefined,
    fileId: undefined, reason: undefined,
    topicId: undefined, summaries: undefined,
  };
  const valueFlags = new Set([
    '--vault', '--include', '--input', '--mode',
    '--max-dir-entries', '--max-total', '--sample-bytes',
    '--batch-id', '--attempt-token', '--file-id', '--reason',
    '--topic-id', '--summaries',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--content-hash') options.contentHash = true;
    else if (argument === '--recover') options.recover = true;
    else if (valueFlags.has(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      if (argument === '--include') options.include.push(value);
      else if (argument === '--max-dir-entries' || argument === '--max-total' || argument === '--sample-bytes') {
        const numericValue = Number(value);
        if (!Number.isInteger(numericValue) || numericValue < 1) throw new Error(`${argument} must be a positive integer`);
        options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = numericValue;
      } else {
        const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        options[key] = value;
      }
      index += 1;
    } else if (!argument.startsWith('--') && !options.command) options.command = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.command) throw new Error('A command is required');
  if (!options.vault) throw new Error('--vault is required');
  return options;
}

function readInventory(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function assertIncludesInsideVault(vault, includes) {
  for (const include of includes) assertPathWithinVault(vault, resolve(vault, include));
}

function status(paths, options) {
  if (options.recover) return withMutationLock(paths, () => recoverRunning(paths));
  if (existsSync(paths.state)) return readJson(paths.state);
  if (existsSync(paths.plan)) {
    readJson(paths.plan);
    return { phase: 'approved' };
  }
  if (existsSync(paths.planDraft)) {
    readJson(paths.planDraft);
    return { phase: 'draft' };
  }
  if (existsSync(paths.inventory)) {
    readFileSync(paths.inventory, 'utf8');
    return { phase: 'scanned' };
  }
  return { phase: 'not_started' };
}

function emit(envelope, json) {
  process.stdout.write(json ? `${JSON.stringify(envelope)}\n` : `${JSON.stringify(envelope)}\n`);
}

function cliError(command, code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

function requireOption(options, command, key, label) {
  if (!options[key]) cliError(command, 'INVALID_ARGUMENT', `${label} is required for ${command}`);
  return options[key];
}

function main() {
  let command;
  let json = false;
  try {
    const options = parseArgs(process.argv.slice(2));
    command = options.command;
    json = options.json;
    const vault = realpathSync(options.vault);
    const paths = resolveBuildPaths(vault);
    assertIncludesInsideVault(vault, options.include);
    if (command === 'status') {
      emit({ ok: true, command, data: status(paths, options) }, json);
      return;
    }
    if (command === 'scan') {
      const result = withMutationLock(paths, () => scanVault({
        vaultPath: vault,
        includePaths: options.include.length ? options.include : undefined,
        contentHash: options.contentHash,
        maxDirEntries: options.maxDirEntries,
        maxTotal: options.maxTotal,
        sampleBytes: options.sampleBytes,
      }));
      emit({ ok: true, command, data: result }, json);
      return;
    }
    if (command === 'plan') {
      if (!['validate', 'approve'].includes(options.mode)) {
        cliError(command, 'INVALID_ARGUMENT', 'plan requires validate or approve mode');
      }
      if (!options.input) cliError(command, 'INVALID_ARGUMENT', '--input is required for plan');
      const candidatePath = assertPathWithinVault(vault, resolve(vault, options.input));
      if (!existsSync(paths.inventory)) {
        cliError(command, 'INVENTORY_NOT_FOUND', 'Scan the vault before planning');
      }
      const candidate = readJson(candidatePath);
      const inventoryContents = readFileSync(paths.inventory, 'utf8');
      const validation = validatePlan(candidate, readInventory(paths.inventory), sha256(inventoryContents));
      if (!validation.valid) {
        cliError(command, 'PLAN_VALIDATION_FAILED', 'Plan validation failed', {
          codes: validation.errors.map(({ code }) => code), errors: validation.errors,
        });
      }
      const data = withMutationLock(paths, () => (options.mode === 'validate'
        ? { topicCounts: validation.topicCounts, draftPath: saveDraft(paths, candidate) }
        : approvePlan(paths, candidate)));
      emit({ ok: true, command, data }, json);
      return;
    }
    if (command === 'next') {
      const data = withMutationLock(paths, () => claimNextBatch(paths));
      emit({ ok: true, command, data }, json);
      return;
    }
    if (command === 'skip') {
      const fileId = requireOption(options, command, 'fileId', '--file-id');
      const reason = requireOption(options, command, 'reason', '--reason');
      const data = withMutationLock(paths, () => skipFile(paths, fileId, reason));
      emit({ ok: true, command, data }, json);
      return;
    }
    if (command === 'retry') {
      const fileId = requireOption(options, command, 'fileId', '--file-id');
      const data = withMutationLock(paths, () => retryFailedFile(paths, fileId));
      emit({ ok: true, command, data }, json);
      return;
    }
    if (command === 'prepare') {
      const batchId = requireOption(options, command, 'batchId', '--batch-id');
      const attemptToken = requireOption(options, command, 'attemptToken', '--attempt-token');
      if (!options.input) cliError(command, 'INVALID_ARGUMENT', '--input is required for prepare');
      const manifestPath = assertPathWithinVault(vault, resolve(vault, options.input));
      const manifest = readJson(manifestPath);
      withAsyncMutationLock(paths, () => prepareClaimedBatch(paths, batchId, attemptToken, manifest))
        .then((data) => emit({ ok: true, command, data }, json))
        .catch((error) => fail(command, json, error));
      return;
    }
    if (command === 'checkpoint') {
      if (!options.input) cliError(command, 'INVALID_ARGUMENT', '--input is required for checkpoint');
      const inputPath = assertPathWithinVault(vault, resolve(vault, options.input));
      const payload = readJson(inputPath);
      withAsyncMutationLock(paths, () => checkpointBatch(paths, payload))
        .then((data) => emit({ ok: true, command, data }, json))
        .catch((error) => fail(command, json, error));
      return;
    }
    if (command === 'finalize') {
      if (!options.summaries) cliError(command, 'INVALID_ARGUMENT', '--summaries is required for finalize');
      const summariesPath = assertPathWithinVault(vault, resolve(vault, options.summaries));
      const summaries = readJson(summariesPath);
      const data = withMutationLock(paths, () => finalizeBuild(paths, summaries));
      emit({ ok: true, command, data }, json);
      return;
    }
    if (command === 'reindex') {
      const topicId = requireOption(options, command, 'topicId', '--topic-id');
      if (!options.input) cliError(command, 'INVALID_ARGUMENT', '--input is required for reindex');
      if (!options.summaries) cliError(command, 'INVALID_ARGUMENT', '--summaries is required for reindex');
      const inputPath = assertPathWithinVault(vault, resolve(vault, options.input));
      const summariesPath = assertPathWithinVault(vault, resolve(vault, options.summaries));
      const ingestResult = readJson(inputPath);
      const summaries = readJson(summariesPath);
      const plan = readJson(paths.plan);
      const state = readJson(paths.state);
      const data = withMutationLock(paths, () => reindexTopicAndAncestors({
        paths, plan, state, topicId,
        pageUpdates: ingestResult.pageUpdates ?? [],
        summaries,
      }));
      emit({ ok: true, command, data }, json);
      return;
    }
    cliError(command, 'UNKNOWN_COMMAND', `Unknown command: ${command}`);
  } catch (error) {
    fail(command, json, error);
  }
}

function fail(command, json, error) {
  emit({
    ok: false,
    command: command ?? null,
    error: {
      code: error.code ?? 'INVALID_ARGUMENT',
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  }, json);
  process.exitCode = 2;
}

main();
