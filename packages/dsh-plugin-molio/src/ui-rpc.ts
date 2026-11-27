import type { Context } from '@deepseek-ai/cordis';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DaemonClient } from './daemon-client.js';

interface ConnectionRoutes {
  fetch: { register(route: {
    path: string; methods: string[]; requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): void };
}

export function registerInterface(ctx: Context, endpoint: () => Promise<string>) {
  ctx.inject(['connection' as never, 'webServer' as never], scope => {
    const connection = scope.get('connection' as never) as unknown as ConnectionRoutes;
    connection.fetch.register({ path: '/api/molio', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
      try {
        const { method, payload = {} } = await request.json() as { method?: string; payload?: Record<string, unknown> };
        const signal = request.signal;
        const origin = await endpoint();
        if (method === 'endpoint') return Response.json({ value: origin });
        const client = new DaemonClient(origin);
        const vaults = await client.listVaults(signal);
        const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
        const containing = cwd && vaults.filter(v => {
          const rel = relative(v.path, cwd);
          return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
        }).sort((a, b) => b.path.length - a.path.length)[0];
        if (method === 'targets') return Response.json({ value: { vaults, inferred: containing && containing.id } });
        if (method !== 'resolve') throw new Error('未知操作');
        const vault = typeof payload.vaultId === 'string' ? vaults.find(v => v.id === payload.vaultId) : containing;
        if (!vault) throw new Error('请先在文件入库菜单中选择知识库');
        if (typeof payload.page !== 'string' || !payload.page.trim()) throw new Error('缺少笔记名称');
        const page = payload.page.split('/').map(encodeURIComponent).join('/');
        const res = await fetch(origin + '/api/knowledge/vaults/' + encodeURIComponent(vault.id) + '/resolve/' + page, { signal });
        if (!res.ok) throw new Error('找不到笔记：' + payload.page);
        const { path } = await res.json() as { path: string };
        return Response.json({ value: join(vault.path, path) });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    } });
  });
}
