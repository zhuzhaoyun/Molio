// apps/web/src/components/WorkCompleteBanner.tsx
// 产物卡 —— 逐消息 provenance：本回复写入了哪些知识库文件。
// 移入消息内（AssistantMessage 尾部、SourceChips 之前）；布局与 SourceChips 同语言：
// 发丝边框 pill + 品牌 terracotta 只在 hover/focus 兑现交互。
import { useMemo } from 'react';
import type { ToolEvent } from '../hooks/useChatCore';
import { extractWrites } from '../utils/toolRefs';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useActiveVaultId } from '../stores/vaultStore';
import { useI18n } from '../i18n';
import { FileIcon } from './icons';

interface Props {
  tools: ToolEvent[];
}

export function WorkCompleteBanner({ tools }: Props) {
  const { t } = useI18n();
  const writes = useMemo(() => extractWrites(tools), [tools]);
  const vaultId = useActiveVaultId();
  const { openFile } = useFileNavigation();

  if (writes.length === 0) return null;

  return (
    <div className="work-complete" data-testid="work-complete-banner">
      <span className="work-complete-title">
        <FileIcon size={11} />
        {t('complete.title')}
      </span>
      <div className="work-complete-files">
        {writes.map((w) => (
          <button
            key={w.path}
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
        ))}
      </div>
    </div>
  );
}
