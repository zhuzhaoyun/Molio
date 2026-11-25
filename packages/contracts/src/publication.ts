/** Public, read-only projection of one published Wiki revision. */
export interface PublicPageSummary {
  id: string;
  title: string;
}

export interface PublicSite {
  enabled: boolean;
  revision: number;
  pages: PublicPageSummary[];
}

export interface PublicPage {
  revision: number;
  id: string;
  title: string;
  markdown: string;
  assetIds: string[];
}

export interface PublicGraph {
  revision: number;
  nodes: Array<{ id: string; title: string }>;
  edges: Array<{ source: string; target: string }>;
}

export interface PublicAsset {
  revision: number;
  id: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  bytes: Uint8Array;
}

/** Admin-only source mapping. Never return this shape from an anonymous API. */
export interface PublicationStatus {
  enabled: boolean;
  revision: number;
  vaultId: string | null;
  pages: Array<PublicPageSummary & { sourcePath: string; published: boolean }>;
}

export interface PublicationPreviewRequest {
  vaultId: string;
  selectedPaths: string[];
}

export interface PublicationPreviewPage {
  id: string;
  title: string;
  sourcePath: string;
  markdown: string;
  warnings: string[];
  assets: Array<{ id: string; sourcePath: string; contentType: PublicAsset['contentType']; size: number }>;
}

export interface PublicationPreview {
  id: string;
  expectedRevision: number;
  expiresAt: number;
  pageCount: number;
  totalBytes: number;
  pages: PublicationPreviewPage[];
  warnings: string[];
}

export interface PublicationCommitRequest {
  previewId: string;
  expectedRevision: number;
}

export interface PublicationWithdrawRequest {
  expectedRevision: number;
  pageIds: string[];
}

export interface PublicationSiteRequest {
  expectedRevision: number;
  enabled: boolean;
}

export interface PublicationRevision {
  revision: number;
  enabled: boolean;
  pageCount: number;
}
