/**
 * 发布向导 —— 元数据 + 效果图 + 公开声明 → POST /api/market/publish。
 *
 * 更新模式（updateListingId）：元数据只读回显、效果图可选，
 * 走 POST /api/market/listings/:id/update；vaultId 缺省时由 daemon 回退
 * market_local 本地映射（见 apps/daemon/src/routes/market.ts）。
 *
 * 效果图前端预检：PNG/JPEG/WebP、单张 ≤5MB、1-4 张。
 * 错误码优先映射 t('publish.error.' + code)，未命中回落原始码。
 * 弹层骨架沿用 kb-modal 惯例（见 AccountModal/KbModals），overlay 用
 * publish-overlay（z-index 300，高于 vm-overlay 200 / 默认 kb-overlay 100；
 * 登录意图提层的 kb-overlay-elevated z-320 只出现在登录流程，与向导不同时出现）。
 */
import { useEffect, useMemo, useState } from 'react';
import { MARKET_ICONS, MARKET_TAGS, type MarketMyListing } from '@molio/contracts';
import { useI18n } from '../../i18n';

export interface PublishWizardProps {
  /** 首发必传；更新模式可省略（daemon 回退 market_local 映射） */
  vaultId?: string;
  vaultName: string;
  /** 更新模式：传入已有 listing（元数据只读回显，效果图可选） */
  updateListingId?: string;
  /** 更新模式的已有 listing，用于元数据只读回显 */
  listing?: MarketMyListing;
  onClose: () => void;
  onPublished: () => void;
}

const MAX_PREVIEW = 5 * 1024 * 1024;
const MAX_TAGS = 3;
const MAX_TAG_LEN = 10;

export function PublishWizard(props: PublishWizardProps) {
  const { t } = useI18n();
  const isUpdate = props.updateListingId !== undefined;
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [icon, setIcon] = useState<string>(MARKET_ICONS[0]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState(''); // 自定义标签输入
  const [previews, setPreviews] = useState<File[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<'form' | 'working' | 'done'>('form');
  const [error, setError] = useState<string | null>(null);

  // 效果图缩略图 Object URL：随 previews 统一派生，变化/卸载时释放
  const previewUrls = useMemo(() => previews.map((f) => URL.createObjectURL(f)), [previews]);
  useEffect(() => () => { for (const u of previewUrls) URL.revokeObjectURL(u); }, [previewUrls]);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const next = [...previews];
    for (const f of files) {
      if (next.length >= 4) break;
      if (f.size > MAX_PREVIEW || !/^image\/(png|jpe?g|webp)$/.test(f.type)) {
        setError(t('publish.error.previewInvalid'));
        continue;
      }
      next.push(f);
    }
    setPreviews(next);
  };

  /** 错误码 → i18n 文案；未命中回落原值。非错误码文案（浏览器网络异常等）按网络异常处理。 */
  const mapError = (raw: string): string => {
    const key = `publish.error.${raw}`;
    const mapped = t(key);
    if (mapped !== key) return mapped;
    if (!/^[a-z][a-z0-9_]*$/.test(raw)) return t('publish.error.cloud_unreachable');
    return raw;
  };

  const submit = async () => {
    setError(null);
    if (!isUpdate) {
      if (!name.trim() || !summary.trim()) { setError(t('publish.error.required')); return; }
      if (previews.length < 1) { setError(t('publish.error.previewRequired')); return; }
      if (!agreed) { setError(t('publish.error.agreement')); return; }
    }
    setPhase('working');
    const form = new FormData();
    if (props.vaultId) form.set('vaultId', props.vaultId);
    if (!isUpdate) {
      form.set('name', name.trim());
      form.set('summary', summary.trim());
      form.set('icon', icon);
      form.set('tags', JSON.stringify(tags));
    }
    // 更新模式效果图可选：不传即沿用旧图（daemon 侧语义）
    previews.forEach((f) => form.append('previews', f));
    const url = isUpdate
      ? `/api/market/listings/${props.updateListingId}/update`
      : '/api/market/publish';
    try {
      const res = await fetch(url, { method: 'POST', body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'publish_failed');
      }
      setPhase('done');
      props.onPublished();
    } catch (e) {
      setPhase('form');
      setError(mapError((e as Error).message));
    }
  };

  const previewGrid = (
    <div className="publish-preview-grid">
      {previews.map((file, i) => (
        <span key={file.name + i} className="publish-preview-item">
          <img src={previewUrls[i]} alt={file.name} />
          <button
            type="button"
            aria-label={t('publish.removePreview')}
            onClick={() => setPreviews(previews.filter((_, j) => j !== i))}
          >
            &times;
          </button>
        </span>
      ))}
      {previews.length < 4 && (
        <label className="publish-preview-add">
          +
          <input
            type="file"
            accept=".png,.jpg,.jpeg,.webp"
            multiple
            hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
        </label>
      )}
    </div>
  );

  return (
    <div
      className="publish-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== 'working') props.onClose();
      }}
    >
      <div className="kb-modal publish-modal">
        <div className="kb-modal-header">
          <h2>{t('publish.title')}</h2>
          <button
            type="button"
            className="kb-modal-close"
            aria-label={t('common.close')}
            disabled={phase === 'working'}
            onClick={props.onClose}
          >
            &times;
          </button>
        </div>
        <div className="kb-modal-body publish-body">
          <p className="publish-vault">{props.vaultName}</p>
          {phase === 'form' && !isUpdate && (
            <div className="publish-form">
              <label className="publish-field">
                <span>{t('publish.name')}</span>
                <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="publish-field">
                <span>{t('publish.summary')}</span>
                <input value={summary} maxLength={100} onChange={(e) => setSummary(e.target.value)} />
              </label>
              <div className="publish-field">
                <span>{t('publish.icon')}</span>
                <div className="publish-icons" aria-label={t('publish.icon')}>
                  {MARKET_ICONS.map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      className={icon === ic ? 'is-active' : ''}
                      onClick={() => setIcon(ic)}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
              </div>
              <div className="publish-field">
                <span>{t('publish.tags')}</span>
                <div className="publish-tags" aria-label={t('publish.tags')}>
                  {MARKET_TAGS.map((tg) => (
                    <button
                      key={tg}
                      type="button"
                      className={tags.includes(tg) ? 'is-active' : ''}
                      onClick={() => setTags((cur) => (cur.includes(tg)
                        ? cur.filter((x) => x !== tg)
                        : cur.length < MAX_TAGS ? [...cur, tg] : cur))}
                    >
                      {tg}
                    </button>
                  ))}
                  {/* 自定义标签渲染为可移除 chip */}
                  {tags.filter((tg) => !(MARKET_TAGS as readonly string[]).includes(tg)).map((tg) => (
                    <button
                      key={tg}
                      type="button"
                      className="publish-tag-custom-chip is-active"
                      onClick={() => setTags((cur) => cur.filter((x) => x !== tg))}
                    >
                      {tg} &times;
                    </button>
                  ))}
                  <input
                    className="publish-tag-custom"
                    value={tagInput}
                    maxLength={MAX_TAG_LEN}
                    placeholder={t('publish.customTag')}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      const v = tagInput.trim();
                      if (v && !tags.includes(v) && tags.length < MAX_TAGS) setTags((cur) => [...cur, v]);
                      setTagInput('');
                    }}
                  />
                </div>
              </div>
              <div className="publish-previews">
                <p>{t('publish.previews')}</p>
                {previewGrid}
              </div>
              <label className="publish-agreement">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>{t('publish.agreement')}</span>
              </label>
              <a className="publish-paid-cta" href="https://molio.cn/enterprise.html#contact" target="_blank" rel="noopener noreferrer">
                {t('publish.paidCta')}
              </a>
            </div>
          )}
          {phase === 'form' && isUpdate && (
            <div className="publish-form">
              {props.listing && (
                <div className="publish-meta">
                  <div className="publish-meta-row">
                    <span className="k">{t('publish.name')}</span>
                    <span className="v">{props.listing.icon} {props.listing.name}</span>
                  </div>
                  <div className="publish-meta-row">
                    <span className="k">{t('publish.summary')}</span>
                    <span className="v">{props.listing.summary}</span>
                  </div>
                  {props.listing.tags.length > 0 && (
                    <div className="publish-meta-row">
                      <span className="k">{t('publish.tags')}</span>
                      <span className="v">{props.listing.tags.join(' · ')}</span>
                    </div>
                  )}
                  <div className="publish-meta-row">
                    <span className="k">{t('resources.info.version')}</span>
                    <span className="v">{props.listing.version}</span>
                  </div>
                </div>
              )}
              <div className="publish-previews">
                <p>{t('publish.previewsUpdate')}</p>
                {previewGrid}
              </div>
              <label className="publish-agreement">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>{t('publish.agreement')}</span>
              </label>
              <a className="publish-paid-cta" href="https://molio.cn/enterprise.html#contact" target="_blank" rel="noopener noreferrer">
                {t('publish.paidCta')}
              </a>
            </div>
          )}
          {phase === 'working' && (
            <div className="publish-working">
              <span className="publish-working-spinner" aria-hidden="true" />
              <p>{t('publish.working')}</p>
            </div>
          )}
          {phase === 'done' && (
            <div className="publish-done">
              <p>{t('publish.done')}</p>
            </div>
          )}
          {error && <p className="publish-error">{error}</p>}
        </div>
        <div className="kb-modal-footer publish-footer">
          {phase === 'done' ? (
            <button type="button" className="kb-btn kb-btn-primary" onClick={props.onClose}>
              {t('common.close')}
            </button>
          ) : (
            <>
              <button type="button" className="kb-btn kb-btn-ghost" disabled={phase === 'working'} onClick={props.onClose}>
                {t('common.cancel')}
              </button>
              <button type="button" className="kb-btn kb-btn-primary" disabled={phase === 'working'} onClick={() => void submit()}>
                {isUpdate ? t('publish.submitUpdate') : t('publish.submit')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
