import { useCallback, useEffect, useState } from 'react';
import type { HubSkillSummary, InstallHubSkillResponse } from '@molio/contracts';
import { useSkillHub, type HubSort } from '../../hooks/useSkillHub';
import { useI18n } from '../../i18n';
import { HubSkillDetailModal, formatDownloads } from './HubSkillDetailModal';

/** Sort options mirror skillhub.cn: default ranking / downloads / newest updates. */
const HUB_SORTS: HubSort[] = ['default', 'downloads', 'updated'];

function HubCard({
  skill,
  installing,
  busy,
  zh,
  onInstall,
  onOpenDetail,
}: {
  skill: HubSkillSummary;
  /** This card's install is in flight (shows the busy label). */
  installing: boolean;
  /** ANY install is in flight — all install buttons stay disabled so only
   *  one install runs at a time (the daemon serializes per slug, and the
   *  single-slot indicator can't represent two concurrent installs). */
  busy: boolean;
  zh: boolean;
  onInstall: () => void;
  onOpenDetail: () => void;
}) {
  const { t } = useI18n();

  return (
    <div
      className="hub-card"
      data-testid={`hub-card-${skill.slug}`}
      onClick={onOpenDetail}
      onKeyDown={(e) => {
        // Only react to keys pressed on the card ITSELF: keydowns from the
        // nested install button bubble up here, and preventDefault would
        // swallow the button's native keyboard activation (Enter fires click
        // on keydown, Space on keyup) — a keyboard user could never install.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenDetail();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="hub-card__head">
        <span className="hub-card__name" title={skill.name}>
          {skill.name}
        </span>
        {skill.verified && (
          <span className="hub-badge hub-badge--verified" title={t('hub.verified')}>
            ✓
          </span>
        )}
        {skill.requiresApiKey && <span className="hub-badge hub-badge--key">{t('hub.requiresApiKey')}</span>}
      </div>

      <div className="hub-card__desc">{skill.description || t('hub.noDescription')}</div>

      <div className="hub-card__meta">
        <span className="hub-card__author" title={skill.ownerName}>
          {skill.ownerName}
        </span>
        {skill.version && <span>{t('hub.version', { version: skill.version })}</span>}
        <span title={String(skill.downloads)}>{formatDownloads(skill.downloads, zh)}</span>
      </div>

      <div className="hub-card__actions">
        <button
          className={`rt-btn rt-btn--sm${skill.installed ? ' rt-btn--ghost' : ''}`}
          data-testid={`hub-install-${skill.slug}`}
          // Direct installs must not open the detail modal (card is clickable).
          onClick={(e) => {
            e.stopPropagation();
            onInstall();
          }}
          disabled={busy}
          title={skill.installed ? t('hub.update') : undefined}
        >
          {installing ? t('hub.installing') : skill.installed ? t('hub.update') : t('hub.install')}
        </button>
      </div>
    </div>
  );
}

/**
 * The skill store: browses the skillhub.cn catalog through the daemon proxy
 * and installs a skill with one click (installed hub skills become regular
 * library skills, managed under "My Skills").
 */
export function SkillHubPanel({ onInstalled }: { onInstalled: (res: InstallHubSkillResponse) => void }) {
  const { t, locale } = useI18n();
  const {
    skills,
    total,
    loading,
    loadingMore,
    error,
    categories,
    keyword,
    setKeyword,
    category,
    setCategory,
    sort,
    setSort,
    hasMore,
    installingSlug,
    refresh,
    loadMore,
    install,
  } = useSkillHub();

  const zh = locale.startsWith('zh');

  // Transient install feedback (success banner auto-hides; errors stay until
  // the next action). A fresh install attempt clears any previous message.
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    if (!notice || notice.kind !== 'success') return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Detail modal: opened by clicking a card; the modal fetches its own data.
  const [detailSkill, setDetailSkill] = useState<HubSkillSummary | null>(null);

  const handleInstall = useCallback(
    async (skill: HubSkillSummary) => {
      // One install at a time (buttons are disabled too — this guards the
      // same-tick race before the disabled attribute commits).
      if (installingSlug) return;
      setNotice(null);
      try {
        const res = await install(skill);
        if (!res) return; // lost the race against another install — no-op
        setNotice({
          kind: 'success',
          text: res.updated ? t('hub.updatedTip') : t('hub.installedTip'),
        });
        // An install from the detail modal closes it — the success banner
        // behind is the feedback, and the card grid already flipped state.
        setDetailSkill((cur) => (cur && cur.slug === skill.slug ? null : cur));
        onInstalled(res);
      } catch (err) {
        setNotice({ kind: 'error', text: (err as Error).message });
      }
    },
    [install, installingSlug, onInstalled, t],
  );

  return (
    <div className="hub-shell">
      <div className="hub-toolbar">
        <input
          className="sk-field__input hub-search"
          data-testid="hub-search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t('hub.searchPlaceholder')}
        />
        <select
          className="hub-category"
          data-testid="hub-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">{t('hub.allCategories')}</option>
          {categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="hub-sort" data-testid="hub-sort" role="group" aria-label={t('hub.sort.default')}>
          {HUB_SORTS.map((key) => (
            <button
              key={key}
              type="button"
              className={`sk-seg__item${sort === key ? ' sk-seg__item--active' : ''}`}
              data-testid={`hub-sort-${key}`}
              onClick={() => setSort(key)}
            >
              {t(`hub.sort.${key}`)}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <div
          className={notice.kind === 'success' ? 'hub-notice hub-notice--success' : 'rt-error'}
          data-testid="hub-notice"
        >
          <span>{notice.text}</span>
        </div>
      )}

      {error && (
        <div className="rt-error" data-testid="hub-error">
          <span>{error}</span>
          <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={refresh}>
            {t('hub.retry')}
          </button>
        </div>
      )}

      {loading ? (
        <div className="rt-loading">{t('hub.loading')}</div>
      ) : skills.length === 0 && !error ? (
        <div className="rt-empty">
          <div className="rt-empty__icon">🛍️</div>
          <div className="rt-empty__text">{t('hub.empty')}</div>
          <div className="rt-empty__hint">{t('hub.emptyHint')}</div>
        </div>
      ) : skills.length > 0 ? (
        <>
          <div className="hub-grid" data-testid="hub-grid">
            {skills.map((skill) => (
              <HubCard
                // Full identity — the same slug can appear under different
                // namespaces and must not collide as a React key.
                key={`${skill.namespace ?? ''}/${skill.slug}`}
                skill={skill}
                installing={installingSlug === skill.slug}
                busy={installingSlug !== null}
                zh={zh}
                onInstall={() => void handleInstall(skill)}
                onOpenDetail={() => setDetailSkill(skill)}
              />
            ))}
          </div>

          <div className="hub-footer">
            <span className="hub-footer__total">{t('hub.total', { total: String(total) })}</span>
            {hasMore && (
              <button
                className="rt-btn rt-btn--sm rt-btn--ghost"
                data-testid="hub-load-more"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? t('hub.loading') : t('hub.loadMore')}
              </button>
            )}
          </div>
        </>
      ) : null /* error with no skills: the banner above is the only feedback */}

      <p className="sk-note">
        <a href="https://skillhub.cn/skills" target="_blank" rel="noopener noreferrer">
          {t('hub.source')}
        </a>
      </p>

      {detailSkill && (
        <HubSkillDetailModal
          skill={detailSkill}
          busy={installingSlug !== null}
          notice={notice}
          onClose={() => setDetailSkill(null)}
          onInstall={() => void handleInstall(detailSkill)}
        />
      )}
    </div>
  );
}
