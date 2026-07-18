import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import {
  CONFIRM_EXTENSIONS,
  DOCLING_EXTENSIONS,
  MAX_DIR_ENTRIES,
  MAX_TOTAL,
  PRUNED_NAMES,
  TEXT_EXTENSIONS,
} from './contracts.mjs';
import { assertPathWithinVault, resolveBuildPaths, sha256, writeJsonLines } from './workspace.mjs';

const DEFAULT_SAMPLE_BYTES = 16 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function normalizedRelativePath(vaultPath, path) {
  return relative(vaultPath, path).split(sep).join('/');
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function classify(extension) {
  if (TEXT_EXTENSIONS.has(extension)) return { processor: 'text', support: 'supported' };
  if (DOCLING_EXTENSIONS.has(extension)) return { processor: 'docling', support: 'supported' };
  if (CONFIRM_EXTENSIONS.has(extension)) return { processor: 'none', support: 'needs-confirmation' };
  return { processor: 'none', support: 'unsupported' };
}

function titleFromText(text, path) {
  const heading = text.match(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/m);
  return heading ? heading[1].trim() : basename(path, extname(path));
}

function readSample(path, size, sampleBytes) {
  const head = Buffer.alloc(Math.min(size, sampleBytes));
  const tail = size > sampleBytes ? Buffer.alloc(Math.min(size - sampleBytes, sampleBytes)) : Buffer.alloc(0);
  const descriptor = openSync(path, 'r');
  try {
    readSync(descriptor, head, 0, head.length, 0);
    if (tail.length) readSync(descriptor, tail, 0, tail.length, size - tail.length);
  } finally {
    closeSync(descriptor);
  }
  let text;
  try {
    text = decoder.decode(head);
  } catch {
    text = undefined;
  }
  return { head, tail, text };
}

function writeSample(vaultPath, paths, record, sample) {
  if (sample.text === undefined) return undefined;
  const path = join(paths.samples, `${record.id}.txt`);
  assertPathWithinVault(vaultPath, path);
  mkdirSync(paths.samples, { recursive: true });
  writeFileSync(path, sample.text, 'utf8');
  return normalizedRelativePath(vaultPath, path);
}

function isPrunedDirectory(name) {
  return name.startsWith('.') || PRUNED_NAMES.has(name);
}

function sourcePaths(vaultPath, includePaths, errors, maxDirEntries) {
  const files = [];
  const visit = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true })
        .sort((left, right) => comparePaths(
          normalizedRelativePath(vaultPath, join(path, left.name)),
          normalizedRelativePath(vaultPath, join(path, right.name)),
        ));
    } catch (error) {
      errors.push({ code: 'DIRECTORY_READ_FAILED', path: normalizedRelativePath(vaultPath, path), message: error.message });
      return;
    }
    if (entries.length > maxDirEntries) {
      errors.push({
        code: 'DIRECTORY_LIMIT',
        path: normalizedRelativePath(vaultPath, path) || '.',
        limit: maxDirEntries,
        entries: entries.length,
      });
      return;
    }
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!isPrunedDirectory(entry.name)) visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };

  for (const includePath of includePaths ?? [vaultPath]) {
    const path = assertPathWithinVault(vaultPath, resolve(vaultPath, includePath));
    if (!statSync(path).isDirectory()) {
      files.push(path);
    } else if (!isPrunedDirectory(basename(path))) {
      visit(path);
    }
  }
  return files.sort((left, right) => comparePaths(
    normalizedRelativePath(vaultPath, left), normalizedRelativePath(vaultPath, right),
  ));
}

export function scanVault({
  vaultPath,
  includePaths,
  contentHash = false,
  maxDirEntries = MAX_DIR_ENTRIES,
  maxTotal = MAX_TOTAL,
  sampleBytes = DEFAULT_SAMPLE_BYTES,
}) {
  const vault = resolve(vaultPath);
  const paths = resolveBuildPaths(vault);
  const errors = [];
  const records = [];
  const sources = sourcePaths(vault, includePaths, errors, maxDirEntries);
  const duplicates = new Map();

  for (const path of sources) {
    if (records.length >= maxTotal) {
      errors.push({ code: 'TOTAL_LIMIT', limit: maxTotal });
      break;
    }
    const relativePath = normalizedRelativePath(vault, path);
    try {
      const stats = statSync(path);
      const extension = extname(path).toLowerCase();
      const sample = readSample(path, stats.size, sampleBytes);
      const record = {
        id: sha256(relativePath).slice(0, 16),
        path: relativePath,
        extension,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        quickFingerprint: sha256(Buffer.concat([
          Buffer.from(`${stats.size}\0${stats.mtimeMs}\0`), sample.head, Buffer.from('\0'), sample.tail,
        ])),
        title: sample.text === undefined ? basename(path, extension) : titleFromText(sample.text, path),
        encoding: sample.text === undefined ? 'binary' : 'utf-8',
        ...classify(extension),
        risks: sample.text === undefined ? ['INVALID_UTF8'] : [],
      };
      if (contentHash) record.contentHash = sha256(readFileSync(path));
      record.samplePath = writeSample(vault, paths, record, sample);
      if (record.samplePath === undefined) delete record.samplePath;
      const duplicateKey = `${record.size}:${record.quickFingerprint}`;
      const original = duplicates.get(duplicateKey);
      if (original) record.duplicateOf = original;
      else duplicates.set(duplicateKey, record.id);
      records.push(record);
    } catch (error) {
      errors.push({ code: 'FILE_READ_FAILED', path: relativePath, message: error.message });
    }
  }

  const outputPath = includePaths?.length ? join(paths.root, 'ingest-candidate.jsonl') : paths.inventory;
  writeJsonLines(outputPath, records);
  return {
    records,
    errors,
    counts: { total: records.length },
    inventorySha256: sha256(readFileSync(outputPath)),
    path: normalizedRelativePath(vault, outputPath),
  };
}
