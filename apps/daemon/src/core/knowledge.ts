/**
 * Knowledge Base filesystem operations — scan directory tree, read/write files.
 * Vaults map to local folders; files live on disk (not in SQLite).
 */

import fs from 'node:fs';
import path from 'node:path';
import trash from 'trash';
import type { TreeNode, FileContent, SearchResult } from '@molio/contracts';

/**
 * Scan a vault directory and return the file tree.
 * Only includes .md, .txt, .pdf, .docx, .html files and directories.
 */
export function scanTree(vaultPath: string, relBase = ''): TreeNode[] {
  const absDir = relBase ? path.join(vaultPath, relBase) : vaultPath;
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    // Skip hidden files/dirs
    if (entry.name.startsWith('.')) continue;

    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const children = scanTree(vaultPath, relPath);
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        children,
      });
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      const absFile = path.join(absDir, entry.name);
      const stat = fs.statSync(absFile);
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    }
  }

  // Sort: directories first, then files, alphabetically
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

/**
 * Count all supported files in a vault directory (recursive).
 */
export function countFiles(vaultPath: string): number {
  let count = 0;
  const entries = fs.readdirSync(vaultPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      count += countFiles(path.join(vaultPath, entry.name));
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      count++;
    }
  }

  return count;
}

/**
 * Read a file from a vault. Path is relative to vault root.
 * For text files, returns content as UTF-8 string.
 * For binary files (images, PDF, DOCX), content is empty — use raw file URL or openPath.
 */
export function readFile(vaultPath: string, relPath: string): FileContent {
  let resolved = resolveFilePath(vaultPath, relPath);

  if (!fs.existsSync(resolved)) {
    resolved = resolveWithFallbacks(vaultPath, relPath);
  }

  if (!fs.existsSync(resolved)) {
    const err = new Error(`File not found: ${relPath}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }

  // Follow symlinks and re-validate the real path is still inside the vault
  // before reading — defends against a symlink swapped in to escape the vault.
  const real = resolveRealWithinVault(vaultPath, resolved);

  const stat = fs.statSync(real);
  const mimeType = getMimeType(path.basename(real));
  const content = isTextFile(real) ? fs.readFileSync(real, 'utf-8') : '';

  return {
    path: relPath,
    content,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    mimeType,
  };
}

/**
 * Try multiple fallback strategies to find a file that may be missing
 * an extension, in a subdirectory, or have case mismatches.
 */
function resolveWithFallbacks(vaultPath: string, relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  const hasExt = !!ext;

  // Prefixes to try: vault root, then wiki/ subdirectory
  const prefixes = [''];
  if (!relPath.startsWith('wiki/')) {
    prefixes.push('wiki/');
  }

  for (const prefix of prefixes) {
    const baseRelPath = prefix + relPath;

    // Strategy A: exact path
    const exact = resolveFilePath(vaultPath, baseRelPath);
    if (fs.existsSync(exact)) return exact;

    // Strategy B: add .md extension
    if (!hasExt) {
      const md = resolveFilePath(vaultPath, baseRelPath + '.md');
      if (fs.existsSync(md)) return md;
    }

    // Strategy C: case-insensitive search in the target directory
    const targetDir = path.dirname(exact);
    const targetBase = path.basename(exact);
    const targetLower = targetBase.toLowerCase();
    try {
      const entries = fs.readdirSync(targetDir);
      // Exact case-insensitive match
      let match = entries.find((e) => e.toLowerCase() === targetLower);
      // Try with .md if original has no extension
      if (!match && !hasExt) {
        match = entries.find((e) => e.toLowerCase() === targetLower + '.md');
      }
      if (match) {
        // Re-validate so a matched entry can never bypass the vault boundary
        // (defense-in-depth).
        const candidate = path.join(targetDir, match);
        assertWithinVault(vaultPath, candidate);
        return candidate;
      }
    } catch {
      // directory not found — try next prefix
    }
  }

  // Strategy D: bare page name (no directory component) — recursively search
  // the vault. Wiki links are conventionally bare page names like
  // "[[知识库五范式]]", but the file usually lives in a nested wiki/
  // subdirectory, so the per-directory search above misses it. Walk the tree
  // for a file whose stem matches (case-insensitive, ±.md).
  if (!relPath.includes('/')) {
    const found = findFileByStem(vaultPath, relPath, hasExt);
    if (found) return found;
  }

  // Return the original resolved path if all fallbacks fail
  return resolveFilePath(vaultPath, relPath);
}

/**
 * Recursively walk the vault for a file matching a bare page name.
 * - With extension: match the full filename (case-insensitive).
 * - Without extension: match the filename stem (basename minus extension),
 *   so "[[知识库五范式]]" resolves to "知识库五范式.md" anywhere in the tree.
 * Hidden entries (`.molio`, `.claude`, …) are skipped.
 */
function findFileByStem(
  vaultPath: string,
  bareName: string,
  hasExt: boolean,
): string | null {
  const nameLower = bareName.toLowerCase();
  const stemLower = hasExt
    ? path.basename(bareName, path.extname(bareName)).toLowerCase()
    : nameLower;
  let result: string | null = null;

  const walk = (dir: string): void => {
    if (result) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        if (result) return;
      } else if (entry.isFile()) {
        const entryLower = entry.name.toLowerCase();
        const match = hasExt
          ? entryLower === nameLower
          : entryLower === nameLower ||
            path.basename(entry.name, path.extname(entry.name)).toLowerCase() === stemLower;
        if (match) {
          assertWithinVault(vaultPath, abs);
          result = abs;
          return;
        }
      }
    }
  };

  walk(vaultPath);
  return result;
}

/** Resolve a vault-relative path to an absolute filesystem path. */
export function resolveFilePath(vaultPath: string, relPath: string): string {
  const absFile = path.join(vaultPath, relPath);
  const resolved = path.resolve(absFile);
  assertWithinVault(vaultPath, resolved);
  return resolved;
}

/**
 * Verify an already-resolved absolute path stays inside the vault root.
 * Uses a trailing path separator so a sibling directory like
 * `/data/vault-secret` is NOT mistaken for `/data/vault`. The daemon has no
 * authentication (CORS allows any localhost origin), so this guard is the
 * primary boundary against path-traversal exfiltration.
 */
function assertWithinVault(vaultPath: string, resolved: string): void {
  const vaultRoot = path.resolve(vaultPath);
  if (resolved !== vaultRoot && !resolved.startsWith(vaultRoot + path.sep)) {
    throw new Error('Path traversal not allowed');
  }
}

/**
 * Resolve the real on-disk path (following symlinks) and confirm it remains
 * inside the vault. Closes a TOCTOU/symlink-escape: between an existsSync
 * check and a later read, a file could be replaced with a symlink pointing
 * outside the vault, and statSync/readFileSync follow symlinks by default.
 *
 * The vault root itself may contain symlink components (e.g. macOS tmpdir
 * `/var` → `/private/var`), so we canonicalize both sides before comparing.
 */
function resolveRealWithinVault(vaultPath: string, resolved: string): string {
  assertWithinVault(vaultPath, resolved);
  const real = fs.realpathSync(resolved);
  // Canonicalize the vault root the same way so a symlinked root doesn't
  // cause legitimate reads to be rejected.
  let realVault: string;
  try {
    realVault = fs.realpathSync(path.resolve(vaultPath));
  } catch {
    realVault = path.resolve(vaultPath);
  }
  if (real !== realVault && !real.startsWith(realVault + path.sep)) {
    throw new Error('Path traversal not allowed');
  }
  return real;
}

/**
 * Write content to a file in a vault. Creates parent directories if needed.
 */
export function writeFile(vaultPath: string, relPath: string, content: string): void {
  const absFile = path.join(vaultPath, relPath);

  // Security: prevent path traversal (sibling-directory bypass)
  const resolved = path.resolve(absFile);
  assertWithinVault(vaultPath, resolved);

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
}

/**
 * Delete a file from a vault — moves to system recycle bin instead of permanent deletion.
 */
export async function deleteFile(vaultPath: string, relPath: string): Promise<void> {
  const absFile = path.join(vaultPath, relPath);

  const resolved = path.resolve(absFile);
  assertWithinVault(vaultPath, resolved);

  if (fs.existsSync(resolved)) {
    await trash(resolved);
  }
}

/**
 * Rename / move a file or directory within a vault.
 */
export function renamePath(vaultPath: string, oldRelPath: string, newRelPath: string): void {
  const absOld = path.resolve(path.join(vaultPath, oldRelPath));
  const absNew = path.resolve(path.join(vaultPath, newRelPath));

  // Security: both paths must be inside the vault
  assertWithinVault(vaultPath, absOld);
  assertWithinVault(vaultPath, absNew);

  if (!fs.existsSync(absOld)) {
    throw new Error(`Source not found: ${oldRelPath}`);
  }

  // Create parent directories for the new path
  fs.mkdirSync(path.dirname(absNew), { recursive: true });
  fs.renameSync(absOld, absNew);
}

/**
 * Delete a directory (recursively) from a vault — moves to system recycle bin.
 */
export async function deleteDirectory(vaultPath: string, relPath: string): Promise<void> {
  const absDir = path.resolve(path.join(vaultPath, relPath));

  // Security: prevent path traversal
  assertWithinVault(vaultPath, absDir);

  if (fs.existsSync(absDir)) {
    await trash(absDir);
  }
}

/**
 * Create a directory inside a vault.
 */
export function createDirectory(vaultPath: string, relPath: string): void {
  const absDir = path.join(vaultPath, relPath);

  const resolved = path.resolve(absDir);
  assertWithinVault(vaultPath, resolved);

  fs.mkdirSync(resolved, { recursive: true });
}

/**
 * Ensure a vault directory exists on disk.
 */
export function ensureVaultDir(vaultPath: string): void {
  fs.mkdirSync(vaultPath, { recursive: true });
}

function isSupportedFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return [...TEXT_EXTS, ...IMAGE_EXTS, ...BINARY_EXTS].includes(ext);
}

/** Text file extensions — content read as UTF-8 */
const TEXT_EXTS = ['.md', '.txt', '.html', '.htm', '.json', '.yaml', '.yml'];

/** Image file extensions — displayed inline via <img> */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'];

/** Binary file extensions — opened via system default program */
const BINARY_EXTS = ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls'];

export function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTS.includes(ext);
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

const MIME_TYPES: Record<string, string> = {
  // Text
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // Binary documents
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

/**
 * 全文搜索 vault 内文本文件。遍历目录，对每个文本文件 String.includes 匹配，
 * 命中则截取关键词前后 30 字符作为 snippet。
 * - 跳过隐藏文件/目录（. 开头）
 * - 只搜 TEXT_EXTS 内的文件
 * - limit 截断，truncated 标记是否还有更多
 */
export function searchFiles(
  vaultPath: string,
  query: string,
  limit = 20,
): { results: SearchResult[]; truncated: boolean } {
  const results: SearchResult[] = [];
  let truncated = false;

  const walk = (absDir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        if (truncated) return;
      } else if (entry.isFile() && isTextFile(entry.name)) {
        const content = fs.readFileSync(abs, 'utf-8');
        const idx = content.indexOf(query);
        if (idx >= 0) {
          const start = Math.max(0, idx - 30);
          const end = Math.min(content.length, idx + query.length + 30);
          const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
          // vault 相对路径
          const relPath = path.relative(vaultPath, abs).split(path.sep).join('/');
          results.push({ filePath: relPath, fileName: entry.name, snippet });
          if (results.length >= limit) {
            truncated = true;
            return;
          }
        }
      }
    }
  };

  walk(vaultPath);
  return { results, truncated };
}
