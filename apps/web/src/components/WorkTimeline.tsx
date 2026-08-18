// apps/web/src/components/WorkTimeline.tsx
import { useEffect, useState } from 'react';
import type { WorkStep } from '../utils/workSteps';
import { useI18n } from '../i18n';

interface Props {
  steps: WorkStep[];
  /** 会话层运行信号（AssistantMessage 传 message.streaming）——出错/结束后即回落摘要 */
  isRunning: boolean;
}

function stepIcon(status: WorkStep['status']): string {
  return status === 'running' ? '⟳' : status === 'error' ? '✗' : '✓';
}

/** 滚动到消息内对应的 ToolCard（证据回跳）。无锚点时静默不滚。 */
function scrollToEvidence(toolId?: string): void {
  if (!toolId) return;
  const anchor = document.querySelector(`[data-tool-id="${CSS.escape(toolId)}"]`);
  if (anchor) {
    anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  // 工具可能收在折叠的批量组内：派发事件让包含它的批量组展开并定位（见 BatchGroup）。
  window.dispatchEvent(new CustomEvent('molio:evidence-target', { detail: toolId }));
}

export function WorkTimeline({ steps, isRunning }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // 新 run 开始 → 展开态重置为折叠（不跨 run 记忆）。
  // 必须放在 early return 之前（Rules of Hooks）。
  useEffect(() => {
    if (isRunning) setExpanded(false);
  }, [isRunning]);

  const toolSteps = steps.filter((s) => s.kind === 'tool');
  if (toolSteps.length === 0) return null;

  if (isRunning) {
    const current = [...steps].reverse().find((s) => s.status === 'running') ?? steps[0]!;
    return (
      <div className="work-timeline" data-testid="work-timeline">
        <div className="work-timeline-current" data-testid="work-timeline-current">
          <span className="work-timeline-spinner" aria-hidden>⟳</span>
          <span className="work-timeline-label">{t(current.label)}</span>
          {current.detail && <span className="work-timeline-detail">· {current.detail}</span>}
          {current.count && current.count > 1 && <span className="work-step-count">×{current.count}</span>}
        </div>
        <div className="work-timeline-track" aria-hidden />
      </div>
    );
  }

  const hasError = steps.some((s) => s.status === 'error');
  const verb = hasError ? t('workTimeline.failed') : t('workTimeline.done');
  const inventory = toolSteps
    .map((s) => t(s.label) + (s.count && s.count > 1 ? ` ×${s.count}` : ''))
    .join(' · ');

  return (
    <div className="work-timeline" data-testid="work-timeline">
      <button
        type="button"
        className="work-timeline-summary"
        data-testid="work-timeline-summary"
        aria-expanded={expanded}
        aria-controls="work-timeline-detail"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`work-summary-icon${hasError ? ' error' : ''}`} aria-hidden>
          {hasError ? '✗' : '✓'}
        </span>
        <span className="work-summary-text">{verb} · {inventory}</span>
        <span className="work-summary-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <ol className="work-timeline-detail" id="work-timeline-detail">
          {steps.map((step) => (
            <li key={step.id}>
              {step.kind === 'tool' ? (
                <button
                  type="button"
                  className="work-timeline-step"
                  data-testid="work-timeline-step"
                  data-step-status={step.status}
                  onClick={() => scrollToEvidence(step.toolId)}
                >
                  <span className="work-step-icon" aria-hidden>{stepIcon(step.status)}</span>
                  <span className="work-step-label">{t(step.label)}</span>
                  {step.detail && <span className="work-step-detail">{step.detail}</span>}
                  {step.count && step.count > 1 && <span className="work-step-count">×{step.count}</span>}
                </button>
              ) : (
                <div className="work-timeline-step-static" data-step-status={step.status}>
                  <span className="work-step-icon" aria-hidden>{stepIcon(step.status)}</span>
                  <span className="work-step-label">{t(step.label)}</span>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
