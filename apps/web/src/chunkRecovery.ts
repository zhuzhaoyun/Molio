/**
 * Chunk 加载失败自愈（2026-10-26 用户报障：更新后旧页面引用旧 hash chunk → 404 →
 * 「出了点问题」死屏，见 docs 侧排查记录）。
 *
 * 原理：SPA 的「页面引用 ↔ 盘上文件」一致性只在页面加载瞬间成立。更新换掉构建产物后，
 * 旧页面对新懒路由的 import() 必然 404。此时向当前 daemon 重新拉一次 index.html 即恢复
 * —— daemon 伺服的永远是当前盘上构建，所以自愈与「隔了几个版本」无关。
 *
 * 两条触发路径共用同一份冷却窗口（默认 15s），防止 daemon 真不可用时无限刷新循环：
 * 1. `vite:preloadError` 事件 —— Vite 构建产物的动态导入走 __vitePreload，失败时派发；
 * 2. AppErrorBoundary 捕获的 lazy rejection —— 用 isChunkLoadError 判别后走同一入口。
 */

/** 判别一个错误是否为「动态导入 chunk 失败」类（覆盖 Vite / Chromium 文案变体）。 */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i.test(msg);
}

/** sessionStorage 形状的子集，便于测试注入。 */
export interface RecoveryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ChunkRecoveryDeps {
  now?: () => number;
  reload?: () => void;
  store?: RecoveryStore;
  /** 冷却窗口：窗口内的重复失败不再刷新（daemon 真挂了时不无限循环）。 */
  windowMs?: number;
}

export const CHUNK_RELOAD_STORAGE_KEY = 'molio:chunk-reload-at';
const DEFAULT_WINDOW_MS = 15_000;

/** 创建带冷却窗口的刷新入口。返回 true = 本次真的触发了刷新。 */
export function createChunkRecovery(deps: ChunkRecoveryDeps = {}): { requestReload(): boolean } {
  const now = deps.now ?? (() => Date.now());
  const reload = deps.reload ?? (() => window.location.reload());
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const store = deps.store ?? safeSessionStorage();

  const requestReload = (): boolean => {
    let last = Number.NaN;
    try {
      const raw = store?.getItem(CHUNK_RELOAD_STORAGE_KEY) ?? null;
      last = raw === null ? Number.NaN : Number(raw);
    } catch {
      // sessionStorage 不可用（隐私模式等）：按无记录处理
    }
    const at = now();
    if (Number.isFinite(last) && at - last < windowMs) return false;
    try {
      store?.setItem(CHUNK_RELOAD_STORAGE_KEY, String(at));
    } catch {
      // 写不进去只影响冷却窗口的持久性，本次仍要刷新
    }
    reload();
    return true;
  };

  return { requestReload };
}

function safeSessionStorage(): RecoveryStore | undefined {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

/** 应用级共享实例：main.tsx 的 vite:preloadError 监听与 AppErrorBoundary 共用（经 sessionStorage 协调冷却窗口）。 */
export const appChunkRecovery = createChunkRecovery();

/** addEventListener 的最小形状（Node 单测里用假对象，浏览器里是 window）。 */
interface EventTargetLike {
  addEventListener(type: 'vite:preloadError', listener: (event: { preventDefault(): void }) => void): void;
}

/** 注册 vite:preloadError 监听（仅构建产物有效，dev 下事件不会派发，注册无副作用）。 */
export function installChunkRecovery(target: EventTargetLike, deps: ChunkRecoveryDeps = {}): { requestReload(): boolean } {
  const recovery = createChunkRecovery(deps);
  target.addEventListener('vite:preloadError', (event) => {
    // 阻止 Vite 把 preload 失败再抛成 unhandled rejection（刷新本身会接管恢复）
    event.preventDefault();
    recovery.requestReload();
  });
  return recovery;
}
