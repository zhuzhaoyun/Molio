/**
 * DaemonClient — Molio daemon HTTP API 的薄客户端。
 *
 * 设计红线：CLI 不含任何知识库逻辑（路径穿越防护、编码检测、回收站删除等
 * 全部在 daemon 侧，apps/daemon/src/core/knowledge.ts）。本文件只做
 * fetch 封装 + 类型化错误映射（DaemonError），供 CLI 命令与 MCP tools 共用。
 *
 * 基址解析：MOLIO_DAEMON_URL（显式覆盖，支持远程/NAS 部署）
 *        → http://127.0.0.1:${MOLIO_PORT ?? 3100}（daemon 默认端口）
 */
import type {
  AgentInfo,
  ChatMessage,
  CreateRunRequest,
  CreateRunResponse,
  FileContent,
  RunInfo,
  SearchResponse,
  SSEEnvelope,
  TreeNode,
  Vault,
} from '@molio/contracts';
import { DaemonError, type DaemonErrorCode } from './errors.js';
import { parseSseStream } from './sse-parser.js';

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
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = init;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...fetchInit,
        signal: fetchInit.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
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

  // ─── 健康 / agents ───

  health(): Promise<HealthInfo> {
    return this.request<HealthInfo>('/api/health', { timeoutMs: HEALTH_TIMEOUT_MS });
  }

  async listAgents(): Promise<AgentInfo[]> {
    const res = await this.request<{ agents: AgentInfo[] }>('/api/agents');
    return res.agents;
  }

  // ─── 知识库（只读） ───

  async listVaults(): Promise<Vault[]> {
    const res = await this.request<{ vaults: Vault[] }>('/api/knowledge/vaults');
    return res.vaults;
  }

  getActiveVault(): Promise<ActiveVaultResponse> {
    return this.request<ActiveVaultResponse>('/api/knowledge/active-vault');
  }

  async getTree(vaultId: string): Promise<TreeNode[]> {
    const res = await this.request<{ tree: TreeNode[] }>(
      `/api/knowledge/vaults/${encodeURIComponent(vaultId)}/tree`,
    );
    return res.tree;
  }

  /**
   * 读文件。relPath 是 vault 相对路径（可含 /），整段 encodeURIComponent 进
   * wildcard（与 web 客户端 client.ts:636 相同做法，daemon 侧 decodeURIComponent）。
   */
  readFile(vaultId: string, relPath: string, force = false): Promise<FileContent> {
    const query = force ? '?force=1' : '';
    return this.request<FileContent>(
      `/api/knowledge/vaults/${encodeURIComponent(vaultId)}/files/${encodeURIComponent(relPath)}${query}`,
    );
  }

  search(vaultId: string, query: string, limit?: number): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set('limit', String(limit));
    return this.request<SearchResponse>(
      `/api/knowledge/vaults/${encodeURIComponent(vaultId)}/search?${params.toString()}`,
    );
  }

  // ─── Run（AI 问答） ───

  createRun(req: CreateRunRequest): Promise<CreateRunResponse> {
    return this.request<CreateRunResponse>('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  }

  getRun(runId: string): Promise<RunInfo> {
    return this.request<RunInfo>(`/api/runs/${encodeURIComponent(runId)}`);
  }

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    const res = await this.request<{ messages: ChatMessage[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    return res.messages;
  }

  /**
   * 取消 / 结束一个 run（DELETE /api/runs/:id → 204）。
   *
   * 为什么需要：Claude Code 等 **multiTurn** agent 在一次 turn 结束（turn_end）后
   * **不退出进程**（stdin 保持打开等后续消息，见 RunManager.maybeCloseStdin 的
   * `if (def?.multiTurn) return`），run 会一直停在 'running' 直到 30min TTL。
   * CLI/MCP 的一次性问答不会复用 run 做多人对话，因此拿到答案后主动 cancel，
   * 释放挂起的 agent 进程，避免反复 ask 累积一堆常驻子进程。
   *
   * 幂等 + 尽力而为：run 已终态时 daemon 侧 no-op；404（TTL 已清）视同成功。
   * 调用方应 `.catch(() => {})` 吞掉网络错误——cancel 只是清理，拿不到不影响答案。
   */
  async cancelRun(runId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/runs/${encodeURIComponent(runId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch {
      // 网络错误：尽力而为，忽略
    }
    // 204 = 取消成功；404 = run 已不在（TTL 清理），同样达到「run 不再活着」的目的。
    // 其余非 ok 也不致命（答案已到手），静默忽略，避免污染调用方。
  }

  /**
   * 订阅 run 的 SSE 事件流（异步迭代，流关闭 = run 终止）。
   * ⚠️ daemon 事件缓冲 2000 条且消费者 drain 后即释放（apps/daemon/src/sse.ts）——
   * 迟到的轮询不要依赖回放，用 getRun + getMessages 取最终结果。
   * signal 用于超时控制（AbortSignal.timeout）；AbortError 原样上抛由调用方识别。
   */
  async *runEvents(
    runId: string,
    opts: { afterId?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<SSEEnvelope> {
    const params = opts.afterId && opts.afterId > 0 ? `?after=${opts.afterId}` : '';
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/api/runs/${encodeURIComponent(runId)}/events${params}`,
        { headers: { Accept: 'text/event-stream' }, signal: opts.signal },
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new DaemonError(
        'DAEMON_UNREACHABLE',
        `无法连接 ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) throw await this.toDaemonError(res, `/api/runs/${runId}/events`);
    if (!res.body) throw new DaemonError('HTTP_ERROR', 'SSE 响应无 body');
    yield* parseSseStream(res.body);
  }
}

/** run 是否处于终态。 */
export function isTerminalStatus(status: RunInfo['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

/**
 * 回合是否已完成（答案已落库）—— multiTurn agent（如 Claude Code）的完成信号。
 *
 * 为什么不能只看 isTerminalStatus：multiTurn agent 在 turn_end 后**不退出进程**
 * （RunManager.maybeCloseStdin 的 `if (def?.multiTurn) return`），run 会一直停在
 * 'running' 直到 30min TTL，永远不自然进入 'succeeded'。daemon 在 turn_end 时把
 * stopReason 写进 RunInfo.lastStopReason（RunManager:637），并以此刻为「回合完成、
 * assistant 消息已 flush 落库」的权威信号（与 RunManager:1237 的 flush 条件一致）。
 * 'tool_use' 是回合内的中间步（模型还要调工具），不算完成。
 *
 * 用真值判断而非 `!= null`：lastStopReason 来自 HTTP JSON，字段缺失时运行时为
 * undefined（契约类型 `string | null` 不含它，但 `!== null` 会把 undefined 误判成
 * 已完成）。`!!x` 对 null/undefined/'' 一律 false，只有真实非空 stopReason 才算数。
 */
export function turnCompleted(run: RunInfo): boolean {
  return !!run.lastStopReason && run.lastStopReason !== 'tool_use';
}

/** 取会话最后一条 assistant 消息内容（异步 ask 的稳健取答路径）。 */
export function lastAssistantText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && m.content) return m.content;
  }
  return null;
}
