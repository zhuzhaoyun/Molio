/**
 * Knowledge Base filesystem operations — scan directory tree, read/write files.
 * Vaults map to local folders; files live on disk (not in SQLite).
 */

import fs from 'node:fs';
import path from 'node:path';
import trash from 'trash';
import type { TreeNode, FileContent } from '@molio/contracts';

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
  const absFile = path.join(vaultPath, relPath);

  // Security: prevent path traversal
  const resolved = path.resolve(absFile);
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

  const stat = fs.statSync(resolved);
  const mimeType = getMimeType(relPath);
  const content = isTextFile(resolved) ? fs.readFileSync(resolved, 'utf-8') : '';

  return {
    path: relPath,
    content,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    mimeType,
  };
}

/** Resolve a vault-relative path to an absolute filesystem path. */
export function resolveFilePath(vaultPath: string, relPath: string): string {
  const absFile = path.join(vaultPath, relPath);
  const resolved = path.resolve(absFile);
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }
  return resolved;
}

/**
 * Write content to a file in a vault. Creates parent directories if needed.
 */
export function writeFile(vaultPath: string, relPath: string, content: string): void {
  const absFile = path.join(vaultPath, relPath);

  // Security: prevent path traversal
  const resolved = path.resolve(absFile);
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
}

/**
 * Delete a file from a vault — moves to system recycle bin instead of permanent deletion.
 */
export async function deleteFile(vaultPath: string, relPath: string): Promise<void> {
  const absFile = path.join(vaultPath, relPath);

  const resolved = path.resolve(absFile);
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

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
  const vaultRoot = path.resolve(vaultPath);
  if (!absOld.startsWith(vaultRoot) || !absNew.startsWith(vaultRoot)) {
    throw new Error('Path traversal not allowed');
  }

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
  if (!absDir.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

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
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

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

function isTextFile(filePath: string): boolean {
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
