import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { graphRoutes, makeGraphWarmer } from '../../src/routes/graph.js';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import type { GraphData } from '@molio/contracts';

/**
 * H3 Task 4：路由投递 + 预热。
 *
 * GET /:vaultId 在 worker 预跑完成后携带 positions（覆盖率 ≥0.8 才附）；
 * 局部图端点永不携带；makeGraphWarmer 每 vault 每进程至多建一次图。
 */

const cleanup: string[] = [];

function makeVault(dirCount: number, perDir: number): string {
  const root = mkdtempSync(join(tmpdir(), 'molio-h3-route-'));
  cleanup.push(root);
  const name = (d: number, i: number) => `d${d}n${String(i).padStart(3, '0')}`;
  for (let d = 0; d < dirCount; d++) mkdirSync(join(root, `dir${d}`), { recursive: true });
  for (let d = 0; d < dirCount; d++)
    for (let i = 0; i < perDir; i++)
      writeFileSync(
        join(root, `dir${d}`, `${name(d, i)}.md`),
        `# ${name(d, i)}\n\n- [[${name(d, (i + 1) % perDir)}]]\n- [[${name((d + 1) % dirCount, i)}]]\n`,
      );
  return root;
}

after(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

describe('GET /api/graph/:vaultId 携带布局种子', () => {
  it('预跑完成后 positions 就位：覆盖全部节点键、三元组形状', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'molio-h3-route-db-'));
    cleanup.push(dataDir);
    const vaultDir = makeVault(3, 12);
    const db = openDatabase(dataDir);
    const vault = createVault(db, 'h3-route', vaultDir);
    const root = new Hono();
    root.route('/api/graph', graphRoutes(db));
    try {
      let body: (GraphData & { positions?: Array<[string, number, number]> }) | null = null;
      const deadline = Date.now() + 15_000;
      for (;;) {
        const res = await root.request(`/api/graph/${vault.id}`);
        assert.equal(res.status, 200);
        const parsed = (await res.json()) as GraphData & { positions?: Array<[string, number, number]> };
        body = parsed;
        if (parsed.positions && parsed.positions.length > 0) break;
        if (Date.now() > deadline) assert.fail('15s 内 positions 未随响应到达');
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(body!.positions);
      assert.equal(body!.positions!.length, body!.nodes.length, '小图应全覆盖');
      const keySet = new Set(body!.nodes.map((n) => n.key));
      for (const [k, x, y] of body!.positions!) {
        assert.ok(keySet.has(k), `未知键 ${k}`);
        assert.ok(Number.isFinite(x) && Number.isFinite(y));
      }
    } finally {
      closeDatabase();
    }
  });

  it('局部图端点不携带 positions（与 communities 同一纪律）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'molio-h3-route-db2-'));
    cleanup.push(dataDir);
    const vaultDir = makeVault(1, 4);
    const db = openDatabase(dataDir);
    const vault = createVault(db, 'h3-route-local', vaultDir);
    const root = new Hono();
    root.route('/api/graph', graphRoutes(db));
    try {
      const res = await root.request(`/api/graph/${vault.id}/local?scope=dir&path=dir0`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.ok(!('positions' in body), '局部响应不得携带 positions');
    } finally {
      closeDatabase();
    }
  });
});

describe('makeGraphWarmer', () => {
  it('每 vault 至多建一次图（幂等）', async () => {
    let builds = 0;
    const stubCache = {
      getOrBuild: async (id: string, fn: () => Promise<GraphData>) => {
        builds++;
        return fn();
      },
    };
    const warm = makeGraphWarmer(stubCache, () => true);
    const dataDir = mkdtempSync(join(tmpdir(), 'molio-h3-warm-db-'));
    cleanup.push(dataDir);
    const vaultDir = makeVault(1, 3);
    const db = openDatabase(dataDir);
    const vault = createVault(db, 'h3-warm', vaultDir);
    try {
      await warm(vault, []);
      await warm(vault, []);
      assert.equal(builds, 1, '第二次 warm 不应再建图');
    } finally {
      closeDatabase();
    }
  });
});
