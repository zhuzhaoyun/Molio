import { createReadStream, existsSync, openSync, closeSync, readSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_PREPROCESS_POLICY } from './contracts.mjs';
import { assertPathWithinVault, atomicWriteJson, sha256 } from './workspace.mjs';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mergePolicy(policy = {}) {
  const merged = { ...DEFAULT_PREPROCESS_POLICY, ...policy };
  for (const key of ['maxInputTokens', 'fallbackWindowChars', 'jsonlMaxLines']) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1) throw codedError('PREPROCESS_POLICY_INVALID', `Invalid ${key}`);
  }
  if (!Number.isInteger(merged.overlapChars) || merged.overlapChars < 0 || merged.overlapChars >= merged.fallbackWindowChars) {
    throw codedError('PREPROCESS_POLICY_INVALID', 'Invalid overlapChars');
  }
  if (merged.tokenEstimate !== 'utf8-bytes-div-3') throw codedError('PREPROCESS_POLICY_INVALID', 'Unsupported token estimate');
  return merged;
}

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function byteOffset(text, characterOffset) {
  return Buffer.byteLength(text.slice(0, characterOffset), 'utf8');
}

function boundedEnd(text, start, preferredEnd, policy) {
  const maximumEnd = Math.min(text.length, preferredEnd);
  let end = start;
  for (let cursor = start; cursor < maximumEnd;) {
    const width = text.codePointAt(cursor) > 0xffff ? 2 : 1;
    const candidate = cursor + width;
    if (estimateTokens(text.slice(start, candidate)) > policy.maxInputTokens) break;
    end = candidate;
    cursor = candidate;
  }
  if (end === start && start < text.length) throw codedError('WORK_ITEM_TOO_LARGE', 'A single character exceeds maxInputTokens');
  return end;
}

function windowChunks(text, policy, heading) {
  const chunks = [];
  let start = 0;
  let previousEnd = 0;
  while (start < text.length) {
    const end = boundedEnd(text, start, start + policy.fallbackWindowChars, policy);
    chunks.push({
      content: text.slice(start, end),
      byteStart: byteOffset(text, start),
      byteEnd: byteOffset(text, end),
      overlap: start === 0 ? 0 : previousEnd - start,
      ...(heading ? { heading } : {}),
    });
    if (end === text.length) break;
    previousEnd = end;
    start = Math.max(start + 1, end - policy.overlapChars);
  }
  return chunks;
}

function oneOrWindows(text, policy, heading) {
  if (estimateTokens(text) <= policy.maxInputTokens) {
    return [{ content: text, byteStart: 0, byteEnd: Buffer.byteLength(text, 'utf8'), overlap: 0, ...(heading ? { heading } : {}) }];
  }
  return windowChunks(text, policy, heading);
}

export function chunkPlainText(text, policy = {}) {
  return oneOrWindows(text, mergePolicy(policy));
}

export function chunkMarkdown(text, policy = {}) {
  const resolved = mergePolicy(policy);
  const headings = [...text.matchAll(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)];
  if (!headings.length) return oneOrWindows(text, resolved);
  const chunks = [];
  if (headings[0].index > 0) chunks.push(...oneOrWindows(text.slice(0, headings[0].index), resolved));
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    const section = text.slice(start, end);
    const heading = headings[index][1].trim();
    for (const chunk of oneOrWindows(section, resolved, heading)) {
      chunks.push({
        ...chunk,
        byteStart: chunk.byteStart + byteOffset(text, start),
        byteEnd: chunk.byteEnd + byteOffset(text, start),
      });
    }
  }
  return chunks;
}

function newlineWidth(path) {
  const descriptor = openSync(path, 'r');
  try {
    const sample = Buffer.alloc(Math.min(statSync(path).size, 64 * 1024));
    readSync(descriptor, sample, 0, sample.length, 0);
    const newline = sample.indexOf(10);
    return newline > 0 && sample[newline - 1] === 13 ? 2 : 1;
  } finally {
    closeSync(descriptor);
  }
}

export async function chunkJsonl(path, policy = {}) {
  const resolved = mergePolicy(policy);
  const chunks = [];
  const size = statSync(path).size;
  const lineBreakBytes = newlineWidth(path);
  let bytePosition = 0;
  let current = [];
  let currentStart = 0;
  let currentBytes = 0;
  const flush = () => {
    if (!current.length) return;
    const content = current.join('\n');
    chunks.push({ content, byteStart: currentStart, byteEnd: currentStart + currentBytes, overlap: 0 });
    current = [];
    currentBytes = 0;
  };
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const nextPosition = Math.min(size, bytePosition + lineBytes + lineBreakBytes);
    if (estimateTokens(line) > resolved.maxInputTokens) {
      flush();
      for (const item of windowChunks(line, resolved)) {
        chunks.push({ ...item, byteStart: item.byteStart + bytePosition, byteEnd: item.byteEnd + bytePosition });
      }
    } else {
      const candidate = current.length ? `${current.join('\n')}\n${line}` : line;
      if (current.length && (current.length >= resolved.jsonlMaxLines || estimateTokens(candidate) > resolved.maxInputTokens)) flush();
      if (!current.length) currentStart = bytePosition;
      current.push(line);
      currentBytes = (bytePosition + lineBytes) - currentStart;
    }
    bytePosition = nextPosition;
  }
  flush();
  return chunks;
}

export async function summarizeJsonStream(path, fieldPolicy) {
  const keys = [];
  let depth = 0;
  let phase = 'start';
  let inString = false;
  let escaping = false;
  let stringRole;
  let key = '';
  const addType = (type) => {
    keys.push({ key, type });
    phase = 'after-value';
  };
  const stream = createReadStream(path, { encoding: 'utf8' });
  for await (const part of stream) {
    for (let index = 0; index < part.length; index += 1) {
      const character = part[index];
      if (inString) {
        if (escaping) escaping = false;
        else if (character === '\\') escaping = true;
        else if (character === '"') {
          inString = false;
          if (stringRole === 'key') phase = 'colon';
          else if (stringRole === 'value') phase = 'after-value';
          stringRole = undefined;
        } else if (stringRole === 'key') key += character;
        continue;
      }
      if (/\s/.test(character)) continue;
      if (phase === 'start') {
        if (character !== '{') throw codedError('JSON_INVALID', 'Large JSON input must be an object');
        depth = 1;
        phase = 'key';
        continue;
      }
      if (phase === 'key') {
        if (character === '}') { depth -= 1; phase = 'done'; continue; }
        if (character !== '"') throw codedError('JSON_INVALID', 'Expected top-level JSON key');
        key = '';
        inString = true;
        stringRole = 'key';
        continue;
      }
      if (phase === 'colon') {
        if (character !== ':') throw codedError('JSON_INVALID', 'Expected JSON colon');
        phase = 'value';
        continue;
      }
      if (phase === 'value') {
        if (character === '"') { addType('string'); inString = true; stringRole = 'value'; }
        else if (character === '{') { addType('object'); depth += 1; }
        else if (character === '[') { addType('array'); depth += 1; }
        else if (character === 't' || character === 'f') addType('boolean');
        else if (character === 'n') addType('null');
        else if (character === '-' || /\d/.test(character)) addType('number');
        else throw codedError('JSON_INVALID', 'Unsupported JSON value');
        continue;
      }
      if (phase === 'after-value') {
        if (character === '{' || character === '[') { depth += 1; continue; }
        if (character === '}' || character === ']') {
          depth -= 1;
          if (depth === 0) phase = 'done';
          continue;
        }
        if (character === ',' && depth === 1) phase = 'key';
      }
    }
  }
  if (depth !== 0 || phase !== 'done') throw codedError('JSON_INVALID', 'Unterminated JSON object');
  return { keys, approvedFields: Array.isArray(fieldPolicy) ? fieldPolicy : fieldPolicy?.fields ?? [] };
}

function vaultPathFrom(paths) {
  return dirname(dirname(paths.root));
}

function relativeVaultPath(vaultPath, path) {
  return relative(vaultPath, path).split(sep).join('/');
}

function assertNormalizedPath(paths, path) {
  if (!existsSync(paths.normalized)) throw codedError('NORMALIZED_PATH_INVALID', 'Normalized directory does not exist');
  const root = realpathSync(paths.normalized);
  const candidate = resolve(isAbsolute(path) ? path : join(vaultPathFrom(paths), path));
  const local = relative(root, candidate);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || !existsSync(candidate)) {
    throw codedError('NORMALIZED_PATH_INVALID', `Normalized path escapes workspace: ${path}`);
  }
  const actual = realpathSync(candidate);
  const actualRelative = relative(root, actual);
  if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) {
    throw codedError('NORMALIZED_PATH_INVALID', `Normalized link escapes workspace: ${path}`);
  }
  return actual;
}

function manifestFiles(inputManifest) {
  if (Array.isArray(inputManifest)) return inputManifest;
  if (Array.isArray(inputManifest?.files)) return inputManifest.files;
  if (Array.isArray(inputManifest?.records)) return inputManifest.records;
  throw codedError('INPUT_MANIFEST_INVALID', 'Input manifest must contain files');
}

function addItems(workItems, fileId, normalizedPath, chunks) {
  const startIndex = workItems.length;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const estimatedTokens = estimateTokens(chunk.content);
    if (estimatedTokens < 1 || estimatedTokens > chunk.policy.maxInputTokens) {
      throw codedError('WORK_ITEM_TOO_LARGE', `Work item for ${fileId} exceeds maxInputTokens`);
    }
    workItems.push({
      id: `${fileId}-${String(startIndex + index + 1).padStart(4, '0')}`,
      fileId,
      normalizedPath,
      byteStart: chunk.byteStart,
      byteEnd: chunk.byteEnd,
      estimatedTokens,
      overlap: chunk.overlap,
      contentHash: sha256(chunk.content),
      content: chunk.content,
      ...(chunk.heading ? { heading: chunk.heading } : {}),
    });
  }
}

export async function prepareWorkItems({ paths, batch, inputManifest, policy, external = [], fieldPolicy }) {
  const resolvedPolicy = mergePolicy(policy);
  if (!paths?.root || !batch?.id || !batch?.attemptToken) throw codedError('PREPARE_ARGUMENT_INVALID', 'paths, batch id, and attempt token are required');
  const vault = vaultPathFrom(paths);
  const files = manifestFiles(inputManifest);
  const wanted = new Set(batch.fileIds ?? files.map((record) => record.id));
  const externalByFile = new Map((external ?? []).map((record) => [record.fileId, record]));
  const workItems = [];
  const normalized = [];
  let usedJsonl = false;

  for (const record of files) {
    if (!wanted.has(record.id)) continue;
    const externalRecord = externalByFile.get(record.id);
    const sourcePath = assertPathWithinVault(vault, resolve(vault, externalRecord?.sourcePath ?? record.path));
    let contentPath = sourcePath;
    let normalizedPath = relativeVaultPath(vault, sourcePath);
    if (externalRecord) {
      contentPath = assertNormalizedPath(paths, externalRecord.normalizedPath);
      normalizedPath = relativeVaultPath(vault, contentPath);
      normalized.push({
        fileId: record.id,
        sourcePath: relativeVaultPath(vault, sourcePath),
        normalizedPath,
        processor: externalRecord.processor,
        processorVersion: externalRecord.processorVersion,
        sourceHash: sha256(readFileSync(sourcePath)),
        normalizedHash: sha256(readFileSync(contentPath)),
      });
    }
    const extension = (record.extension ?? '').toLowerCase();
    if (extension === '.jsonl') {
      const chunks = await chunkJsonl(contentPath, resolvedPolicy);
      for (const chunk of chunks) chunk.policy = resolvedPolicy;
      addItems(workItems, record.id, normalizedPath, chunks);
      usedJsonl = true;
      continue;
    }
    if (extension === '.json') {
      const bytes = readFileSync(contentPath);
      const text = bytes.toString('utf8');
      if (estimateTokens(text) > resolvedPolicy.maxInputTokens) {
        const approved = fieldPolicy ?? resolvedPolicy.fieldPolicy;
        if (!approved) throw codedError('JSON_FIELD_POLICY_REQUIRED', 'Large JSON objects require an approved fieldPolicy');
        const summary = await summarizeJsonStream(contentPath, approved);
        const summaryText = summary.keys.map((entry) => `${entry.key}: ${entry.type}`).join('\n');
        const chunks = chunkPlainText(summaryText, resolvedPolicy);
        for (const chunk of chunks) chunk.policy = resolvedPolicy;
        addItems(workItems, record.id, normalizedPath, chunks);
        continue;
      }
      const chunks = chunkPlainText(text, resolvedPolicy);
      for (const chunk of chunks) chunk.policy = resolvedPolicy;
      addItems(workItems, record.id, normalizedPath, chunks);
      continue;
    }
    const text = readFileSync(contentPath, 'utf8');
    const chunks = extension === '.md' || extension === '.markdown'
      ? chunkMarkdown(text, resolvedPolicy)
      : chunkPlainText(text, resolvedPolicy);
    for (const chunk of chunks) chunk.policy = resolvedPolicy;
    addItems(workItems, record.id, normalizedPath, chunks);
  }
  const output = {
    batchId: batch.id,
    attemptToken: batch.attemptToken,
    strategy: usedJsonl ? 'jsonl-stream' : 'bounded-text',
    policy: resolvedPolicy,
    normalized,
    workItems,
  };
  const preparedPath = join(paths.prepared ?? join(paths.root, 'prepared'), `${batch.id}-${batch.attemptToken}.json`);
  atomicWriteJson(preparedPath, output);
  return { ...output, path: preparedPath };
}
