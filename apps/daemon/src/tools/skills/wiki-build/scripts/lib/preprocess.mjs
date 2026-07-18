import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  let maximumEnd = Math.min(text.length, preferredEnd);
  if (maximumEnd < text.length && isLowSurrogate(text.charCodeAt(maximumEnd))) maximumEnd -= 1;
  let end = start;
  for (let cursor = start; cursor < maximumEnd;) {
    const width = text.codePointAt(cursor) > 0xffff ? 2 : 1;
    const candidate = cursor + width;
    if (candidate > maximumEnd && end !== start) break;
    if (estimateTokens(text.slice(start, candidate)) > policy.maxInputTokens) break;
    end = candidate;
    cursor = candidate;
  }
  if (end === start && start < text.length) throw codedError('WORK_ITEM_TOO_LARGE', 'A single character exceeds maxInputTokens');
  return end;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function characterBoundaryBefore(text, index) {
  return index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index)) ? index - 1 : index;
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
    const nextStart = characterBoundaryBefore(text, Math.max(start + 1, end - policy.overlapChars));
    start = nextStart > start ? nextStart : end;
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

function createLineRangeTracker() {
  const ranges = [];
  let offset = 0;
  let lineStart = 0;
  let pendingCarriageReturn = -1;
  const emit = (end) => ranges.push({ byteStart: lineStart, byteEnd: end });
  const processByte = (byte) => {
    if (pendingCarriageReturn >= 0) {
      if (byte === 10) {
        emit(pendingCarriageReturn);
        lineStart = offset + 1;
        pendingCarriageReturn = -1;
        offset += 1;
        return;
      }
      emit(pendingCarriageReturn);
      lineStart = pendingCarriageReturn + 1;
      pendingCarriageReturn = -1;
    }
    if (byte === 13) pendingCarriageReturn = offset;
    else if (byte === 10) {
      emit(offset);
      lineStart = offset + 1;
    }
    offset += 1;
  };
  return {
    ranges,
    stream: new Transform({
      transform(chunk, _encoding, callback) {
        for (const byte of chunk) processByte(byte);
        callback(null, chunk);
      },
      flush(callback) {
        if (pendingCarriageReturn >= 0) {
          emit(pendingCarriageReturn);
          lineStart = pendingCarriageReturn + 1;
          pendingCarriageReturn = -1;
        }
        if (lineStart < offset) emit(offset);
        callback();
      },
    }),
  };
}

export async function chunkJsonl(path, policy = {}) {
  const resolved = mergePolicy(policy);
  const chunks = [];
  let current = [];
  let currentStart = 0;
  let currentEnd = 0;
  const flush = () => {
    if (!current.length) return;
    const content = current.join('\n');
    chunks.push({ content, byteStart: currentStart, byteEnd: currentEnd, overlap: 0 });
    current = [];
  };
  const tracker = createLineRangeTracker();
  const input = createReadStream(path).pipe(tracker.stream);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const range = tracker.ranges.shift();
    if (!range) throw codedError('JSONL_STREAM_INVALID', 'Missing byte range for JSONL line');
    if (!line) continue;
    if (estimateTokens(line) > resolved.maxInputTokens) {
      flush();
      for (const item of windowChunks(line, resolved)) {
        chunks.push({ ...item, byteStart: item.byteStart + range.byteStart, byteEnd: item.byteEnd + range.byteStart });
      }
    } else {
      const candidate = current.length ? `${current.join('\n')}\n${line}` : line;
      if (current.length && (current.length >= resolved.jsonlMaxLines || estimateTokens(candidate) > resolved.maxInputTokens)) flush();
      if (!current.length) currentStart = range.byteStart;
      current.push(line);
      currentEnd = range.byteEnd;
    }
  }
  flush();
  return chunks;
}

function approvedFields(fieldPolicy) {
  if (fieldPolicy === undefined || fieldPolicy === null) {
    throw codedError('JSON_FIELD_POLICY_REQUIRED', 'Large JSON objects require an approved fieldPolicy');
  }
  const prototype = typeof fieldPolicy === 'object' ? Object.getPrototypeOf(fieldPolicy) : undefined;
  if (prototype !== Object.prototype || fieldPolicy.approved !== true || !Array.isArray(fieldPolicy.fields)
    || fieldPolicy.fields.length === 0 || fieldPolicy.fields.some((field) => typeof field !== 'string' || !field)
    || new Set(fieldPolicy.fields).size !== fieldPolicy.fields.length) {
    throw codedError('JSON_FIELD_POLICY_INVALID', 'fieldPolicy must explicitly approve unique top-level fields');
  }
  return new Set(fieldPolicy.fields);
}

export async function summarizeJsonStream(path, fieldPolicy) {
  const allowed = approvedFields(fieldPolicy);
  const keys = [];
  const containers = [];
  let phase = 'start';
  let inString = false;
  let escaping = false;
  let stringRole = 'nested';
  let stringLiteral = '';
  let key = '';
  let primitive = '';
  const addType = (type) => {
    if (allowed.has(key)) keys.push({ key, type });
    phase = 'after-value';
  };
  const finishPrimitive = () => {
    let value;
    try {
      value = JSON.parse(primitive);
    } catch {
      throw codedError('JSON_INVALID', 'Invalid top-level JSON primitive');
    }
    if (value === null) addType('null');
    else if (typeof value === 'boolean') addType('boolean');
    else if (typeof value === 'number') addType('number');
    else throw codedError('JSON_INVALID', 'Invalid top-level JSON primitive');
    primitive = '';
  };
  const closeContainer = (character) => {
    const expected = character === '}' ? '{' : '[';
    if (containers.at(-1) !== expected) throw codedError('JSON_INVALID', 'Mismatched JSON container');
    containers.pop();
    if (!containers.length) phase = 'done';
  };
  const stream = createReadStream(path, { encoding: 'utf8' });
  for await (const part of stream) {
    for (let index = 0; index < part.length; index += 1) {
      const character = part[index];
      if (inString) {
        if (stringRole === 'key') stringLiteral += character;
        if (escaping) escaping = false;
        else if (character === '\\') escaping = true;
        else if (character === '"') {
          inString = false;
          if (stringRole === 'key') {
            try { key = JSON.parse(stringLiteral); } catch { throw codedError('JSON_INVALID', 'Invalid JSON key'); }
            phase = 'colon';
          }
          if (stringRole === 'value') phase = 'after-value';
          stringRole = 'nested';
        }
        continue;
      }
      if (primitive) {
        if (character === ',' || character === '}') {
          finishPrimitive();
        } else {
          primitive += character;
          continue;
        }
      }
      if (/\s/.test(character)) continue;
      if (phase === 'start') {
        if (character !== '{') throw codedError('JSON_INVALID', 'Large JSON input must be an object');
        containers.push('{');
        phase = 'key';
        continue;
      }
      if (phase === 'done') throw codedError('JSON_INVALID', 'Trailing content after JSON root');
      if (phase === 'key') {
        if (character === '}') { closeContainer(character); continue; }
        if (character !== '"') throw codedError('JSON_INVALID', 'Expected top-level JSON key');
        inString = true;
        stringRole = 'key';
        stringLiteral = '"';
        continue;
      }
      if (phase === 'colon') {
        if (character !== ':') throw codedError('JSON_INVALID', 'Expected JSON colon');
        phase = 'value';
        continue;
      }
      if (phase === 'value') {
        if (character === '"') { addType('string'); inString = true; stringRole = 'value'; }
        else if (character === '{') { addType('object'); containers.push('{'); }
        else if (character === '[') { addType('array'); containers.push('['); }
        else if (character === 't' || character === 'f' || character === 'n' || character === '-' || /\d/.test(character)) primitive = character;
        else throw codedError('JSON_INVALID', 'Unsupported JSON value');
        continue;
      }
      if (phase === 'after-value') {
        if (character === '"') { inString = true; stringRole = 'nested'; continue; }
        if (character === '{' || character === '[') { containers.push(character); continue; }
        if (character === '}' || character === ']') { closeContainer(character); continue; }
        if (character === ',' && containers.length === 1) { phase = 'key'; continue; }
        if (containers.length === 1) throw codedError('JSON_INVALID', 'Expected top-level JSON delimiter');
      }
    }
  }
  if (primitive || containers.length || phase !== 'done') throw codedError('JSON_INVALID', 'Unterminated JSON object');
  return { keys, approvedFields: [...allowed] };
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

function safePathSegment(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function preparedOutputPath(paths, vault, batch) {
  if (!safePathSegment(batch.id) || !safePathSegment(batch.attemptToken)) {
    throw codedError('PREPARE_ARGUMENT_INVALID', 'batch id and attempt token must be safe path segments');
  }
  const prepared = paths.prepared ?? join(paths.root, 'prepared');
  mkdirSync(prepared, { recursive: true });
  assertPathWithinVault(vault, prepared);
  const preparedRoot = realpathSync(prepared);
  const buildRoot = realpathSync(paths.root);
  const relation = relative(buildRoot, preparedRoot);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw codedError('PREPARED_PATH_INVALID', 'Prepared directory escapes wiki-build workspace');
  }
  const target = join(preparedRoot, `${batch.id}-${batch.attemptToken}.json`);
  if (dirname(target) !== preparedRoot) throw codedError('PREPARED_PATH_INVALID', 'Prepared output must be a direct child');
  assertPathWithinVault(vault, target);
  return target;
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
  const preparedPath = preparedOutputPath(paths, vault, batch);
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
    const extension = (externalRecord ? extname(contentPath) : record.extension ?? '').toLowerCase();
    if (extension === '.jsonl') {
      const chunks = await chunkJsonl(contentPath, resolvedPolicy);
      for (const chunk of chunks) chunk.policy = resolvedPolicy;
      addItems(workItems, record.id, normalizedPath, chunks);
      usedJsonl = true;
      continue;
    }
    if (extension === '.json') {
      if (Math.ceil(statSync(contentPath).size / 3) > resolvedPolicy.maxInputTokens) {
        const approved = fieldPolicy ?? resolvedPolicy.fieldPolicy;
        const summary = await summarizeJsonStream(contentPath, approved);
        const summaryText = summary.keys.map((entry) => `${entry.key}: ${entry.type}`).join('\n');
        const chunks = chunkPlainText(summaryText, resolvedPolicy);
        for (const chunk of chunks) chunk.policy = resolvedPolicy;
        addItems(workItems, record.id, normalizedPath, chunks);
        continue;
      }
      const text = readFileSync(contentPath, 'utf8');
      try { JSON.parse(text); } catch { throw codedError('JSON_INVALID', 'Invalid JSON input'); }
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
  atomicWriteJson(preparedPath, output);
  return { ...output, path: preparedPath };
}
