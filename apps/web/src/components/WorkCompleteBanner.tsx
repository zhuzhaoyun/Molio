// apps/web/src/components/WorkCompleteBanner.tsx
// 产物卡 —— 逐消息 provenance：本回复写入了哪些知识库文件。
// 移入消息内（AssistantMessage 尾部、SourceChips 之前）；布局与 SourceChips 同语言：
// 发丝边框 pill + 品牌 terracotta 只在 hover/focus 兑现交互。
import { useMemo } from 'react';
import type { ToolEvent } from '../hooks/useChatCore';
import { extractWrites } from '../utils/toolRefs';
import { isRevealAvailable, revealInFolder } from '../utils/reveal';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useActiveVault } from '../stores/vaultStore';
import { useI18n } from '../i18n';
import { FileIcon, FolderIcon } from './icons';

interface Props {
  tools: ToolEvent[];
}

export function WorkCompleteBanner({ tools }: Props) {
  const { t } = useI18n();
  const writes = useMemo(() => extractWrites(tools), [tools]);
  const activeVault = useActiveVault();
  const vaultId = activeVault?.id ?? null;
  const vaultPath = activeVault?.path ?? null;
  const { openFile } = useFileNavigation();
  // 「在资源管理器中显示」：仅桌面壳（window.__electron__）且选中 vault 时渲染
  const revealReady = isRevealAvailable() && !!vaultPath;

  if (writes.length === 0) return null;

  return (
    <div className="work-complete" data-testid="work-complete-banner">
      <span className="work-complete-title">
        <FileIcon size={11} />
        {t('complete.title')}
      </span>
      <div className="work-complete-files">
        {writes.map((w) => (
          <span key={w.path} className="work-complete-file-wrap">
            <button
              type="button"
              className="work-complete-file"
              data-testid="work-complete-file"
              title={w.path}
              disabled={!vaultId}
              onClick={() => { if (vaultId) openFile(vaultId, w.path); }}
            >
              <span className="work-complete-file-icon" aria-hidden>
                {w.kind === 'create' ? '＋' : '✎'}
              </span>
              <span className="work-complete-file-label">{w.label}</span>
            </button>
            {revealReady && (
              <button
                type="button"
                className="work-complete-file-reveal"
                data-testid="work-complete-file-reveal"
                title={t('complete.reveal')}
                aria-label={`${t('complete.reveal')} · ${w.path}`}
                onClick={() => { if (vaultPath) revealInFolder(vaultPath, w.path); }}
              >
                <FolderIcon size={11} />
              </button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
