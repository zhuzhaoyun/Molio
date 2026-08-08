import { useCallback, useEffect, useState } from 'react';
import type { HubSkillSummary, InstallHubSkillResponse } from '@molio/contracts';
import { useSkillHub } from '../../hooks/useSkillHub';
import { useI18n } from '../../i18n';

/** Compact download count like the hub site (2249 → 2249, 120000 → 12.0万 / 12.0k). */
function formatDownloads(n: number, zh: boolean): string {
  if (n < 10000) return String(n);
  const v = (n / 10000).toFixed(1);
  return zh ? `${v}万` : `${v}w`;
}

function HubCard({
  skill,
  installing,
  busy,
  zh,
  onInstall,
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
}) {
  const { t } = useI18n();

  return (
    <div className="hub-card" data-testid={`hub-card-${skill.slug}`}>
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
          onClick={onInstall}
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
    </div>
  );
}
