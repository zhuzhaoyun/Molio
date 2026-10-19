/**
 * First-run activation checklist.
 *
 * Three real milestones, not a click-through tour: vault ready, a document
 * opened or imported, and a question actually sent. The banner stays one line
 * tall and can be dismissed; it never blocks the workspace.
 *
 * The next action is a filled button sitting next to the step markers, not a
 * far-right text link: a quiet 36px line of grey text is easy to scroll past,
 * and activation lives or dies on that one click (user feedback 2026-10-19).
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

const STEP_KEYS = ['vault', 'openOrImport', 'ask'] as const;

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
  const firstPending = STEP_KEYS.findIndex((key) => !steps[key]);
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
          <span className="kb-onboarding__dots" aria-hidden="true">
            {STEP_KEYS.map((key, index) => {
              const done = steps[key];
              return (
                <span
                  key={key}
                  className={`kb-onboarding__dot${done ? ' is-done' : ''}${index === firstPending ? ' is-current' : ''}`}
                >
                  {done ? '✓' : index + 1}
                </span>
              );
            })}
          </span>
          <span className="kb-onboarding__title">{t('kb.onboarding.title')}</span>
          <span className="kb-onboarding__progress">{doneCount}/3</span>
          <svg
            className="kb-onboarding__chevron"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {next && (
          <>
            <span className="kb-onboarding__hint">
              {next === 'import' ? t('kb.onboarding.nextImport') : t('kb.onboarding.nextAsk')}
            </span>
            <button
              type="button"
              className="kb-onboarding__cta"
              data-testid="kb-onboarding-cta"
              onClick={next === 'import' ? onImport : onAsk}
            >
              {next === 'import' ? t('kb.onboarding.actionImport') : t('kb.onboarding.actionAsk')}
            </button>
          </>
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

      {/* 进度线：把「走到哪一步」变成结构，而不是只靠一行小字。 */}
      <div className="kb-onboarding__rail" aria-hidden="true">
        <span style={{ width: `${(doneCount / STEP_KEYS.length) * 100}%` }} />
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
          </li>
          <li className={steps.ask ? 'is-done' : ''}>
            <span className="kb-onboarding__check">{steps.ask ? '✓' : '3'}</span>
            <span>{t('kb.onboarding.step3')}</span>
          </li>
        </ol>
      )}
    </div>
  );
}
