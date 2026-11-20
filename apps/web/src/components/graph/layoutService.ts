/**
 * LayoutService —— 后台全量布局 worker 的生命周期编排（H2，设计 §4.2 + 代拍 E/P）。
 *
 * 模块级单例（getLayoutService），键 = vault+scope：后启停前启（多 GraphPage 实例并存
 * 不重复烧 27s 布局）；换键 terminate 重启。trunk 可交互后由宿主经 requestIdleCallback
 * ensure（代拍 E：不抢首开预算）。力参固定 DEFAULT_FORCE_PARAMS（trunk 场景语义，用户改
 * forces 不重启——代拍 P）。worker 崩溃/超时 → 调用方走 mini-sim 兜底（fail-open）。
 *
 * node:test 直测（layoutService.test.ts 用假工厂注入）；真 worker 工厂只在浏览器路径
 * 求值（Vite 原生 module worker）。
 */

export interface LayoutWorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

export interface LayoutService {
  /** 幂等：同 key no-op（含运行中）；换 key → terminate 旧 worker 重启新轮 */
  ensure(key: string, nodeKeys: string[], links: Array<{ source: string; target: string }>): void;
  isReady(): boolean;
  getPositions(): ReadonlyMap<string, { x: number; y: number }> | null;
  /** 布局轮完成回调（订阅制；返回退订函数） */
  onReady(cb: () => void): () => void;
  dispose(): void;
}

type ServiceState =
  | { phase: 'idle' }
  | { phase: 'running'; key: string; gen: number }
  | { phase: 'ready'; key: string; gen: number; positions: ReadonlyMap<string, { x: number; y: number }> };

export function createLayoutService(factory?: () => LayoutWorkerLike): LayoutService {
  const makeWorker =
    factory ??
    (() =>
      new Worker(new URL('./engine/layoutWorker.ts', import.meta.url), { type: 'module' }) as unknown as LayoutWorkerLike);

  let worker: LayoutWorkerLike | null = null;
  let state: ServiceState = { phase: 'idle' };
  let genCounter = 0;
  const readyListeners = new Set<() => void>();

  const detachWorker = (terminate: boolean): void => {
    if (!worker) return;
    worker.onmessage = null;
    if (terminate) worker.terminate();
    worker = null;
  };

  return {
    ensure(key, nodeKeys, links) {
      if (state.phase !== 'idle' && state.key === key) return; // 幂等：同 key（含运行中）no-op
      // 换 key：后启停前启（代拍 P）
      detachWorker(true);
      state = { phase: 'idle' };
      const gen = ++genCounter;
      const w = makeWorker();
      worker = w;
      state = { phase: 'running', key, gen };
      w.onmessage = (e: { data: unknown }) => {
        const msg = e.data as { type?: string; gen?: number; positions?: Array<[string, number, number]> };
        if (!msg || msg.type !== 'done') return;
        if (state.phase !== 'running' || state.gen !== msg.gen || w !== worker) return; // 旧 gen 迟到回包丢弃
        const positions = new Map<string, { x: number; y: number }>();
        for (const [id, x, y] of msg.positions ?? []) positions.set(id, { x, y });
        state = { phase: 'ready', key, gen, positions };
        for (const cb of readyListeners) cb();
      };
      w.postMessage({ type: 'layout', gen, nodeKeys, links });
    },
    isReady() {
      return state.phase === 'ready';
    },
    getPositions() {
      return state.phase === 'ready' ? state.positions : null;
    },
    onReady(cb) {
      readyListeners.add(cb);
      return () => readyListeners.delete(cb);
    },
    dispose() {
      detachWorker(true);
      state = { phase: 'idle' };
    },
  };
}

// ── 模块级单例 ──

let singleton: LayoutService | null = null;

/** 全局唯一布局服务（键 = vault+scope 天然互斥；组件卸载只 dispose 自己 key 的轮次交给换键逻辑）。 */
export function getLayoutService(): LayoutService {
  if (!singleton) singleton = createLayoutService();
  return singleton;
}
