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
  /**
   * Version-tracking status relative to the last ingest commit.
   * Only present once the vault has a `.git` repo (i.e. wiki has been used).
   * - `pending`: file never committed (not yet ingested into wiki)
   * - `tracked-clean`: committed, source unchanged since
   * - `tracked-modified`: committed, but source changed since (re-ingest advised)
   */
  ingestStatus?: IngestStatus;
}

/**
 * Ingest status of a vault file, derived from git HEAD vs workdir.
 * See {@link TreeNode.ingestStatus}.
 */
export type IngestStatus = 'pending' | 'tracked-clean' | 'tracked-modified';

export interface FileContent {
  path: string; // Relative path from vault root
  content: string; // Empty for binary files (use raw file URL instead); empty + tooLarge when over cap
  size: number;
  modifiedAt: number;
  mimeType?: string; // e.g. "image/png", "application/pdf"
  /** Detected text encoding, e.g. 'utf-8' | 'gb18030' | 'big5' | 'shift-jis'. */
  encoding?: string;
  /** True when size > MAX_VIEW_SIZE — content is empty; UI shows a "too large" card. */
  tooLarge?: boolean;
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

export type WikiOperationType = 'build' | 'ingest' | 'lint' | 'query' | 'save';

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

export interface WikiSaveRequest {
  agentId: string;
  message?: string;
  model?: string;
}

export interface WikiRunResponse {
  runId: string;
}

// ─── Graph types ───

export interface GraphNode {
  key: string;
  label: string;
  path: string;
  linkCount: number;
  nodeType?: string;
  deadLink?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface DeadLinkInfo {
  sourceFile: string;
  targetName: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  deadLinks: DeadLinkInfo[];
}

// ─── Search ───

export interface SearchResult {
  filePath: string;   // vault 相对路径
  fileName: string;   // basename
  snippet: string;    // 关键词前后各 30 字符
}

export interface SearchResponse {
  results: SearchResult[];
  truncated: boolean; // 是否因 limit 截断
}
