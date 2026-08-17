// apps/web/src/components/WorkCompleteBanner.tsx
import { useMemo } from 'react';
import type { ToolEvent } from '../hooks/useChatCore';
import { extractWrites } from '../utils/toolRefs';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useActiveVaultId } from '../stores/vaultStore';
import { useI18n } from '../i18n';

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
    <div className="work-complete-banner" data-testid="work-complete-banner">
      <span className="work-complete-icon" aria-hidden>✅</span>
      <div className="work-complete-body">
        <span className="work-complete-title">{t('complete.writtenToKb')}</span>
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
    </div>
  );
}
