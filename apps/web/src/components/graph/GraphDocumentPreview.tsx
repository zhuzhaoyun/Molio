import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type { EngineNode } from './engine/pixiGraphEngine';

export function GraphDocumentPreview({ vaultId, node, active, revision, onOpen, onClose }: {
  vaultId: string; node: EngineNode; active: boolean; revision: number; onOpen(path: string): void; onClose(): void;
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<{ content?: string; error?: boolean; tooLarge?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setResult(null);
    if (node.path && !node.dead) {
      api.readFile(vaultId, node.path).then(file => {
        if (!cancelled) setResult({ content: file.content.slice(0, 4000), tooLarge: file.tooLarge });
      }).catch(() => { if (!cancelled) setResult({ error: true }); });
    }
    return () => { cancelled = true; };
  }, [vaultId, node.key, node.path, node.dead, attempt, active, revision]);
  return <aside className="graph-preview" data-testid="graph-preview" aria-label={t('graph.preview')}>
    <div className="graph-preview__heading"><strong>{node.label}</strong><button type="button" onClick={onClose} aria-label={t('graph.closePreview')}>×</button></div>
    <p className="graph-preview__caption">{t('graph.preview')}</p>
    {node.dead || !node.path ? <p data-testid="graph-preview-missing">{t('graph.previewMissing')}</p>
      : result?.error ? <div><p role="alert">{t('graph.previewError')}</p><button type="button" className="graph-preview__open" data-testid="graph-preview-retry" onClick={() => setAttempt(value => value + 1)}>{t('graph.previewRetry')}</button></div>
      : !result ? <p>{t('graph.loading')}</p>
      : result.tooLarge ? <p>{t('graph.previewTooLarge')}</p>
      : <pre>{result.content || t('graph.previewEmpty')}</pre>}
    {node.path && !node.dead && <button type="button" className="graph-preview__open" data-testid="graph-preview-open" onClick={() => onOpen(node.path)}>{t('graph.openDocument')}</button>}
  </aside>;
}
