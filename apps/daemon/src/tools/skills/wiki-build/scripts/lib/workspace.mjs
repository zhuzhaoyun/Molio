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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

function assertWithin(root, candidate) {
  const path = resolve(candidate);
  const relativePath = relative(root, path);
  if (relativePath === '..' || relativePath.startsWith('..\\') || isAbsolute(relativePath)) {
    const error = new Error(`Path is outside the vault: ${candidate}`);
    error.code = 'PATH_OUTSIDE_VAULT';
    throw error;
  }
  return path;
}

export function resolveBuildPaths(vaultPath) {
  const vault = realpathSync(vaultPath);
  const root = assertWithin(vault, join(vault, '.molio', 'wiki-build'));
  return Object.freeze({
    root,
    inventory: join(root, 'inventory.jsonl'),
    plan: join(root, 'plan.json'),
    state: join(root, 'state.json'),
    samples: join(root, 'samples'),
    normalized: join(root, 'normalized'),
    staging: join(root, 'staging'),
    journals: join(root, 'journals'),
    planHistory: join(root, 'plan-history'),
  });
}

function atomicWrite(path, contents) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${path}.tmp`;
  const descriptor = openSync(temporaryPath, 'w');
  try {
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
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
  const lock = join(paths.root, '.lock');
  mkdirSync(paths.root, { recursive: true });
  const descriptor = openSync(lock, 'wx');
  try {
    return fn();
  } finally {
    closeSync(descriptor);
    if (existsSync(lock)) rmSync(lock, { force: true });
  }
}
