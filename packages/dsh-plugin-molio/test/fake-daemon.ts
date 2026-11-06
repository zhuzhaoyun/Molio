/**
 * 假 daemon — node:http 实现的最小 Molio daemon（只读端点子集），供 dsh 插件
 * 测试驱动完整 HTTP 行为（而非 mock 返回值）。参考 apps/cli/test/fake-daemon.ts，
 * 只保留本插件用到的端点：health / vaults / active-vault / tree / files / search，
 * 支持数据编排、延迟注入与 404/413 错误语义。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FileContent, SearchResponse, TreeNode, Vault } from '@molio/contracts';

export type FakeFileEntry = FileContent & {
  /** true → 端点直接回 413（daemon refuse 档），而非 200+tooLarge 降级档 */
  refuse413?: boolean;
};

export class FakeDaemon {
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
    [
      'v1:big/huge.md',
      {
        path: 'big/huge.md',
        content: '',
        size: 99_999_999,
        modifiedAt: 100,
        mimeType: 'text/markdown',
        tooLarge: true,
      },
    ],
    [
      'v1:big/refuse.md',
      {
        path: 'big/refuse.md',
        content: '',
        size: 99_999_999,
        modifiedAt: 100,
        mimeType: 'text/markdown',
        refuse413: true,
      },
    ],
  ]);
  searchResponse: SearchResponse = {
    results: [{ filePath: 'notes/a.md', fileName: 'a.md', snippet: '…内容正文…' }],
    truncated: false,
  };
  health = { status: 'ok', version: '0.1.0-test', activeRuns: 0, uptime: 42 };
  /** 每个响应前的注入延迟 */
  delayMs = 0;

  private server: Server | null = null;
  baseUrl = '';

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      const send = (code: number, body: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const afterDelay = (fn: () => void): void => {
        if (this.delayMs > 0) setTimeout(fn, this.delayMs);
        else fn();
      };
      afterDelay(() => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = decodeURIComponent(url.pathname);

        if (path === '/api/health') return send(200, this.health);

        if (path === '/api/knowledge/vaults') return send(200, { vaults: this.vaults });

        if (path === '/api/knowledge/active-vault') {
          const vault = this.vaults.find((v) => v.id === this.activeVaultId) ?? null;
          return send(200, { vaultId: this.activeVaultId, vault });
        }

        const treeMatch = /^\/api\/knowledge\/vaults\/([^/]+)\/tree$/.exec(path);
        if (treeMatch) {
          const vaultId = treeMatch[1]!;
          if (!this.vaults.some((v) => v.id === vaultId)) {
            return send(404, { error: { code: 'NOT_FOUND', message: `vault 不存在: ${vaultId}` } });
          }
          return send(200, { tree: this.tree });
        }

        const fileMatch = /^\/api\/knowledge\/vaults\/([^/]+)\/files\/(.+)$/.exec(path);
        if (fileMatch) {
          const key = `${fileMatch[1]}:${fileMatch[2]}`;
          const entry = this.files.get(key);
          if (!entry) {
            return send(404, {
              error: { code: 'NOT_FOUND', message: `文件不存在: ${fileMatch[2]}` },
            });
          }
          const force = url.searchParams.get('force') === '1';
          if (entry.refuse413 && !force) {
            return send(413, {
              error: { code: 'FILE_TOO_LARGE', message: `文件过大（${entry.size} 字节）` },
            });
          }
          const { refuse413: _drop, ...file } = entry;
          if (force && file.tooLarge) {
            // 真实 daemon 的 force 语义：强制读取返回完整内容，不再带 tooLarge 标记
            const { tooLarge: _tooLarge, ...forced } = file;
            return send(200, { ...forced, content: '（强制读取的超大内容）' });
          }
          return send(200, file);
        }

        const searchMatch = /^\/api\/knowledge\/vaults\/([^/]+)\/search$/.exec(path);
        if (searchMatch) {
          if (!this.vaults.some((v) => v.id === searchMatch[1])) {
            return send(404, { error: { code: 'NOT_FOUND', message: 'vault 不存在' } });
          }
          return send(200, this.searchResponse);
        }

        return send(404, { error: { code: 'NOT_FOUND', message: `未知端点: ${path}` } });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    const addr = server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
