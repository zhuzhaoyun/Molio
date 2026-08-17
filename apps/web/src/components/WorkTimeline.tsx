// apps/web/src/components/WorkTimeline.tsx
import { useEffect, useState } from 'react';
import type { WorkStep } from '../utils/workSteps';
import { useI18n } from '../i18n';

interface Props {
  steps: WorkStep[];
  isRunning: boolean;
}

export function WorkTimeline({ steps, isRunning }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // 新 run 开始 → 展开态重置为折叠（不跨 run 记忆）
  useEffect(() => {
    if (isRunning) setExpanded(false);
  }, [isRunning]);

  if (steps.length === 0) return null;

  if (isRunning) {
    return (
      <div className="work-timeline" data-testid="work-timeline">
        <span className="work-timeline-strip">
          {steps.map((step, idx) => {
            const running = step.status === 'running';
            return (
              <span key={step.id} className="work-step" data-step-status={step.status}>
                {idx > 0 && <span className="work-step-sep" aria-hidden>→</span>}
                <span className="work-step-icon" aria-hidden>
                  {running ? '⟳' : step.status === 'error' ? '✗' : '✓'}
                </span>
                <span className="work-step-label">{t(step.label)}</span>
                {running && step.detail && <span className="work-step-detail">· {step.detail}</span>}
                {step.count && step.count > 1 && <span className="work-step-count">×{step.count}</span>}
              </span>
            );
          })}
        </span>
      </div>
    );
  }

  return (
    <div className="work-timeline" data-testid="work-timeline">
      <button
        type="button"
        className="work-timeline-summary"
        data-testid="work-timeline-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="work-summary-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
        <span className="work-summary-icon" aria-hidden>✓</span>
        <span className="work-summary-text">
          {t('workTimeline.doneSummary', { n: steps.length })}
        </span>
      </button>
      {expanded && (
        <ol className="work-timeline-detail">
          {steps.map((step) => (
            <li key={step.id} className="work-step" data-step-status={step.status}>
              <span className="work-step-icon" aria-hidden>
                {step.status === 'error' ? '✗' : '✓'}
              </span>
              <span className="work-step-label">{t(step.label)}</span>
              {step.detail && <span className="work-step-detail">{step.detail}</span>}
              {step.count && step.count > 1 && <span className="work-step-count">×{step.count}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
