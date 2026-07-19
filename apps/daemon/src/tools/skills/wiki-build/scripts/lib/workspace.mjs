import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function assertWithin(root, candidate) {
  const path = resolve(candidate);
  const relativePath = relative(root, path);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    const error = new Error(`Path is outside the vault: ${candidate}`);
    error.code = 'PATH_OUTSIDE_VAULT';
    throw error;
  }
  return path;
}

function nearestExistingRealpath(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`No existing parent for path: ${path}`);
    current = parent;
  }
  return realpathSync(current);
}

export function assertPathWithinVault(vaultPath, path) {
  const vault = realpathSync(vaultPath);
  const candidate = assertWithin(vault, path);
  const resolvedTarget = existsSync(candidate)
    ? realpathSync(candidate)
    : nearestExistingRealpath(candidate);
  assertWithin(vault, resolvedTarget);
  return candidate;
}

function findBuildRoot(path) {
  let current = resolve(path);
  while (true) {
    if (basename(current) === 'wiki-build' && basename(dirname(current)) === '.molio') return current;
    const parent = dirname(current);
    if (parent === current) {
      const error = new Error(`Path is outside the wiki-build workspace: ${path}`);
      error.code = 'PATH_OUTSIDE_VAULT';
      throw error;
    }
    current = parent;
  }
}

function assertSafeMutationPath(root, path) {
  const vault = realpathSync(dirname(dirname(root)));
  const candidate = assertWithin(root, path);
  return assertPathWithinVault(vault, candidate);
}

export function resolveBuildPaths(vaultPath) {
  const vault = realpathSync(vaultPath);
  const root = assertWithin(vault, join(vault, '.molio', 'wiki-build'));
  return Object.freeze({
    root,
    inventory: join(root, 'inventory.jsonl'),
    planDraft: join(root, 'plan-draft.json'),
    plan: join(root, 'plan.json'),
    state: join(root, 'state.json'),
    samples: join(root, 'samples'),
    normalized: join(root, 'normalized'),
    prepared: join(root, 'prepared'),
    staging: join(root, 'staging'),
    journals: join(root, 'journals'),
    planHistory: join(root, 'plan-history'),
  });
}

function atomicWrite(path, contents) {
  const safePath = assertSafeMutationPath(findBuildRoot(path), path);
  const directory = dirname(safePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${safePath}.tmp`;
  const descriptor = openSync(temporaryPath, 'w');
  try {
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, safePath);
}

export function atomicWriteJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonLines(path, records) {
  atomicWrite(path, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function sha256(value) {
  const contents = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(value);
  return createHash('sha256').update(contents).digest('hex');
}

export function withMutationLock(paths, fn) {
  const release = acquireMutationLock(paths);
  try {
    return fn();
  } finally {
    release();
  }
}

const LOCK_STALE_TTL_MS = 10 * 60 * 1000;

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process; anything else (e.g. EPERM on Windows) means alive.
    return error.code !== 'ESRCH';
  }
}

function readLockInfo(lock) {
  try {
    return JSON.parse(readFileSync(lock, 'utf8'));
  } catch {
    return null;
  }
}

function lockIsStale(info) {
  if (!info || !Number.isInteger(info.pid)) return true;
  if (!isProcessAlive(info.pid)) return true;
  const startedAt = info.startedAt ? Date.parse(info.startedAt) : NaN;
  if (Number.isNaN(startedAt)) return true;
  return Date.now() - startedAt > LOCK_STALE_TTL_MS;
}

function tryCreateLock(lock) {
  try {
    return openSync(lock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return null;
  }
}

/**
 * Acquire the wiki-build mutation lock. Self-heals when a previous holder died
 * (pid no longer alive) or held the lock past the stale TTL. Returns a release
 * function. Throws a coded `LOCK_BUSY` error when a live holder is within TTL.
 */
export function acquireMutationLock(paths) {
  const lock = join(paths.root, '.lock');
  assertSafeMutationPath(paths.root, lock);
  mkdirSync(paths.root, { recursive: true });

  let descriptor = tryCreateLock(lock);
  if (descriptor === null) {
    // Lock exists — check whether the holder is dead or stale before reclaiming.
    if (lockIsStale(readLockInfo(lock))) {
      rmSync(lock, { force: true });
      descriptor = tryCreateLock(lock);
    }
    if (descriptor === null) {
      throw codedError('LOCK_BUSY', 'Another wiki-build mutation is in progress', { lock });
    }
  }

  const info = { pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(descriptor, `${JSON.stringify(info)}\n`);
  fsyncSync(descriptor);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      closeSync(descriptor);
    } catch {
      /* descriptor already closed */
    }
    if (existsSync(lock)) rmSync(lock, { force: true });
  };
}
