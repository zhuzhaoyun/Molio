// apps/web/src/stores/checkupStore.ts
import { useSyncExternalStore } from 'react';

/**
 * 「Molio 体检」弹窗的全局开合真值源。
 *
 * 入口有两个（KB 页听诊器按钮 + 悬浮按钮右键菜单），分处不同组件树；
 * 弹窗唯一实例挂在 KbChatSessionsPanel 的 portal 层（那里有 askDoctor /
 * runWikiOp / wiki 状态的现成接线）。开合需要跨组件树传递，与
 * messageSelectionStore / authStore 同一族：模块级 store + useSyncExternalStore。
 */
let open = false;
const listeners = new Set<() => void>();

export function setCheckupOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  listeners.forEach((l) => l());
}

export function useCheckupOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    () => open,
  );
}
