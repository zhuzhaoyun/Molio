import { useEffect, useState } from 'react';
import type { HubSkillDetail, HubSkillSummary } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { MdRenderer } from '../kb/MdRenderer';
import { defaultThemeConfig } from '../kb/MdStylePanel';

/** Compact count like the hub site (2249 → 2249, 120000 → 12.0万 / 12.0w). */
export function formatDownloads(n: number, zh: boolean): string {
  if (n < 10000) return String(n);
  const v = (n / 10000).toFixed(1);
  return zh ? `${v}万` : `${v}w`;
}

/**
 * Skill store detail modal: fetches the hub detail (stats, security verdicts,
 * SKILL.md readme) for one catalog entry on open. The readme is rendered with
 * the shared doocs/md engine; a readme fetch failure never blocks the detail
 * (the daemon returns readme: '' in that case).
 */
export function HubSkillDetailModal({
  skill,
  busy,
  onClose,
  onInstall,
}: {
  skill: HubSkillSummary;
  /** ANY install is in flight — same one-at-a-time gating as the card grid. */
  busy: boolean;
  onClose: () => void;
  onInstall: () => void;
}) {
  const { t, locale } = useI18n();
  const zh = locale.startsWith('zh');
  const [detail, setDetail] = useState<HubSkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .hubSkillDetail({ slug: skill.slug, namespace: skill.namespace })
      .then((res) => {
        if (!cancelled) setDetail(res.detail);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skill.slug, skill.namespace, attempt]);

  // Esc closes, same convention as the resources lightbox.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Prefer the detail's live installed flag; fall back to the list annotation
  // while the detail is still loading.
  const installed = detail?.installed ?? skill.installed ?? false;
  const name = detail?.name ?? skill.name;

  return (
    <div
      className="hub-detail-overlay"
      data-testid="hub-detail-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="hub-detail-modal" role="dialog" aria-modal="true" aria-label={name}>
        <div className="hub-detail-header">
          <span className="hub-detail-name" title={name}>
            {name}
          </span>
          {(detail?.verified ?? skill.verified) && (
            <span className="hub-badge hub-badge--verified" title={t('hub.verified')}>
              ✓
            </span>
          )}
          {(detail?.requiresApiKey ?? skill.requiresApiKey) && (
            <span className="hub-badge hub-badge--key">{t('hub.requiresApiKey')}</span>
          )}
          <button className="hub-detail-close" onClick={onClose} aria-label={t('hub.detail.close')}>
            ×
          </button>
        </div>

        <div className="hub-detail-body" data-testid="hub-detail-body">
          {loading ? (
            <div className="rt-loading">{t('hub.detail.loading')}</div>
          ) : error ? (
            <div className="rt-error" data-testid="hub-detail-error">
              <span>{error}</span>
              <button
                className="rt-btn rt-btn--sm rt-btn--ghost"
                onClick={() => setAttempt((a) => a + 1)}
              >
                {t('hub.retry')}
              </button>
            </div>
          ) : detail ? (
            <>
              <div className="hub-detail-meta">
                <span className="hub-detail-meta__author" title={detail.ownerName}>
                  {detail.ownerName}
                </span>
                {detail.latestVersion && <span>{t('hub.version', { version: detail.latestVersion })}</span>}
                <span title={String(detail.stats.downloads)}>
                  {t('hub.downloads', { count: formatDownloads(detail.stats.downloads, zh) })}
                </span>
                {detail.stats.stars > 0 && (
                  <span title={String(detail.stats.stars)}>
                    {t('hub.detail.stars', { n: formatDownloads(detail.stats.stars, zh) })}
                  </span>
                )}
                {detail.updatedAt > 0 && (
                  <span>
                    {t('hub.detail.updatedAt', {
                      date: new Date(detail.updatedAt).toLocaleDateString(locale),
                    })}
                  </span>
                )}
              </div>

              {detail.security && (detail.security.keen || detail.security.sanbu) && (
                <div className="hub-detail-security" data-testid="hub-detail-security">
                  <span>{t('hub.detail.security')}</span>
                  {detail.security.keen && (
                    <span className="hub-detail-security__item">{detail.security.keen}</span>
                  )}
                  {detail.security.sanbu && (
                    <span className="hub-detail-security__item">{detail.security.sanbu}</span>
                  )}
                </div>
              )}

              {detail.description && <p className="hub-detail-desc">{detail.description}</p>}

              {detail.readme ? (
                <div className="hub-detail-readme" data-testid="hub-detail-readme">
                  <MdRenderer content={detail.readme} themeConfig={defaultThemeConfig} />
                </div>
              ) : (
                <p className="hub-detail-noreadme">{t('hub.detail.noReadme')}</p>
              )}
            </>
          ) : null}
        </div>

        <div className="hub-detail-footer">
          <button
            className={`rt-btn${installed ? ' rt-btn--ghost' : ''}`}
            data-testid="hub-detail-install"
            onClick={onInstall}
            disabled={busy}
          >
            {busy ? t('hub.installing') : installed ? t('hub.update') : t('hub.install')}
          </button>
        </div>
      </div>
    </div>
  );
}
