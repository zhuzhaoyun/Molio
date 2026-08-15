// apps/web/src/components/SourceChips.tsx
import { useMemo } from 'react';
import type { ToolEvent } from '../hooks/useChatCore';
import { extractSources } from '../utils/toolRefs';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useActiveVaultId } from '../stores/vaultStore';
import { useI18n } from '../i18n';

interface Props {
  tools: ToolEvent[];
}

export function SourceChips({ tools }: Props) {
  const { t } = useI18n();
  const sources = useMemo(() => extractSources(tools), [tools]);
  const vaultId = useActiveVaultId();
  const { openFile } = useFileNavigation();

  if (sources.length === 0) return null;

  return (
    <div className="source-chips" data-testid="source-chips">
      <span className="source-chips-title">{t('source.title')}</span>
      {sources.map((s) => (
        <button
          key={s.target}
          type="button"
          className={`source-chip${s.navigable ? ' navigable' : ''}`}
          data-testid="source-chip"
          disabled={!s.navigable}
          onClick={() => { if (s.navigable && vaultId) openFile(vaultId, s.target); }}
        >
          <span className="source-chip-icon" aria-hidden>{s.kind === 'url' ? '🔗' : '📄'}</span>
          <span className="source-chip-label">{s.label}</span>
        </button>
      ))}
    </div>
  );
}
