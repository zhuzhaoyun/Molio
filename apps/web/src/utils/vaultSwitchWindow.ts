/**
 * 切换知识库时的窗口行为（设置 → 通用）。
 * 纯 localStorage 偏好（先例：molio.theme）；多窗口共享同一 localStorage，
 * 天然一致——靠 `storage` 事件（只投递给未动手的窗口）失效本模块缓存。
 * 设计：docs/2026-11-20-kb-switch-window-setting-design.md §4.1-4.2。
 */
export type VaultSwitchWindowMode = 'new-window' | 'reuse';

export const STORAGE_KEY_VAULT_SWITCH_WINDOW = 'molio.vaultSwitchWindow';

let cachedMode: VaultSwitchWindowMode | null = null;

/** 'reuse' 之外（含 null/''/非法值）一律缺省 new-window。 */
function parse(raw: string | null): VaultSwitchWindowMode {
  return raw === 'reuse' ? 'reuse' : 'new-window';
}

export function readVaultSwitchWindowMode(): VaultSwitchWindowMode {
  if (cachedMode !== null) return cachedMode;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY_VAULT_SWITCH_WINDOW);
  } catch {
    /* localStorage 不可用（隐私模式等）→ 缺省 */
  }
  cachedMode = parse(raw);
  return cachedMode;
}

export function shouldReuseWindowOnVaultSwitch(): boolean {
  return readVaultSwitchWindowMode() === 'reuse';
}

export function setVaultSwitchWindowMode(mode: VaultSwitchWindowMode): void {
  cachedMode = mode; // 动手窗口自己的缓存必须就地更新（storage 事件不会投递给它）
  try {
    localStorage.setItem(STORAGE_KEY_VAULT_SWITCH_WINDOW, mode);
  } catch {
    /* 写失败：内存态保底，本窗口内仍生效 */
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  try {
    window.addEventListener('storage', () => { cachedMode = null; });
  } catch {
    /* 非 DOM 环境（node:test stub 等）忽略 */
  }
}
