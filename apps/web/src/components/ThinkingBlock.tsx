import { useState } from 'react';
import { useI18n } from '../i18n';

interface Props {
  content: string;
  streaming?: boolean;
}

export function ThinkingBlock({ content, streaming }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="thinking-block" data-testid="thinking-block">
      <div className="thinking-header" onClick={() => setExpanded(!expanded)}>
        <span>{expanded ? '▾' : '▸'}</span>
        <span>{streaming ? t('thinking.streaming') : t('thinking.title')}</span>
      </div>
      {expanded && (
        <div className="thinking-content">{content}</div>
      )}
    </div>
  );
}
