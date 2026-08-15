// apps/web/src/components/WorkTimeline.tsx
import type { WorkStep } from '../utils/workSteps';
import { useI18n } from '../i18n';

interface Props {
  steps: WorkStep[];
}

export function WorkTimeline({ steps }: Props) {
  const { t } = useI18n();
  if (steps.length === 0) return null;

  return (
    <div className="work-timeline" data-testid="work-timeline">
      {steps.map((step) => (
        <div key={step.id} className="work-step" data-step-status={step.status}>
          <span className="work-step-icon" aria-hidden>
            {step.status === 'done' ? '✓' : step.status === 'error' ? '✗' : '⟳'}
          </span>
          <span className="work-step-label">{t(step.label)}</span>
          {step.detail && <span className="work-step-detail">{step.detail}</span>}
          {step.count && step.count > 1 && <span className="work-step-count">×{step.count}</span>}
        </div>
      ))}
    </div>
  );
}
