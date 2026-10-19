/**
 * First-run activation checklist.
 *
 * Five real milestones that mirror the product's main loop: your library is
 * ready, a note is open, your own material is imported, it answered a question,
 * and the answer is saved back. Two of them complete automatically on the sample
 * vault path — the remaining three are the parts a new user cannot discover by
 * looking around (import, ask, save-back).
 *
 * The next action is a filled button sitting next to the step markers, not a
 * far-right text link: a quiet 36px line of grey text is easy to scroll past,
 * and activation lives or dies on that one click (user feedback 2026-10-19).
 *
 * Finishing the guide leaves a persistent feature map instead of an 8-second
 * confetti bar: "I don't know what else Molio does" is the question that
 * remains after the loop, and it cannot be answered by something that vanishes
 * before it is read. The map stays until dismissed and is reopenable from Help.
 */

import { useState, useSyncExternalStore } from 'react';
import { useI18n } from '../../i18n';
import { onboardingStore, type OnboardingSteps } from '../../stores/onboardingStore';
import { useAgents } from '../../hooks/useAgents';

interface Props {
  hasVault: boolean;
  onImport: () => void;
  onAsk: () => void;
  onBuildWiki: () => void;
  onOpenGraph: () => void;
  onOpenHistory: () => void;
  onOpenRuntimeSettings: () => void;
}

const STEPS = [
  ['vault', 'kb.onboarding.step1'],
  ['openOrImport', 'kb.onboarding.step2'],
  ['import', 'kb.onboarding.step3'],
  ['ask', 'kb.onboarding.step4'],
  ['save', 'kb.onboarding.step5'],
] as const satisfies readonly (readonly [keyof OnboardingSteps, string])[];

export function OnboardingChecklist({
  hasVault,
  onImport,
  onAsk,
  onBuildWiki,
  onOpenGraph,
  onOpenHistory,
  onOpenRuntimeSettings,
}: Props) {
  const { t } = useI18n();
  const state = useSyncExternalStore(
    onboardingStore.subscribe,
    onboardingStore.getState,
    onboardingStore.getState,
  );
  const [expanded, setExpanded] = useState(false);
  // 提问是唯一需要 AI 的步骤：没有可用运行时就把 CTA 改成去配置，
  // 而不是让用户点进输入框才发现发不出去。
  const { agents, loading: agentsLoading, error: agentsError } = useAgents();

  if (!state || !hasVault) return null;
  if (state.status === 'dismissed') return null;

  if (state.status === 'done') {
    if (state.mapDismissed) return null;
    return (
      <div className="kb-onboarding kb-onboarding--map" data-testid="kb-onboarding">
        <div className="kb-onboarding__map" data-testid="kb-onboarding-done">
          <div className="kb-onboarding__map-head">
            <span className="kb-onboarding__map-check" aria-hidden="true">✓</span>
            <div className="kb-onboarding__map-copy">
              <span className="kb-onboarding__map-title">{t('kb.onboarding.mapTitle')}</span>
              <span className="kb-onboarding__map-body">{t('kb.onboarding.mapBody')}</span>
            </div>
            <button
              type="button"
              className="kb-onboarding__dismiss"
              data-testid="kb-onboarding-map-dismiss"
              aria-label={t('kb.onboarding.mapDismiss')}
              title={t('kb.onboarding.mapDismiss')}
              onClick={() => onboardingStore.dismissMap()}
            >
              ×
            </button>
          </div>

          <div className="kb-onboarding__map-grid">
            <section>
              <h4>{t('kb.onboarding.mapDaily')}</h4>
              <p>{t('kb.onboarding.mapDailyBody')}</p>
            </section>
            <section>
              <h4>{t('kb.onboarding.mapOrganize')}</h4>
              <p>{t('kb.onboarding.mapOrganizeBody')}</p>
              <div className="kb-onboarding__map-actions">
                <button type="button" data-testid="kb-onboarding-map-wiki" onClick={onBuildWiki}>
                  {t('kb.onboarding.mapBuild')}
                </button>
                <button type="button" data-testid="kb-onboarding-map-graph" onClick={onOpenGraph}>
                  {t('kb.onboarding.mapGraph')}
                </button>
              </div>
            </section>
            <section>
              <h4>{t('kb.onboarding.mapOutput')}</h4>
              <p>{t('kb.onboarding.mapOutputBody')}</p>
            </section>
            <section>
              <h4>{t('kb.onboarding.mapManage')}</h4>
              <p>{t('kb.onboarding.mapManageBody')}</p>
              <div className="kb-onboarding__map-actions">
                <button type="button" data-testid="kb-onboarding-map-history" onClick={onOpenHistory}>
                  {t('kb.onboarding.mapHistory')}
                </button>
                <button type="button" data-testid="kb-onboarding-map-runtime" onClick={onOpenRuntimeSettings}>
                  {t('kb.onboarding.mapRuntime')}
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  const steps = state.steps;
  const doneCount = STEPS.filter(([key]) => steps[key]).length;
  const firstPending = STEPS.findIndex(([key]) => !steps[key]);
  const noRuntime = !agentsLoading && !agentsError && agents.length === 0;

  let next: 'import' | 'ask' | 'runtime' | 'save' | null = null;
  if (!steps.openOrImport || !steps.import) next = 'import';
  else if (!steps.ask) next = noRuntime ? 'runtime' : 'ask';
  else if (!steps.save) next = 'save';

  const hintKey =
    next === 'import'
      ? 'kb.onboarding.nextImport'
      : next === 'ask'
        ? 'kb.onboarding.nextAsk'
        : next === 'runtime'
          ? 'kb.onboarding.nextRuntime'
          : next === 'save'
            ? 'kb.onboarding.nextSave'
            : null;

  const cta =
    next === 'import'
      ? { label: 'kb.onboarding.actionImport', action: onImport }
      : next === 'ask'
        ? { label: 'kb.onboarding.actionAsk', action: onAsk }
        : next === 'runtime'
          ? { label: 'kb.onboarding.actionConfigureAi', action: onOpenRuntimeSettings }
          : null;

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
            {STEPS.map(([key], index) => {
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
          <span className="kb-onboarding__progress">{doneCount}/{STEPS.length}</span>
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

        {hintKey && (
          <>
            <span className="kb-onboarding__hint">{t(hintKey)}</span>
            {cta && (
              <button
                type="button"
                className="kb-onboarding__cta"
                data-testid="kb-onboarding-cta"
                onClick={cta.action}
              >
                {t(cta.label)}
              </button>
            )}
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
        <span style={{ width: `${(doneCount / STEPS.length) * 100}%` }} />
      </div>

      {expanded && (
        <ol className="kb-onboarding__steps">
          {STEPS.map(([key, label], index) => (
            <li key={key} className={steps[key] ? 'is-done' : ''}>
              <span className="kb-onboarding__check">{steps[key] ? '✓' : index + 1}</span>
              <span>{t(label)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
