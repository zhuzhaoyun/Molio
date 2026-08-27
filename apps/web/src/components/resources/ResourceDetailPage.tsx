/**
 * 资源详情页（/resources/:id）—— 对应官网 resource.html：
 * 面包屑返回 + head（图标/名称/价格/格式说明/tags）+ 左主栏（概述/效果预览灯箱/导入说明）
 * + 右侧动作卡与信息卡。预览图为官网相对路径拼绝对 URL，加载失败整图跳过。
 *
 * id 解析：统一从 GET /api/market/listings/:id 拉取（官方与用户上架同动态目录），
 * 200 → marketToEntry 渲染市场变体（预览绝对 URL、简介、作者/版本/大小/发布时间、
 * 签名下载按钮）；失败/404 → 「资源不存在」形态。
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { MarketListing } from '@molio/contracts';
import { useI18n } from '../../i18n';
import {
  marketToEntry,
  PAY_BASE,
  previewUrl,
  type CatalogEntry,
} from '../../data/resources';
import { formatFileSize } from '../../utils/format';
import { useResourcePay } from '../../hooks/useResourcePay';
import { useAuthStatus } from '../../stores/authStore';
import { ResourcePayModal } from './ResourcePayModal';
import { startResourcePurchase } from './resourceAction';

/** ISO 时间 → YYYY-MM-DD（发布时间展示；解析失败原样返回） */
function formatPublishedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function ResourceDetailPage() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const pay = useResourcePay();
  const auth = useAuthStatus();
  const loggedIn = auth?.loggedIn === true;
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [failedImgs, setFailedImgs] = useState<Set<string>>(new Set());

  // id 解析：统一从市场 API 拉取（官方与用户上架同目录），仅拉取一次
  const [entry, setEntry] = useState<CatalogEntry | null>(null);
  useEffect(() => {
    if (entry && entry.id === id) return;
    if (!id) return; // 路由 :id 恒在；缺失防御——不发请求，保持「资源不存在」形态
    let alive = true;
    fetch(`/api/market/listings/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m: MarketListing | null) => {
        if (alive) setEntry(m ? marketToEntry(m) : null);
      })
      .catch(() => {
        /* 断网/404：保持空条目 → 「资源不存在」形态 */
      });
    return () => {
      alive = false;
    };
  }, [id, entry]);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // 路由参数切换时防止渲染上一 id 的陈旧条目
  const r = entry && entry.id === id ? entry : null;

  if (!r) {
    return (
      <div className="resources-shell">
        <div className="resources-scroll">
          <div className="resources-breadcrumb">
            <Link to="/resources" data-testid="resources-back">
              {t('resources.backToList')}
            </Link>
          </div>
          <h1 className="resources-page-title">{t('resources.notFound')}</h1>
          <div className="resources-tip-box">{t('resources.notFoundHint')}</div>
        </div>
      </div>
    );
  }

  const paid = r.price > 0;
  const previews = r.preview.map(previewUrl).filter((src) => !failedImgs.has(src));
  const overviewParas = r.overview;
  // 简介(desc)可能含多段落(空行分隔)，按空行切成段落，避免详情页被折叠成一段
  const descParas = r.desc ? r.desc.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) : [];

  const sideNote = !paid
    ? t('resources.sideNote.free')
    : PAY_BASE
      ? t('resources.sideNote.paid')
      : t('resources.sideNote.noBase');

  // 未登录：按钮文案带「登录后…」前缀（点击的登录门槛在 startResourcePurchase 内）
  const actionLabel = !paid
    ? t(loggedIn ? 'resources.downloadZip' : 'resources.downloadZipLogin')
    : PAY_BASE
      ? t(loggedIn ? 'resources.pay.wechat' : 'resources.pay.wechatLogin', { price: r.price })
      : t(loggedIn ? 'resources.buy' : 'resources.buyLogin', { price: r.price });

  const market = r.market;

  return (
    <div className="resources-shell">
      <div className="resources-scroll">
        <div className="resources-breadcrumb">
          <Link to="/resources" data-testid="resources-back">
            {t('resources.backToList')}
          </Link>
          <span className="resources-breadcrumb__sep">/</span>
          <span>{r.name}</span>
        </div>

        <div className="resources-detail-head">
          <div className="resources-icon" style={{ backgroundColor: r.tint }} aria-hidden="true">
            {r.icon}
          </div>
          <div>
            <div className="resources-detail-title">
              <h1>{r.name}</h1>
              <span className={`resources-price ${paid ? 'is-paid' : 'is-free'}`}>
                {paid ? `¥${r.price}` : t('resources.free')}
              </span>
            </div>
            <div className="resources-meta-line">{t('resources.metaLine')}</div>
            {r.tags.length > 0 && (
              <div className="resources-tags">
                {r.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="resources-detail-grid">
          <div className="resources-main">
            <h2 className="resources-section-title">{t('resources.overview')}</h2>
            <div className="resources-article">
              {descParas.map((p, i) => (
                <p key={`d${i}`} className={i === 0 ? 'resources-article__lead' : undefined}>{p}</p>
              ))}
              {overviewParas.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              {r.highlights.length > 0 && (
                <ul>
                  {r.highlights.map((h, i) => (
                    <li key={i}>
                      <strong>{h}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {previews.length > 0 && (
              <>
                <h2 className="resources-section-title">{t('resources.preview')}</h2>
                <div className="resources-preview-grid">
                  {previews.map((src) => (
                    <figure key={src}>
                      <button
                        type="button"
                        className="resources-preview-btn"
                        data-testid="resources-preview-btn"
                        onClick={() => setLightbox(src)}
                      >
                        <img
                          src={src}
                          alt={t('resources.previewAlt', { name: r.name })}
                          loading="lazy"
                          onError={() =>
                            setFailedImgs((prev) => new Set(prev).add(src))
                          }
                        />
                      </button>
                    </figure>
                  ))}
                </div>
              </>
            )}

            <h2 className="resources-section-title">{t('resources.importGuide')}</h2>
            <div className="resources-step-card">
              <ol>
                <li>{t('resources.import.step1')}</li>
                <li>{t('resources.import.step2')}</li>
                <li>{t('resources.import.step3')}</li>
              </ol>
              <Link to="/knowledge" className="resources-open-kb" data-testid="resources-open-kb">
                {t('resources.openKnowledge')} →
              </Link>
            </div>
          </div>

          <aside className="resources-side">
            <div className="resources-side-card">
              <button
                type="button"
                className="resources-buy-btn"
                data-testid={`resource-buy-${r.id}`}
                onClick={() => startResourcePurchase(r, pay.open)}
              >
                {actionLabel}
              </button>
              <p className="resources-side-note">{sideNote}</p>
            </div>
            <div className="resources-side-card">
              <div className="resources-info-row">
                <span className="k">{t('resources.info.author')}</span>
                <span className="v">{r.author}</span>
              </div>
              <div className="resources-info-row">
                <span className="k">{t('resources.info.version')}</span>
                <span className="v">{r.version}</span>
              </div>
              <div className="resources-info-row">
                    <span className="k">{t('resources.info.format')}</span>
                    <span className="v">{t('resources.info.formatValue')}</span>
                  </div>
                  <div className="resources-info-row">
                    <span className="k">{t('resources.info.compat')}</span>
                    <span className="v">{t('resources.info.compatValue')}</span>
                  </div>
                  {market?.fileSize != null && (
                    <div className="resources-info-row">
                      <span className="k">{t('resources.info.size')}</span>
                      <span className="v">{formatFileSize(market.fileSize)}</span>
                    </div>
                  )}
                  <div className="resources-info-row">
                    <span className="k">{t('resources.info.price')}</span>
                    <span className="v">{paid ? `¥${r.price}` : t('resources.free')}</span>
                  </div>
                  {market?.publishedAt != null && (
                    <div className="resources-info-row">
                      <span className="k">{t('resources.info.publishedAt')}</span>
                      <span className="v">{formatPublishedAt(market.publishedAt)}</span>
                    </div>
                  )}
            </div>
          </aside>
        </div>

        </div>

      {lightbox && (
        <div
          className="resources-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t('resources.preview')}
          data-testid="resources-lightbox"
          onClick={() => setLightbox(null)}
        >
          <button type="button" className="resources-lightbox__close" aria-label={t('common.close')}>
            ×
          </button>
          <img src={lightbox} alt={t('resources.previewAlt', { name: r.name })} />
        </div>
      )}

      {pay.phase !== 'idle' && <ResourcePayModal pay={pay} />}
    </div>
  );
}
