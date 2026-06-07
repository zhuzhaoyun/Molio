/**
 * Knowledge Base shared types — vaults, file tree, file content.
 */

export interface Vault {
  id: string;
  name: string;
  path: string; // Local filesystem absolute path
  description?: string;
  fileCount: number;
  createdAt: number;
}

export interface TreeNode {
  name: string; // File or directory name
  path: string; // Relative path from vault root
  type: 'file' | 'directory';
  children?: TreeNode[]; // Only for directories
  size?: number; // Only for files (bytes)
  modifiedAt?: number; // Only for files (epoch ms)
}

export interface FileContent {
  path: string; // Relative path from vault root
  content: string;
  size: number;
  modifiedAt: number;
}

export interface KbHistoryEntry {
  id: string;
  vaultId: string;
  action: 'ingest' | 'lint' | 'edit' | 'import';
  detail: string;
  createdAt: number;
}

// ─── Request types ───

export interface CreateVaultRequest {
  name: string;
  path: string;
  description?: string;
}

// ─── Response types ───

export interface VaultListResponse {
  vaults: Vault[];
}

export interface FileTreeResponse {
  tree: TreeNode[];
}

export interface KbHistoryListResponse {
  history: KbHistoryEntry[];
}

// ─── Wiki types ───

export type WikiOperationType = 'build' | 'ingest' | 'lint' | 'query';

export interface WikiStatusResponse {
  initialized: boolean;
  indexExists: boolean;
  wikiDirExists: boolean;
}

export interface WikiBuildRequest {
  agentId: string;
  model?: string;
}

export interface WikiIngestRequest {
  agentId: string;
  filePath: string;
  model?: string;
}

export interface WikiLintRequest {
  agentId: string;
  model?: string;
}

export interface WikiQueryRequest {
  agentId: string;
  message: string;
  model?: string;
}

export interface WikiRunResponse {
  runId: string;
}
