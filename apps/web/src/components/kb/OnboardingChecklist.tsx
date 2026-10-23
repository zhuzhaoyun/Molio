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

interface Props {
  hasVault: boolean;
  /** No usable agent: the ask step's real action is configuring one, which
   *  only the checklist can surface in place. */
  noRuntime: boolean;
  onImport: () => void;
  onAsk: () => void;
  onBuildWiki: () => void;
  onOpenGraph: () => void;
  onOpenHistory: () => void;
  onOpenRuntimeSettings: () => void;
}

const STEPS = [
  ['vault', 'kb.onboarding.step1', 'kb.onboarding.step1How'],
  ['openOrImport', 'kb.onboarding.step2', 'kb.onboarding.step2How'],
  ['import', 'kb.onboarding.step3', 'kb.onboarding.step3How'],
  ['ask', 'kb.onboarding.step4', 'kb.onboarding.step4How'],
  ['save', 'kb.onboarding.step5', 'kb.onboarding.step5How'],
] as const satisfies readonly (readonly [keyof OnboardingSteps, string, string])[];

export function OnboardingChecklist({
  hasVault,
  noRuntime,
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
        {/* 圆点是进度，不是五个按钮。它曾经整体包在展开按钮里：点第 4 个圆点
            实际只是把详情折起来，用户读到的是「选了第 4 步却毫无反应」
            （2026-10-19 验收反馈）。现在只有标题/进度/箭头这一个明确的展开控件。 */}
        <div className="kb-onboarding__summary">
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
          <button
            type="button"
            className="kb-onboarding__toggle"
            data-testid="kb-onboarding-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? t('kb.onboarding.collapse') : t('kb.onboarding.expand')}
            title={expanded ? t('kb.onboarding.collapse') : t('kb.onboarding.expand')}
            onClick={() => setExpanded((value) => !value)}
          >
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
        </div>

        {hintKey && (
          <>
            <span className="kb-onboarding__hint">{t(hintKey)}</span>
            {/* 换动作时 key 变化 → 重新挂载，让呼吸环从周期起点重播一遍。 */}
            {cta && (
              <button
                key={next}
                type="button"
                // 其余步骤的动画长在真实按钮上（导入 / 问答 / 保存）；
                // 只有「先配置 AI」没有页内真实按钮，才由这颗中转键承担提示。
                className={`kb-onboarding__cta${next === 'runtime' ? ' kb-guide-pulse--solid' : ''}`}
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
        <div className="kb-onboarding__details" data-testid="kb-onboarding-details">
          <ol className="kb-onboarding__steps">
            {STEPS.map(([key, label, how], index) => {
              const done = steps[key];
              const current = index === firstPending;
              return (
                <li
                  key={key}
                  className={`${done ? 'is-done' : ''}${current ? ' is-current' : ''}`}
                >
                  <span className="kb-onboarding__check" aria-hidden="true">
                    {done ? '✓' : index + 1}
                  </span>
                  <span className="kb-onboarding__step-copy">
                    <span className="kb-onboarding__step-label">
                      {t(label)}
                      {current && (
                        <span className="kb-onboarding__current">{t('kb.onboarding.current')}</span>
                      )}
                    </span>
                    <span className="kb-onboarding__step-how">{t(how)}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          {/* 用户问过「能不能自己跳步骤」：这里直接说明打勾来自真实操作，
              步骤不是可手动勾选的清单。 */}
          <p className="kb-onboarding__auto-hint">{t('kb.onboarding.autoHint')}</p>
        </div>
      )}
    </div>
  );
}
