/**
 * DaemonClient — Molio daemon HTTP API 的薄客户端（只读子集）。
 *
 * 移植自 apps/cli/src/daemon-client.ts，设计红线相同：插件不含任何知识库
 * 逻辑（路径穿越防护、编码检测、大文件拒绝等全在 daemon 侧），本文件只做
 * fetch 封装 + 类型化错误映射（DaemonError）。
 *
 * 与 CLI 版的差异：
 * - 只保留只读端点（health / vaults / active-vault / tree / files / search），
 *   不含 run/SSE（本插件不做 AI 问答）；
 * - 每个方法接受调用方 AbortSignal（dsh 工具管线经 exec.signal 传递取消），
 *   未传时用默认超时兜底。
 *
 * 基址解析：MOLIO_DAEMON_URL（显式覆盖，支持远程/NAS/Docker 部署）
 *        → http://127.0.0.1:${MOLIO_PORT ?? 3100}（daemon 默认端口）
 */
import type { FileContent, SearchResponse, TreeNode, Vault } from '@molio/contracts';
import { DaemonError, type DaemonErrorCode } from './errors.js';

/** GET /api/health 的响应（daemon server.ts 内联形状，contracts 无完整类型）。 */
export interface HealthInfo {
  status: string;
  version: string;
  memory?: Record<string, number>;
  activeRuns: number;
  uptime: number;
}

export interface ActiveVaultResponse {
  vaultId: string | null;
  vault: Vault | null;
}

/** 短请求默认超时（health/vaults/tree/search 等单次 HTTP）。 */
const DEFAULT_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;

export function defaultBaseUrl(): string {
  const explicit = process.env['MOLIO_DAEMON_URL'];
  if (explicit && explicit.trim()) return stripTrailingSlash(explicit.trim());
  return `http://127.0.0.1:${process.env['MOLIO_PORT'] ?? 3100}`;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export class DaemonClient {
  readonly baseUrl: string;

  constructor(baseUrl: string = defaultBaseUrl()) {
    this.baseUrl = stripTrailingSlash(baseUrl);
  }

  // ─── 底层请求 ───

  private async request<T>(
    path: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // 调用方主动取消：原样上抛，由 dsh 管线归类为 ABORTED，不伪装成 daemon 故障
      if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) throw err;
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new DaemonError('TIMEOUT', `GET ${path} 超过 ${timeoutMs}ms`);
      }
      throw new DaemonError(
        'DAEMON_UNREACHABLE',
        `无法连接 ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw await this.toDaemonError(res, path);
    }
    return (await res.json()) as T;
  }

  private async toDaemonError(res: Response, path: string): Promise<DaemonError> {
    let code: DaemonErrorCode = 'HTTP_ERROR';
    let message = `HTTP ${res.status} (${path})`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.message) message = body.error.message;
      if (body?.error?.code === 'NOT_FOUND') code = 'NOT_FOUND';
    } catch {
      /* 非 JSON 错误体，保留状态码消息 */
    }
    if (res.status === 404) code = 'NOT_FOUND';
    if (res.status === 413) code = 'FILE_TOO_LARGE';
    return new DaemonError(code, message, res.status);
  }

  // ─── 健康 ───

  health(signal?: AbortSignal): Promise<HealthInfo> {
    return this.request<HealthInfo>('/api/health', { signal, timeoutMs: HEALTH_TIMEOUT_MS });
  }

  // ─── 知识库（只读） ───

  async listVaults(signal?: AbortSignal): Promise<Vault[]> {
    const res = await this.request<{ vaults: Vault[] }>('/api/knowledge/vaults', { signal });
    return res.vaults;
  }

  getActiveVault(signal?: AbortSignal): Promise<ActiveVaultResponse> {
    return this.request<ActiveVaultResponse>('/api/knowledge/active-vault', { signal });
  }

  async getTree(vaultId: string, signal?: AbortSignal): Promise<TreeNode[]> {
    const res = await this.request<{ tree: TreeNode[] }>(
      `/api/knowledge/vaults/${encodeURIComponent(vaultId)}/tree`,
      { signal },
    );
    return res.tree;
  }

  /**
   * 读文件。relPath 是 vault 相对路径（可含 /），整段 encodeURIComponent 进
   * wildcard（与 CLI/web 客户端相同做法，daemon 侧 decodeURIComponent）。
   */
  readFile(
    vaultId: string,
    relPath: string,
    force = false,
    signal?: AbortSignal,
  ): Promise<FileContent> {
    const query = force ? '?force=1' : '';
    return this.request<FileContent>(
      `/api/knowledge/vaults/${encodeURIComponent(vaultId)}/files/${encodeURIComponent(relPath)}${query}`,
      { signal },
    );
  }

  search(
    vaultId: string,
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set('limit', String(limit));
    return this.request<SearchResponse>(
      `/api/knowledge/vaults/${encodeURIComponent(vaultId)}/search?${params.toString()}`,
      { signal },
    );
  }
}
