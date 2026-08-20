// apps/web/src/stores/currentContextStore.ts
import { useSyncExternalStore } from 'react';
import type { Vault } from '@molio/contracts';
import { vaultStore } from './vaultStore';

export interface CurrentContext {
  /** 当前激活的知识库（vaultStore 全局单例） */
  vault: Vault | null;
  /** 当前在知识库页选中的文件（相对 vault 根）。非 KB 页为 null。 */
  filePath: string | null;
  /** 当前所在页面 */
  page: 'knowledge' | 'home' | 'history' | 'graph' | 'settings' | 'other';
}

let context: CurrentContext = {
  vault: null,
  filePath: null,
  page: 'other',
};
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function refreshVaultFromStore() {
  // vault 是 vaultStore 的全局单例，这里同步它，保证悬浮层总能拿到当前 vault
  const v = vaultStore.getActiveVault();
  if (v !== context.vault) {
    context = { ...context, vault: v };
    emit();
  }
}

// vaultStore 变化时联动（订阅 vaultStore，避免悬浮层在非 KB 页时拿不到 vault）
vaultStore.subscribe(() => refreshVaultFromStore());

export const currentContextStore = {
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
  get(): CurrentContext { return context; },
  /** 写入当前上下文。filePath/page 由各页面在路由/选中变化时调用。 */
  set(partial: Partial<Omit<CurrentContext, 'vault'>>) {
    const next = { ...context, ...partial };
    if (next.filePath !== context.filePath || next.page !== context.page) {
      context = next;
      emit();
    }
  },
};

export function useCurrentContext(): CurrentContext {
  return useSyncExternalStore(currentContextStore.subscribe, currentContextStore.get, currentContextStore.get);
}
