/**
 * E2E 端口解析：默认端口被占用时自动平移到空闲端口。
 *
 * 背景：本机 5173 / 3100 等默认端口常被占用，占用者可能是无关应用，也可能是
 * 另一个 checkout 的 dev server 或上一次残留的 E2E 服务。开启复用后
 * reuseExistingServer 只看 URL 是否有响应，会把占用者当成自己的服务复用，
 * 整轮 E2E 打到错误的进程上（页面壳正常、数据全错）。
 *
 * 决策表（串行解析，端口统一预留）：
 *   1. 显式 env 覆盖（MOLIO_E2E_*_PORT）→ 校验后原样使用；开启复用且探针命中
 *      → 标记 reuse（config 才会打开 reuseExistingServer）；被占但没开复用 →
 *      只给警告，不改端口（Playwright 启动时会立即报 already used）
 *   2. 默认端口无人监听 → 用默认端口，Playwright 拉起新服务
 *   3. 默认端口有人监听：
 *      a. 显式开启复用（MOLIO_E2E_REUSE_SERVERS=1）且健康探针命中 → 复用
 *      b. 否则 → 在「未被占用且未被其它服务预留」的端口里顺次取一个，拉起全新服务
 *
 * 为什么自动路径默认不复用：健康探针只能证明对面是同一种服务，证明不了它跑的是
 * **本 checkout 的代码**、用的是**本次运行的数据目录**。另一个 checkout 的
 * vite/daemon 健康签名完全一致，复用等于拿旧代码 + 别人的 MOLIO_DATA_DIR 跑
 * 测试。复用只能显式开启，此时数据目录归属由开启者自行负责（见
 * playwright.config.ts 的 MOLIO_E2E_REUSE_SERVERS）。
 *
 * 为什么串行 + 预留：四个服务若各自并行扫描，彼此看不到对方的选择，而扫描区间
 * 存在重叠（mock-oss 从 3200 起扫，cloud 的默认端口 3201 和平移区间都在范围内），
 * 会在多 checkout 场景下选中同一端口、整轮 E2E 起不来。端口分配因此按一次统一
 * 决策处理：默认端口与显式端口先全部占位，每解析出一个再登记。
 */

import { createConnection } from 'node:net';

export type PortMode = 'explicit' | 'start' | 'reuse' | 'shift';

export interface PortDecision {
  port: number;
  /** explicit=env 指定；start=空闲待拉起；reuse=显式开启复用且探针命中；shift=被占用而平移 */
  mode: PortMode;
}

/**
 * 纯决策：给定端口占用情况与复用开关，给出 mode（不含找空闲端口的 IO）。
 * 健康探针只在显式开启复用时参与决策，其余情况只影响警告文案。
 */
export function classifyPort(opts: {
  envOverride?: string;
  listening: boolean;
  healthy?: boolean;
  reuse?: boolean;
}): PortMode {
  /* 空白串按未设置处理，与 resolveE2ePorts 的 trim 口径一致。 */
  if (opts.envOverride?.trim()) return 'explicit';
  if (!opts.listening) return 'start';
  if (opts.reuse && opts.healthy) return 'reuse';
  return 'shift';
}

/**
 * 校验显式指定的端口。非法值（拼写错误、0、越界、小数）在配置求值期直接报错，
 * 避免 NaN / 0 流进 vite、daemon 的 PORT 与 Playwright 的 baseURL——那种失败要等
 * 60 秒 webServer 超时，报错里还看不出是哪个 env。
 */
export function parseExplicitPort(raw: string, envVar: string): number {
  const value = raw.trim();
  const port = Number(value);
  if (value === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `[e2e-ports] ${envVar} 的值 "${raw}" 不是合法端口：需要 1-65535 的整数。`,
    );
  }
  return port;
}

const CONNECT_TIMEOUT_MS = 500;

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

/**
 * 端口是否有进程在监听。IPv4 / IPv6 回环都查：Windows 上服务常只绑 `::1`
 * （本机实测 5173 被只绑 IPv6 的服务占用时，只查 127.0.0.1 会漏判，随后
 * Playwright 按 localhost 判定「already used」直接失败）。
 */
export async function isListening(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([tryConnect('127.0.0.1', port), tryConnect('::1', port)]);
  return v4 || v6;
}

/** 健康探针：GET url，2xx 且响应体含 expect 子串才算「签名匹配的服务」。 */
export async function probeHealth(url: string, expect: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    return (await res.text()).includes(expect);
  } catch {
    return false;
  }
}

/* 探针要同时试 IPv4 与 IPv6 回环：占用者只绑 ::1 时，只探 localhost 可能解析到
   127.0.0.1 而失败，把同类实例误报成「其他应用」。三路并行，最坏 1.5 秒。 */
const PROBE_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

export async function probeService(port: number, path: string, expect: string): Promise<boolean> {
  const results = await Promise.all(
    PROBE_HOSTS.map((host) => probeHealth(`http://${host}:${port}${path}`, expect)),
  );
  return results.some(Boolean);
}

export interface FindFreePortOptions {
  /** 已被其它服务占用/预留的端口，跳过。 */
  reserved?: ReadonlySet<number>;
  /** 报错时点名的服务名。 */
  label?: string;
  /** 报错时给出的显式指定方式。 */
  envVar?: string;
  isListening?: (port: number) => Promise<boolean>;
}

/** 从 start 起顺次找第一个既无监听、也不在预留集合里的端口（最多扫 50 个）。 */
export async function findFreePort(
  start: number,
  opts: FindFreePortOptions = {},
): Promise<number> {
  const { reserved = new Set<number>(), label = '端口', envVar, isListening: probe = isListening } = opts;
  const end = start + 50;
  for (let p = start; p < end; p++) {
    if (reserved.has(p)) continue;
    if (!(await probe(p))) return p;
  }
  throw new Error(
    `[e2e-ports] ${label}：:${start}-:${end - 1} 内没有可用端口（均被占用或已预留）` +
    (envVar ? `。可显式指定：${envVar}=<port>` : '。'),
  );
}

interface ServiceSpec {
  name: string;
  defaultPort: number;
  envVar: string;
  /** 健康探针路径与响应特征子串 */
  probe: { path: string; expect: string };
}

export interface PortResolveDeps {
  isListening: (port: number) => Promise<boolean>;
  probe: (port: number, path: string, expect: string) => Promise<boolean>;
}

const DEFAULT_DEPS: PortResolveDeps = { isListening, probe: probeService };

export interface ResolveOptions {
  /** 显式开启复用（MOLIO_E2E_REUSE_SERVERS=1）：默认端口探针命中时保留并标记 reuse。 */
  reuse?: boolean;
  /** 单测用：关闭日志。 */
  quiet?: boolean;
  /** 单测用：注入探测实现。 */
  deps?: Partial<PortResolveDeps>;
}

/** 首次求值后置位；worker 二次求值据此跳过探测与日志（见 resolveE2ePorts）。 */
const RESOLVED_MARKER = 'MOLIO_E2E_PORTS_RESOLVED';

interface ResolveContext {
  reuse: boolean;
  reserved: Set<number>;
  deps: PortResolveDeps;
  warn: (msg: string) => void;
  /** 本次是 worker 的二次求值（端口已由主进程定好并写回 env）。 */
  alreadyResolved: boolean;
}

async function resolveOne(spec: ServiceSpec, ctx: ResolveContext): Promise<PortDecision> {
  const raw = process.env[spec.envVar]?.trim();
  if (raw) {
    const port = parseExplicitPort(raw, spec.envVar);
    /* 显式指定即信任用户，绝不擅自改端口。二次求值时端口就是我们自己刚起的
       服务，探测只会得到「被自己占用」的假结果，直接跳过。 */
    const listening = !ctx.alreadyResolved && (await ctx.deps.isListening(port));
    if (ctx.reuse && listening) {
      /* 复用开启 + 显式指向已有服务：探针命中才算合法复用，标记 reuse 让
         playwright.config 打开 reuseExistingServer。探针未命中说明占用者是
         无关应用，保持 explicit——Playwright 立即报 already used，而不是把
         别人的服务静默当成自己的。 */
      const healthy = await ctx.deps.probe(port, spec.probe.path, spec.probe.expect);
      if (healthy) {
        if (!ctx.alreadyResolved) {
          ctx.warn(
            `[e2e-ports] ${spec.name} 复用显式端口 :${port}（${spec.envVar}，` +
            `MOLIO_E2E_REUSE_SERVERS=1）：数据目录与代码版本都以那个实例为准。`,
          );
        }
        return { port, mode: 'reuse' };
      }
      ctx.warn(
        `[e2e-ports] ${spec.name} 显式端口 :${port}（${spec.envVar}）已被占用，` +
        `但健康探针未命中：那是无关应用，Playwright 启动时立即报 already used 失败。` +
        `请换一个端口。`,
      );
      return { port, mode: 'explicit' };
    }
    if (!ctx.reuse && listening) {
      ctx.warn(
        `[e2e-ports] ${spec.name} 显式端口 :${port}（${spec.envVar}）已被占用：` +
        `Playwright 启动时会立即报 already used 失败。若端口上是你自己的服务，设 ` +
        `MOLIO_E2E_REUSE_SERVERS=1 后可直接复用；否则请换一个端口。`,
      );
    }
    return { port, mode: 'explicit' };
  }

  const listening = await ctx.deps.isListening(spec.defaultPort);
  const healthy = listening && ctx.reuse
    ? await ctx.deps.probe(spec.defaultPort, spec.probe.path, spec.probe.expect)
    : false;
  const mode = classifyPort({ listening, healthy, reuse: ctx.reuse });
  if (mode === 'start') return { port: spec.defaultPort, mode };
  if (mode === 'reuse') {
    if (!ctx.alreadyResolved) {
      ctx.warn(
        `[e2e-ports] ${spec.name} 复用默认端口 :${spec.defaultPort}` +
        `（MOLIO_E2E_REUSE_SERVERS=1）：数据目录与代码版本都以那个实例为准。`,
      );
    }
    return { port: spec.defaultPort, mode };
  }

  /* 已占用且不复用：探一下占用者是不是「同类 Molio 服务」，只为把警告说准。 */
  const sameKind = await ctx.deps.probe(spec.defaultPort, spec.probe.path, spec.probe.expect);
  const port = await findFreePort(spec.defaultPort + 1, {
    reserved: ctx.reserved,
    label: spec.name,
    envVar: spec.envVar,
    isListening: ctx.deps.isListening,
  });
  ctx.warn(
    `[e2e-ports] ${spec.name} 默认端口 :${spec.defaultPort} ${sameKind
      ? '已被另一个 Molio 实例占用（可能是别的 checkout 或手动 pnpm dev 起的服务），'
      : '被其他应用占用，'}自动平移到 :${port}，并在该端口拉起全新服务。` +
    `如需指定端口：${spec.envVar}=<port>`,
  );
  return { port, mode };
}

export interface E2EPorts {
  web: number;
  daemon: number;
  cloud: number;
  mockOss: number;
  decisions: Record<'web' | 'daemon' | 'cloud' | 'mockOss', PortDecision>;
}

type ServiceKey = keyof E2EPorts['decisions'];

/**
 * 解析全部 E2E 服务端口。串行执行并预留已选端口，确保四个结果两两不同。
 * 副作用：把 MOLIO_E2E_*_PORT 写回 process.env，让 spec 进程（读
 * MOLIO_E2E_DAEMON_PORT 等）与 worker 的二次求值拿到同一组端口。
 */
export async function resolveE2ePorts(opts: ResolveOptions = {}): Promise<E2EPorts> {
  const deps: PortResolveDeps = { ...DEFAULT_DEPS, ...opts.deps };
  const warn = opts.quiet ? () => {} : (msg: string) => console.warn(msg);
  const info = opts.quiet ? () => {} : (msg: string) => console.log(msg);
  /* Playwright 会在每个 worker 进程里重新求值本配置；第二次拿到的是主进程
     写回的 env，全部走 explicit。此时再探测/再打日志只会得到「端口被自己
     占用」的假警告和重复的汇总行，故用标记跳过。 */
  const alreadyResolved = process.env[RESOLVED_MARKER] === '1';

  const specs: Record<ServiceKey, ServiceSpec> = {
    /* vite 签名路径：无关服务不会响应 /@vite/client */
    web: { name: 'web(vite)', defaultPort: 5173, envVar: 'MOLIO_E2E_WEB_PORT', probe: { path: '/@vite/client', expect: 'vite' } },
    daemon: { name: 'daemon', defaultPort: 3100, envVar: 'MOLIO_E2E_DAEMON_PORT', probe: { path: '/api/health', expect: '"status"' } },
    /* cloud 默认 3201（与 #417 后一致）：3200 常被别的 worktree 的 dev server 占着 */
    cloud: { name: 'cloud', defaultPort: 3201, envVar: 'MOLIO_E2E_CLOUD_PORT', probe: { path: '/health', expect: '"ok"' } },
    mockOss: { name: 'mock-oss', defaultPort: 3199, envVar: 'MOLIO_E2E_MOCK_OSS_PORT', probe: { path: '/__health', expect: 'molio-mock-oss' } },
  };
  const keys = Object.keys(specs) as ServiceKey[];

  /* 第一遍：登记所有默认端口与显式端口，防止平移撞上还没绑定的服务默认端口
     （例如 mock-oss 从 3200 起扫时撞上 cloud 的 3201）。 */
  const reserved = new Set<number>();
  const explicitOwner = new Map<number, { envVar: string; name: string }>();
  for (const key of keys) {
    const spec = specs[key];
    reserved.add(spec.defaultPort);
    const raw = process.env[spec.envVar]?.trim();
    if (!raw) continue;
    const port = parseExplicitPort(raw, spec.envVar);
    const prev = explicitOwner.get(port);
    if (prev) {
      throw new Error(
        `[e2e-ports] ${spec.envVar} 与 ${prev.envVar} 指定了同一个端口 :${port}，` +
        `两个服务不能共用端口。`,
      );
    }
    explicitOwner.set(port, { envVar: spec.envVar, name: spec.name });
    reserved.add(port);
  }
  /* 显式端口撞上另一个服务的默认端口：那个服务没被显式改端口时必然冲突。 */
  for (const [port, owner] of explicitOwner) {
    for (const key of keys) {
      const other = specs[key];
      if (other.envVar === owner.envVar) continue;
      if (!process.env[other.envVar]?.trim() && other.defaultPort === port) {
        throw new Error(
          `[e2e-ports] ${owner.envVar}=${port} 与 ${other.name} 的默认端口相同，` +
          `两个服务不能共用端口；请换一个端口或同时覆盖 ${other.envVar}。`,
        );
      }
    }
  }

  /* 第二遍：串行解析。探测是毫秒级，串行换来的是确定的两两不同的分配结果。 */
  const ctx: ResolveContext = { reuse: !!opts.reuse, reserved, deps, warn, alreadyResolved };
  const decisions = {} as E2EPorts['decisions'];
  for (const key of keys) {
    const decision = await resolveOne(specs[key], ctx);
    decisions[key] = decision;
    reserved.add(decision.port);
  }

  if (!alreadyResolved) {
    info(
      `[e2e-ports] ${keys.map((k) => `${k}=:${decisions[k].port}(${decisions[k].mode})`).join(' ')}`,
    );
  }

  process.env[RESOLVED_MARKER] = '1';
  process.env.MOLIO_E2E_WEB_PORT = String(decisions.web.port);
  process.env.MOLIO_E2E_DAEMON_PORT = String(decisions.daemon.port);
  process.env.MOLIO_E2E_CLOUD_PORT = String(decisions.cloud.port);
  process.env.MOLIO_E2E_MOCK_OSS_PORT = String(decisions.mockOss.port);
  return {
    web: decisions.web.port,
    daemon: decisions.daemon.port,
    cloud: decisions.cloud.port,
    mockOss: decisions.mockOss.port,
    decisions,
  };
}
