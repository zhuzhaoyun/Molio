/**
 * 假 daemon — node:http 实现的最小 Molio daemon，供 CLI/MCP 测试驱动完整
 * HTTP 行为（而非 mock 返回值）：
 * - 全部只读端点 canned 响应，数据可编排（vaults/files/search/agents）
 * - runs：POST 创建（可脚本化事件序列 + 终态）、GET 状态、SSE 事件流
 *   （真实帧格式 id:/data:、ping keepalive、终态关流、可模拟中途断连）
 * - conversations messages：异步取答路径
 * - 延迟注入（delayMs）与 404/413 错误语义
 */
import { EventEmitter } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AgentEvent,
  AgentInfo,
  ChatMessage,
  CreateRunRequest,
  FileContent,
  RunInfo,
  RunStatus,
  SSEEnvelope,
  SearchResponse,
  TreeNode,
  Vault,
} from '@molio/contracts';

export type FakeFileEntry = FileContent & {
  /** true → 端点直接回 413（daemon refuse 档），而非 200+tooLarge 降级档 */
  refuse413?: boolean;
};

export interface RunScript {
  /** SSE 订阅后按序回放的事件（回放完自动进入 finalStatus 关流） */
  events?: AgentEvent[];
  /** 事件回放间隔（默认 0 = 一次性写出） */
  eventIntervalMs?: number;
  /** 回放完成后自动设置的终态；不设 = run 保持 pending、流不关（超时/断连用例） */
  finalStatus?: RunStatus;
  finalError?: string | null;
  /** 创建 run 时灌入其 conversation 的消息（pollAsk/回退取答用） */
  conversationMessages?: ChatMessage[];
  /**
   * 多轮 agent（如 Claude Code）模式：回放完 events 后发 turn_end 并置 lastStopReason，
   * 但 run **仍停在 'running'、SSE 流不关**（真实 daemon 对 multiTurn 的行为——进程不
   * 退出等后续消息，直到 30min TTL）。用于验证 CLI 以 turn_end 而非终态/EOF 作完成信号。
   * 与 finalStatus 互斥（multiTurn 优先，不进入终态）。
   */
  multiTurn?: boolean;
  /** multiTurn 模式下 turn_end 的 stopReason（默认 'end_turn'） */
  stopReason?: string;
}

export interface FakeRun {
  info: RunInfo;
  envelopes: SSEEnvelope[];
  script: RunScript;
  subscribers: Set<ServerResponse>;
  nextSeq: number;
  autoFinished: boolean;
  hadSubscriber: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeDaemon extends EventEmitter {
  vaults: Vault[] = [
    { id: 'v1', name: '工作库', path: 'D:\\vaults\\work', fileCount: 3, createdAt: 1 },
    { id: 'v2', name: 'Notes', path: '/vaults/notes', fileCount: 1, createdAt: 2 },
  ];
  activeVaultId: string | null = 'v1';
  tree: TreeNode[] = [
    {
      name: 'notes',
      path: 'notes',
      type: 'directory',
      children: [{ name: 'a.md', path: 'notes/a.md', type: 'file', size: 10, modifiedAt: 100 }],
    },
  ];
  /** key = `${vaultId}:${relPath}` */
  files = new Map<string, FakeFileEntry>([
    [
      'v1:notes/a.md',
      {
        path: 'notes/a.md',
        content: '# 标题\n内容正文',
        size: 20,
        modifiedAt: 100,
        mimeType: 'text/markdown',
        encoding: 'utf-8',
      },
    ],
    [
      'v1:img/logo.png',
      { path: 'img/logo.png', content: '', size: 2048, modifiedAt: 100, mimeType: 'image/png' },
    ],
  ]);
  searchResponse: SearchResponse = {
    results: [{ filePath: 'notes/a.md', fileName: 'a.md', snippet: '…内容正文…' }],
    truncated: false,
  };
  agents: AgentInfo[] = [
    { id: 'claude-code', name: 'Claude Code', available: true, models: [], installable: false },
    { id: 'codex', name: 'Codex', available: false, models: [], installable: false },
  ];
  /** key = conversationId */
  messages = new Map<string, ChatMessage[]>();
  runs = new Map<string, FakeRun>();
  /** 下一次 POST /api/runs 使用的脚本（消费后重置为默认） */
  nextRunScript: RunScript = { finalStatus: 'succeeded' };
  /** 每个响应前的注入延迟 */
  delayMs = 0;

  private server: Server | null = null;
  private runCounter = 0;
  baseUrl = '';

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.writableEnded) this.sendJson(res, 500, { error: { message: String(err) } });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.server = server;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const run of this.runs.values()) {
      for (const sub of run.subscribers) sub.socket?.destroy();
      run.subscribers.clear();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  // ─── 编排 API ───

  /** 向 run 推一个 SSE 事件（在线订阅者实时收到；迟到订阅者从缓冲回放）。 */
  emitEvent(runId: string, event: AgentEvent): void {
    const run = this.mustRun(runId);
    // 镜像真实 daemon：turn_end 时把 stopReason 写进 RunInfo.lastStopReason
    // （RunManager:637）——CLI 的 turnCompleted 完成判定依赖它。
    if (event.type === 'turn_end') run.info.lastStopReason = event.stopReason;
    const envelope: SSEEnvelope = { seq: run.nextSeq++, runId, event };
    run.envelopes.push(envelope);
    for (const sub of run.subscribers) sub.write(formatFrame(envelope));
  }

  /**
   * 多轮 agent 回合结束：发 turn_end + 置 lastStopReason，但 run **仍 running、流不关**。
   * 真实 daemon 对 multiTurn agent 的行为（进程不退出等后续消息，直到 TTL/主动 cancel）。
   */
  completeTurn(runId: string, stopReason = 'end_turn'): void {
    const run = this.mustRun(runId);
    if (run.info.status === 'pending') run.info.status = 'running';
    this.emitEvent(runId, { type: 'turn_end', stopReason }); // emitEvent 内置 lastStopReason
  }

  /**
   * 置终态、发 status 事件（succeeded→completed，对齐 RunManager:1329）并关闭全部订阅流。
   * 注：真实 daemon 终止时**不关在线流**，但 fake 关流以简化 EOF 路径测试；CLI 的完成
   * 判定走 turn_end/status 事件而非 EOF，故两种行为都能正确收尾。
   */
  finishRun(runId: string, status: RunStatus, error?: string | null): void {
    const run = this.mustRun(runId);
    run.info.status = status;
    run.info.error = error ?? null;
    const label = status === 'succeeded' ? 'completed' : status;
    this.emitEvent(runId, { type: 'status', label });
    for (const sub of run.subscribers) sub.end();
    run.subscribers.clear();
  }

  /** 模拟 daemon 重启/断连：销毁订阅 socket，但 run 状态不动。 */
  destroyEventStreams(runId: string): void {
    const run = this.mustRun(runId);
    for (const sub of run.subscribers) sub.socket?.destroy();
    run.subscribers.clear();
  }

  /** 模拟异常情形：流被正常关闭（end）但 run 仍非终态。 */
  endEventStreams(runId: string): void {
    const run = this.mustRun(runId);
    for (const sub of run.subscribers) sub.end();
    run.subscribers.clear();
  }

  /** 等待某 run 出现首个 SSE 订阅者（编排「先订阅后推事件」的时序）。 */
  waitForSubscriber(runId: string): Promise<void> {
    const run = this.mustRun(runId);
    if (run.hadSubscriber) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onSubscribed = (id: string): void => {
        if (id === runId) {
          this.off('subscribed', onSubscribed);
          resolve();
        }
      };
      this.on('subscribed', onSubscribed);
    });
  }

  private mustRun(runId: string): FakeRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`fake daemon: run 不存在 ${runId}`);
    return run;
  }

  // ─── HTTP 路由 ───

  private async handle(
    req: import('node:http').IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (this.delayMs > 0) await sleep(this.delayMs);
    const url = new URL(req.url ?? '/', 'http://fake');
    const p = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && p === '/api/health') {
      this.sendJson(res, 200, {
        status: 'ok',
        version: '0.0.0-fake',
        activeRuns: this.runs.size,
        uptime: 42,
      });
      return;
    }
    if (method === 'GET' && p === '/api/agents') {
      this.sendJson(res, 200, { agents: this.agents });
      return;
    }
    if (method === 'GET' && p === '/api/knowledge/vaults') {
      this.sendJson(res, 200, { vaults: this.vaults });
      return;
    }
    if (method === 'GET' && p === '/api/knowledge/active-vault') {
      const vault = this.vaults.find((v) => v.id === this.activeVaultId) ?? null;
      this.sendJson(res, 200, { vaultId: this.activeVaultId, vault });
      return;
    }

    let m = /^\/api\/knowledge\/vaults\/([^/]+)\/tree$/.exec(p);
    if (method === 'GET' && m) {
      const vaultId = decodeURIComponent(m[1]!);
      if (!this.vaults.some((v) => v.id === vaultId)) return this.notFound(res, 'vault 不存在');
      this.sendJson(res, 200, { tree: this.tree });
      return;
    }

    m = /^\/api\/knowledge\/vaults\/([^/]+)\/files\/(.+)$/.exec(p);
    if (method === 'GET' && m) {
      this.lastFilesUrl = req.url ?? null; // 断言 force=1 透传与整段编码
      const vaultId = decodeURIComponent(m[1]!);
      const relPath = decodeURIComponent(m[2]!);
      const entry = this.files.get(`${vaultId}:${relPath}`);
      if (!entry) return this.notFound(res, `文件不存在: ${relPath}`);
      if (entry.refuse413) {
        this.sendJson(
          res,
          413,
          { error: { code: 'FILE_TOO_LARGE', message: `文件过大（${entry.size} 字节）` } },
        );
        return;
      }
      const { refuse413: _drop, ...file } = entry;
      this.sendJson(res, 200, file);
      return;
    }

    m = /^\/api\/knowledge\/vaults\/([^/]+)\/search$/.exec(p);
    if (method === 'GET' && m) {
      // 记录收到的查询参数供断言（q 编码、limit 透传）
      this.lastSearchQuery = { q: url.searchParams.get('q'), limit: url.searchParams.get('limit') };
      this.sendJson(res, 200, this.searchResponse);
      return;
    }

    if (method === 'POST' && p === '/api/runs') {
      const body = (await readBody(req)) as CreateRunRequest;
      this.lastCreateRunRequest = body;
      const runId = `run-${++this.runCounter}`;
      const conversationId = `conv-${this.runCounter}`;
      const script = this.nextRunScript;
      this.nextRunScript = { finalStatus: 'succeeded' };
      if (script.conversationMessages) {
        this.messages.set(conversationId, script.conversationMessages);
      }
      const run: FakeRun = {
        info: {
          id: runId,
          agentId: body.agentId,
          status: 'pending',
          createdAt: Date.now(),
          lastStopReason: null,
          error: null,
          conversationId,
        },
        envelopes: [],
        script,
        subscribers: new Set(),
        nextSeq: 1,
        autoFinished: false,
        hadSubscriber: false,
      };
      this.runs.set(runId, run);
      this.sendJson(res, 201, { runId, conversationId });
      return;
    }

    m = /^\/api\/runs\/([^/]+)$/.exec(p);
    if (method === 'GET' && m) {
      const run = this.runs.get(decodeURIComponent(m[1]!));
      if (!run) return this.notFound(res, 'run 不存在');
      this.sendJson(res, 200, run.info);
      return;
    }
    if (method === 'DELETE' && m) {
      // 取消 run（真实 daemon DELETE /api/runs/:id → 204；已终态则 no-op）
      const runId = decodeURIComponent(m[1]!);
      this.lastCancelRunId = runId;
      const run = this.runs.get(runId);
      if (!run) {
        res.writeHead(404).end();
        return;
      }
      if (run.info.status !== 'succeeded' && run.info.status !== 'failed' && run.info.status !== 'canceled') {
        run.info.status = 'canceled';
        this.emitEvent(runId, { type: 'status', label: 'canceled' });
      }
      for (const sub of run.subscribers) sub.end();
      run.subscribers.clear();
      res.writeHead(204).end();
      return;
    }

    m = /^\/api\/runs\/([^/]+)\/events$/.exec(p);
    if (method === 'GET' && m) {
      const run = this.runs.get(decodeURIComponent(m[1]!));
      if (!run) return this.notFound(res, 'run 不存在');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: ping\n\n'); // keepalive 帧：客户端必须跳过
      run.hadSubscriber = true;
      this.emit('subscribed', run.info.id);
      // 回放已有缓冲（真实 daemon 同样回放未 drain 的事件）
      for (const envelope of run.envelopes) res.write(formatFrame(envelope));
      if (run.autoFinished) {
        res.end(); // 已终态：立即关流
        return;
      }
      run.subscribers.add(res);
      req.on('close', () => run.subscribers.delete(res));
      // 脚本化 run：异步回放脚本事件后进入终态关流
      void this.playScript(run);
      return;
    }

    m = /^\/api\/conversations\/([^/]+)\/messages$/.exec(p);
    if (method === 'GET' && m) {
      const conversationId = decodeURIComponent(m[1]!);
      this.sendJson(res, 200, { messages: this.messages.get(conversationId) ?? [] });
      return;
    }

    this.notFound(res, `fake daemon 未实现 ${method} ${p}`);
  }

  private async playScript(run: FakeRun): Promise<void> {
    const events = run.script.events ?? [];
    const multiTurn = run.script.multiTurn ?? false;
    if (events.length === 0 && !run.script.finalStatus && !multiTurn) return;
    run.info.status = 'running'; // 真实 daemon 启动即 running
    for (const event of events) {
      if (run.script.eventIntervalMs) await sleep(run.script.eventIntervalMs);
      this.emitEvent(run.info.id, event);
    }
    if (run.script.eventIntervalMs) await sleep(run.script.eventIntervalMs);
    if (multiTurn) {
      // 回合结束但 run 不终态、流不关（等 CLI 主动 cancel）
      this.completeTurn(run.info.id, run.script.stopReason ?? 'end_turn');
      return;
    }
    if (run.script.finalStatus && !run.autoFinished) {
      run.autoFinished = true;
      this.finishRun(run.info.id, run.script.finalStatus, run.script.finalError);
    }
  }

  /** 最近一次 search 收到的查询参数（断言编码/透传用）。 */
  lastSearchQuery: { q: string | null; limit: string | null } | null = null;
  /** 最近一次 files 请求的原始 URL（断言整段编码与 force=1 透传）。 */
  lastFilesUrl: string | null = null;
  /** 最近一次 POST /api/runs 的请求体（断言 cwd=vault.path 等）。 */
  lastCreateRunRequest: CreateRunRequest | null = null;
  /** 最近一次 DELETE /api/runs/:id 取消的 runId（断言 multiTurn 收尾主动 cancel）。 */
  lastCancelRunId: string | null = null;

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(payload);
  }

  private notFound(res: ServerResponse, message: string): void {
    this.sendJson(res, 404, { error: { code: 'NOT_FOUND', message } });
  }
}

function formatFrame(envelope: SSEEnvelope): string {
  return `id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
