import { useCallback, type MouseEvent } from 'react';
import { useActiveVaultId } from '../stores/vaultStore';
import { useFileNavigation } from './useFileNavigation';

/**
 * 聊天正文与 QuizCard 出处共用的 wikilink 点击逻辑。
 * 目标元素需带 `.kb-wiki-link` + `data-file-path`（renderMarkdown 的产物）。
 */
export function useWikiLinkClick() {
  const activeVaultId = useActiveVaultId();
  const { openFile } = useFileNavigation();

  return useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      const link = target.closest('.kb-wiki-link') as HTMLElement | null;
      if (!link || !activeVaultId) return;

      event.preventDefault();
      // QuizCard 嵌在 assistant-prose 内，prose 容器自己也挂了同一个 handler；
      // 不打断冒泡会对同一个链接导航两次（404 时还会弹两次 alert）。
      event.stopPropagation();
      const filePath = link.getAttribute('data-file-path') || link.textContent?.trim();
      if (!filePath) return;

      // Check file exists before navigating (dead link handling).
      const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
      fetch(`/api/knowledge/vaults/${activeVaultId}/resolve/${encoded}`)
        .then((res) => {
          if (res.status === 404) {
            window.alert(`文件 "${filePath}" 不存在`);
            return;
          }
          openFile(activeVaultId, filePath);
        })
        .catch(() => openFile(activeVaultId, filePath));
    },
    [activeVaultId, openFile],
  );
}
