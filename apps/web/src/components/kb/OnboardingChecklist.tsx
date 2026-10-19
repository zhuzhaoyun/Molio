/**
 * First-run activation checklist.
 *
 * Three real milestones, not a click-through tour: vault ready, a document
 * opened or imported, and a question actually sent. The banner stays one line
 * tall and can be dismissed; it never blocks the workspace.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../../i18n';
import { onboardingStore } from '../../stores/onboardingStore';

interface Props {
  hasVault: boolean;
  onImport: () => void;
  onAsk: () => void;
  onBuildWiki: () => void;
  onOpenGraph: () => void;
}

export function OnboardingChecklist({ hasVault, onImport, onAsk, onBuildWiki, onOpenGraph }: Props) {
  const { t } = useI18n();
  const state = useSyncExternalStore(
    onboardingStore.subscribe,
    onboardingStore.getState,
    onboardingStore.getState,
  );
  const [expanded, setExpanded] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const previousStatus = useRef(state?.status);

  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = state?.status;
    if (was === 'active' && state?.status === 'done') {
      setShowDone(true);
      const timer = setTimeout(() => setShowDone(false), 8000);
      return () => clearTimeout(timer);
    }
  }, [state?.status]);

  // 完成态只停留到用户的下一动作：一有交互就收起（设计 §6.3）。
  useEffect(() => {
    if (!showDone) return;
    const hide = () => setShowDone(false);
    window.addEventListener('pointerdown', hide, { once: true });
    return () => window.removeEventListener('pointerdown', hide);
  }, [showDone]);

  if (!state || !hasVault) return null;
  if (state.status === 'dismissed') return null;
  if (state.status === 'done' && !showDone) return null;

  if (state.status === 'done') {
    return (
      <div className="kb-onboarding" data-testid="kb-onboarding">
        <div className="kb-onboarding__done" data-testid="kb-onboarding-done">
          <span>{t('kb.onboarding.doneTitle')}</span>
          <span className="kb-onboarding__done-body">{t('kb.onboarding.doneBody')}</span>
          <button type="button" className="kb-onboarding__link" onClick={onBuildWiki}>
            {t('kb.onboarding.doneBuild')}
          </button>
          <button type="button" className="kb-onboarding__link" onClick={onOpenGraph}>
            {t('kb.onboarding.doneGraph')}
          </button>
        </div>
      </div>
    );
  }

  const steps = state.steps;
  const doneCount = Number(steps.vault) + Number(steps.openOrImport) + Number(steps.ask);
  const next = !steps.openOrImport ? 'import' : !steps.ask ? 'ask' : null;

  return (
    <div className="kb-onboarding" data-testid="kb-onboarding">
      <div className="kb-onboarding__bar">
        <button
          type="button"
          className="kb-onboarding__toggle"
          data-testid="kb-onboarding-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{t('kb.onboarding.title')}</span>
          <span className="kb-onboarding__progress">{doneCount}/3</span>
        </button>

        {next && (
          <button
            type="button"
            className="kb-onboarding__next"
            onClick={next === 'import' ? onImport : onAsk}
          >
            {next === 'import' ? t('kb.onboarding.nextImport') : t('kb.onboarding.nextAsk')}
          </button>
        )}

        <button
          type="button"
          className="kb-onboarding__dismiss"
          data-testid="kb-onboarding-dismiss"
          aria-label={t('kb.onboarding.dismiss')}
          title={t('kb.onboarding.dismiss')}
          onClick={() => onboardingStore.dismiss()}
        >
          ×
        </button>
      </div>

      {expanded && (
        <ol className="kb-onboarding__steps">
          <li className={steps.vault ? 'is-done' : ''}>
            <span className="kb-onboarding__check">{steps.vault ? '✓' : '1'}</span>
            <span>{t('kb.onboarding.step1')}</span>
          </li>
          <li className={steps.openOrImport ? 'is-done' : ''}>
            <span className="kb-onboarding__check">{steps.openOrImport ? '✓' : '2'}</span>
            <span>{t('kb.onboarding.step2')}</span>
            {!steps.openOrImport && (
              <button
                type="button"
                className="kb-onboarding__link"
                data-testid="kb-onboarding-step-2"
                onClick={onImport}
              >
                {t('kb.onboarding.actionImport')}
              </button>
            )}
          </li>
          <li className={steps.ask ? 'is-done' : ''}>
            <span className="kb-onboarding__check">{steps.ask ? '✓' : '3'}</span>
            <span>{t('kb.onboarding.step3')}</span>
            {!steps.ask && (
              <button
                type="button"
                className="kb-onboarding__link"
                data-testid="kb-onboarding-step-3"
                onClick={onAsk}
              >
                {t('kb.onboarding.actionAsk')}
              </button>
            )}
          </li>
        </ol>
      )}
    </div>
  );
}
