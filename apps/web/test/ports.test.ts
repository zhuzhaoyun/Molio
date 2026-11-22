import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  classifyPort,
  parseExplicitPort,
  isListening,
  probeHealth,
  probeService,
  findFreePort,
  resolveE2ePorts,
} from '../e2e/helpers/ports.ts';

const ENV_KEYS = [
  'MOLIO_E2E_WEB_PORT',
  'MOLIO_E2E_DAEMON_PORT',
  'MOLIO_E2E_CLOUD_PORT',
  'MOLIO_E2E_MOCK_OSS_PORT',
  'MOLIO_E2E_PORTS_RESOLVED',
] as const;

function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/** 注入式依赖：只把 occupied 里的端口当作被占用，探针恒失败。 */
function fakeDeps(occupied: number[] = []) {
  const set = new Set(occupied);
  return {
    isListening: async (p: number) => set.has(p),
    probe: async () => false,
  };
}

describe('classifyPort（端口决策表）', () => {
  it('env 显式指定 → explicit（原样使用）', () => {
    assert.equal(classifyPort({ envOverride: '4100', listening: true }), 'explicit');
    assert.equal(classifyPort({ envOverride: '4100', listening: false }), 'explicit');
  });

  it('默认端口空闲 → start', () => {
    assert.equal(classifyPort({ listening: false }), 'start');
  });

  it('默认端口被占用且未开启复用 → shift（跨 checkout 盲区：签名一致也不复用）', () => {
    assert.equal(classifyPort({ listening: true }), 'shift');
    assert.equal(classifyPort({ listening: true, healthy: true }), 'shift');
  });

  it('显式开启复用且探针命中 → reuse', () => {
    assert.equal(classifyPort({ listening: true, healthy: true, reuse: true }), 'reuse');
  });

  it('开启复用但探针未命中（无关应用）→ 仍 shift', () => {
    assert.equal(classifyPort({ listening: true, healthy: false, reuse: true }), 'shift');
  });
});

describe('parseExplicitPort（显式端口校验）', () => {
  it('合法整数原样返回，允许首尾空白', () => {
    assert.equal(parseExplicitPort('4100', 'X_PORT'), 4100);
    assert.equal(parseExplicitPort('  4100 ', 'X_PORT'), 4100);
  });

  it('非法值抛错并点名 env', () => {
    for (const bad of ['', '   ', 'abc', '0', '-1', '65536', '3100.5', 'NaN']) {
      assert.throws(() => parseExplicitPort(bad, 'X_PORT'), /X_PORT/);
    }
  });
});

describe('resolveE2ePorts', () => {
  it('四个端口都由 env 指定时原样使用并写回 process.env', async () => {
    const saved = saveEnv();
    clearEnv();
    const chosen = { web: '48101', daemon: '48102', cloud: '48103', mockOss: '48104' };
    try {
      process.env.MOLIO_E2E_WEB_PORT = chosen.web;
      process.env.MOLIO_E2E_DAEMON_PORT = chosen.daemon;
      process.env.MOLIO_E2E_CLOUD_PORT = chosen.cloud;
      process.env.MOLIO_E2E_MOCK_OSS_PORT = chosen.mockOss;

      const ports = await resolveE2ePorts({ quiet: true });

      assert.deepEqual(
        { web: String(ports.web), daemon: String(ports.daemon), cloud: String(ports.cloud), mockOss: String(ports.mockOss) },
        chosen,
      );
      assert.equal(ports.decisions.web.mode, 'explicit');
      assert.equal(ports.decisions.daemon.mode, 'explicit');
      assert.equal(ports.decisions.cloud.mode, 'explicit');
      assert.equal(ports.decisions.mockOss.mode, 'explicit');
    } finally {
      restoreEnv(saved);
    }
  });

  /* 回归（2026-11-22）：显式端口曾被无条件判为 explicit，即使开了复用也
     不会打开 reuseExistingServer——用户按警告指引“显式端口 + REUSE=1 复用
     已有服务”时会撞上 already used。 */
  it('显式端口 + 复用开启 + 探针命中 → mode 为 reuse', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      process.env.MOLIO_E2E_WEB_PORT = '48301';
      const ports = await resolveE2ePorts({
        quiet: true,
        reuse: true,
        deps: {
          isListening: async (p: number) => p === 48301,
          probe: async (p: number) => p === 48301,
        },
      });
      assert.equal(ports.web, 48301);
      assert.equal(ports.decisions.web.mode, 'reuse');
    } finally {
      restoreEnv(saved);
    }
  });

  it('显式端口 + 复用开启但探针未命中 → 仍 explicit（不静默复用无关服务）', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      process.env.MOLIO_E2E_WEB_PORT = '48302';
      const ports = await resolveE2ePorts({
        quiet: true,
        reuse: true,
        deps: {
          isListening: async (p: number) => p === 48302,
          probe: async () => false,
        },
      });
      assert.equal(ports.web, 48302);
      assert.equal(ports.decisions.web.mode, 'explicit');
    } finally {
      restoreEnv(saved);
    }
  });

  /* 回归（2026-11-18）：旧实现四个服务并行扫描且不预留端口，mock-oss 从 3200
     起扫时会选中 cloud 的默认端口 3201（3200 被占时），整轮 E2E 起不来。 */
  it('平移不会选中其它服务的默认端口：mock-oss 跳过 cloud 的 3201', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      const ports = await resolveE2ePorts({ quiet: true, deps: fakeDeps([3199, 3200]) });
      assert.equal(ports.cloud, 3201);
      assert.equal(ports.mockOss, 3202);
      assert.notEqual(ports.mockOss, ports.cloud);
    } finally {
      restoreEnv(saved);
    }
  });

  it('两个服务同时需要平移时不会拿到同一个端口', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      const ports = await resolveE2ePorts({ quiet: true, deps: fakeDeps([3199, 3200, 3201]) });
      const all = [ports.web, ports.daemon, ports.cloud, ports.mockOss];
      assert.equal(new Set(all).size, all.length, `端口重复：${all.join(',')}`);
      assert.equal(ports.cloud, 3202);
      assert.equal(ports.mockOss, 3203);
    } finally {
      restoreEnv(saved);
    }
  });

  it('显式端口与其它服务的默认端口相同 → 解析期报错', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      process.env.MOLIO_E2E_WEB_PORT = '3100';
      await assert.rejects(
        () => resolveE2ePorts({ quiet: true, deps: fakeDeps() }),
        /默认端口/,
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('两个 env 指定同一个端口 → 解析期报错', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      process.env.MOLIO_E2E_WEB_PORT = '48201';
      process.env.MOLIO_E2E_DAEMON_PORT = '48201';
      await assert.rejects(
        () => resolveE2ePorts({ quiet: true, deps: fakeDeps() }),
        /同一个端口/,
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('只有空白的 env 按未设置处理（不当作显式端口）', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      process.env.MOLIO_E2E_WEB_PORT = '   ';
      const ports = await resolveE2ePorts({ quiet: true, deps: fakeDeps() });
      assert.notEqual(ports.decisions.web.mode, 'explicit');
      assert.equal(ports.web, 5173);
    } finally {
      restoreEnv(saved);
    }
  });

  it('空白 env 的服务仍按默认端口参与冲突检查', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      process.env.MOLIO_E2E_WEB_PORT = '3100';
      process.env.MOLIO_E2E_DAEMON_PORT = '   ';
      await assert.rejects(
        () => resolveE2ePorts({ quiet: true, deps: fakeDeps() }),
        /默认端口/,
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('非法显式端口在解析期报错并点名 env', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      for (const bad of ['abc', '0', '65536', '3100.5']) {
        clearEnv();
        process.env.MOLIO_E2E_WEB_PORT = bad;
        await assert.rejects(
          () => resolveE2ePorts({ quiet: true, deps: fakeDeps() }),
          /MOLIO_E2E_WEB_PORT/,
        );
      }
    } finally {
      restoreEnv(saved);
    }
  });

  /* worker 二次求值：端口已写回 env，必须原样复用，且不能再探测——此时端口上
     就是主进程刚拉起的服务，探测只会得到「被占用」的假警告。 */
  it('二次求值幂等：不再探测，全部 explicit 且端口不变', async () => {
    const saved = saveEnv();
    clearEnv();
    try {
      let calls = 0;
      const deps = {
        isListening: async (p: number) => { calls++; return p === 3100; },
        probe: async () => false,
      };
      const first = await resolveE2ePorts({ quiet: true, deps });
      assert.equal(first.decisions.daemon.mode, 'shift');

      calls = 0;
      const second = await resolveE2ePorts({ quiet: true, deps });
      assert.equal(calls, 0, '二次求值不应再探测端口');
      assert.equal(second.daemon, first.daemon);
      for (const k of ['web', 'daemon', 'cloud', 'mockOss'] as const) {
        assert.equal(second.decisions[k].mode, 'explicit', `${k} 二次求值应为 explicit`);
        assert.equal(second.decisions[k].port, first.decisions[k].port);
      }
    } finally {
      restoreEnv(saved);
    }
  });
});

describe('isListening / findFreePort（真实端口 IO）', () => {
  const server = createServer();
  let port = 0;

  after(() => server.close());

  it('空闲端口不报监听，被占用端口报监听', async () => {
    port = await findFreePort(45300);
    assert.equal(await isListening(port), false);
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    assert.equal(await isListening(port), true);
  });

  it('findFreePort 跳过被占用的端口', async () => {
    assert.ok(port > 0);
    const next = await findFreePort(port);
    assert.ok(next > port);
    assert.equal(await isListening(next), false);
  });

  it('findFreePort 跳过预留端口', async () => {
    const base = await findFreePort(45800);
    const next = await findFreePort(base, { reserved: new Set([base]) });
    assert.ok(next > base);
    assert.equal(await isListening(next), false);
  });

  /* 回归（2026-11-17）：Windows 上服务可能只绑 IPv6 回环。只查 127.0.0.1
     会漏判，Playwright 随后按 localhost 判定「already used」直接失败。 */
  it('只监听 IPv6 回环（::1）也算占用，健康探针也能命中', async (t) => {
    const v6 = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('molio-mock-oss');
    });
    const v6Port = await findFreePort(45700);
    const bound = await new Promise<boolean>((resolve) => {
      v6.once('error', () => resolve(false));
      v6.listen(v6Port, '::1', () => resolve(true));
    });
    if (!bound) {
      t.skip('本机不支持 IPv6 回环');
      return;
    }
    try {
      assert.equal(await isListening(v6Port), true);
      assert.equal(await probeService(v6Port, '/__health', 'molio-mock-oss'), true);
    } finally {
      v6.close();
    }
  });
});

describe('probeHealth（响应特征子串判定）', () => {
  const ours = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  const foreign = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>其他应用</html>');
  });
  let oursPort = 0;
  let foreignPort = 0;

  after(() => { ours.close(); foreign.close(); });

  it('特征子串命中才算健康', async () => {
    oursPort = await findFreePort(45400);
    foreignPort = await findFreePort(45500);
    await new Promise<void>((r) => ours.listen(oursPort, '127.0.0.1', r));
    await new Promise<void>((r) => foreign.listen(foreignPort, '127.0.0.1', r));

    assert.equal(await probeHealth(`http://localhost:${oursPort}/api/health`, '"status"'), true);
    // 无关服务：有响应但特征不符 → 判为占用，触发平移
    assert.equal(await probeHealth(`http://localhost:${foreignPort}/api/health`, '"status"'), false);
    // 完全无监听 → false
    const dead = await findFreePort(45600);
    assert.equal(await probeHealth(`http://localhost:${dead}/api/health`, '"status"'), false);
  });
});
