/**
 * Knowledge Base filesystem operations — scan directory tree, read/write files.
 * Vaults map to local folders; files live on disk (not in SQLite).
 */

import fs from 'node:fs';
import path from 'node:path';
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
 */
export function readFile(vaultPath: string, relPath: string): FileContent {
  const absFile = path.join(vaultPath, relPath);

  // Security: prevent path traversal
  const resolved = path.resolve(absFile);
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

  const stat = fs.statSync(resolved);
  const content = fs.readFileSync(resolved, 'utf-8');

  return {
    path: relPath,
    content,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
  };
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
 * Delete a file from a vault.
 */
export function deleteFile(vaultPath: string, relPath: string): void {
  const absFile = path.join(vaultPath, relPath);

  const resolved = path.resolve(absFile);
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

  if (fs.existsSync(resolved)) {
    fs.unlinkSync(resolved);
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
  return ['.md', '.txt', '.pdf', '.docx', '.html', '.htm', '.json', '.yaml', '.yml'].includes(ext);
}
