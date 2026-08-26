/**
 * 发布表单 —— 双外壳共享组件（modal / page 两个 variant）：
 * - variant="modal"：overlay 弹窗（PublishWizard shim 沿用，「我的上架」更新模式）。
 * - variant="page"：KB 页内独立 tab 页（首发入口）。
 *
 * AI 起草（名称/简介/标签/图标）由用户**主动点击**「AI 一键配置」触发
 * （POST /api/market/publish-suggest，见 daemon core/market/suggest.ts），
 * 打开时不自动生成；「重新生成」显式覆盖已填字段。任何失败静默回落手填，
 * 不阻断发布。图标不手选（云端要求 MARKET_ICONS 白名单值，由 AI 选定）。
 * 效果图一律用户手动上传（1-4 张，前端预检），无任何图片生成。
 *
 * 提交：元数据 + 效果图 → POST /api/market/publish。
 * 更新模式（updateListingId）：元数据只读回显、效果图可选，
 * 走 POST /api/market/listings/:id/update；vaultId 缺省时由 daemon 回退
 * market_local 本地映射（见 apps/daemon/src/routes/market.ts）。
 * 错误码优先映射 t('publish.error.' + code)，未命中回落原始码。
 *
 * modal 外壳骨架沿用 kb-modal 惯例（见 AccountModal/KbModals），overlay 用
 * publish-overlay（z-index 300，高于 vm-overlay 200 / 默认 kb-overlay 100；
 * 登录意图提层的 kb-overlay-elevated z-320 只出现在登录流程，与向导不同时出现）。
 *
 * onDirtyChange（page 宿主用）：表单有已填内容且未完成时上报 true，
 * 供关 tab 前的「放弃未发布填写」确认。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MARKET_ICONS, type MarketMyListing, type MarketPublishSuggestion } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';

export interface PublishFormProps {
  /** modal = overlay 弹窗；page = KB 页内 tab 面板 */
  variant: 'modal' | 'page';
  /** 首发必传；更新模式可省略（daemon 回退 market_local 映射） */
  vaultId?: string;
  vaultName: string;
  /** 更新模式：传入已有 listing（元数据只读回显，效果图可选） */
  updateListingId?: string;
  /** 更新模式的已有 listing，用于元数据只读回显 */
  listing?: MarketMyListing;
  onClose: () => void;
  onPublished: () => void;
  /** 填写状态变化上报（关 tab 保护用）；modal 宿主可不传 */
  onDirtyChange?: (dirty: boolean) => void;
}

const MAX_PREVIEW = 5 * 1024 * 1024;
const MAX_TAGS = 3;
const MAX_TAG_LEN = 10;

type GenPhase = 'idle' | 'loading' | 'done' | 'failed';

export function PublishForm(props: PublishFormProps) {
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

  // ── 目录选择：一级目录列表 + 默认选中 wiki 和 .molio ──
  const [topDirs, setTopDirs] = useState<string[]>([]);
  const [selectedDirs, setSelectedDirs] = useState<string[]>(['wiki', '.molio']);

  useEffect(() => {
    if (!props.vaultId || isUpdate) return;
    api.getTopDirs(props.vaultId).then((dirs) => {
      setTopDirs(dirs);
      setSelectedDirs(dirs.filter((d) => d === 'wiki' || d === '.molio'));
    }).catch(() => { /* 获取失败静默，不阻断发布 */ });
  }, [props.vaultId, isUpdate]);

  // ── AI 起草：用户主动点「AI 一键配置」才生成；已输入的内容优先
  //    （不覆盖非空字段），「重新生成」显式覆盖。任何失败静默回落手填，
  //    不阻断发布。daemon 侧是真实 agent 一次性调用（120s 超时），
  //    loading 期间防重入。 ──
  const [genPhase, setGenPhase] = useState<GenPhase>('idle');
  const overwriteRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const generateSuggestion = useCallback((overwrite: boolean) => {
    if (genPhase === 'loading') return; // 防重入：一次只跑一个 agent 调用
    overwriteRef.current = overwrite;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setGenPhase('loading');
    fetch('/api/market/publish-suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vaultId: props.vaultId ?? '' }),
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('suggest_failed');
        return (await res.json()) as MarketPublishSuggestion;
      })
      .then((sg) => {
        const ow = overwriteRef.current;
        overwriteRef.current = false;
        setName((cur) => (ow || !cur.trim() ? sg.name : cur));
        setSummary((cur) => (ow || !cur.trim() ? sg.summary : cur));
        setTags((cur) => (ow || cur.length === 0 ? sg.tags : cur));
        setIcon(sg.icon);
        setGenPhase('done');
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') setGenPhase('failed');
      });
  }, [genPhase, props.vaultId]);

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
      // 目录选择：始终传递（即使全选也不依赖默认值，保持显式语义）
      if (selectedDirs.length > 0) form.set('include', JSON.stringify(selectedDirs));
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

  // ── dirty 上报：有已填内容且未完成 → true（供关 tab 前确认）──
  const dirty = !isUpdate && phase !== 'done'
    && (name.trim() !== '' || summary.trim() !== '' || tags.length > 0 || previews.length > 0);
  const onDirtyChangeRef = useRef(props.onDirtyChange);
  onDirtyChangeRef.current = props.onDirtyChange;
  useEffect(() => { onDirtyChangeRef.current?.(dirty); }, [dirty]);

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

  const bodyContent = (
    <>
      <p className="publish-vault">{icon} {props.vaultName}</p>
      {!isUpdate && (
        <div className="publish-ai" aria-live="polite">
          {(genPhase === 'idle' || genPhase === 'failed') && (
            <>
              <button
                type="button"
                className="kb-btn kb-btn-primary publish-ai-btn"
                data-testid="publish-ai-btn"
                disabled={phase !== 'form'}
                onClick={() => generateSuggestion(false)}
              >
                {genPhase === 'failed' ? t('publish.aiRetry') : t('publish.aiConfig')}
              </button>
              <span className="publish-ai-hint">{t('publish.aiConfigHint')}</span>
              {genPhase === 'failed' && <span className="publish-ai-failed">{t('publish.aiFailed')}</span>}
            </>
          )}
          {genPhase === 'loading' && (
            <>
              <span className="publish-working-spinner publish-ai-spinner" aria-hidden="true" />
              <span>{t('publish.aiGenerating')}</span>
            </>
          )}
          {genPhase === 'done' && (
            <>
              <span>{t('publish.aiHint')}</span>
              <button
                type="button"
                className="publish-ai-regen"
                data-testid="publish-ai-regen"
                disabled={phase !== 'form'}
                onClick={() => generateSuggestion(true)}
              >
                {t('publish.aiRegenerate')}
              </button>
            </>
          )}
        </div>
      )}
      {phase === 'form' && !isUpdate && (
        <div className="publish-form">
          <label className="publish-field">
            <span>{t('publish.name')}</span>
            <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="publish-field">
            <span>{t('publish.summary')}</span>
            <textarea value={summary} maxLength={100} rows={3}
              onChange={(e) => setSummary(e.target.value)} />
          </label>
          <div className="publish-field">
            <span>{t('publish.tags')}</span>
            <div className="publish-tags" aria-label={t('publish.tags')}>
              {/* 标签由 AI 起草（≤2 个），点击移除；自定义标签同样可移除 */}
              {tags.map((tg) => (
                <button
                  key={tg}
                  type="button"
                  className="publish-tag-custom-chip is-active"
                  onClick={() => setTags((cur) => cur.filter((x) => x !== tg))}
                >
                  {tg} &times;
                </button>
              ))}
              {tags.length < MAX_TAGS && (
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
              )}
            </div>
          </div>
          {topDirs.length > 0 && (
            <div className="publish-field">
              <span>{t('publish.includeDirs')}</span>
              <div className="publish-dir-tree">
                {topDirs.map((dir) => (
                  <label key={dir} className="publish-dir-item">
                    <input type="checkbox" checked={selectedDirs.includes(dir)}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedDirs((prev) => [...prev, dir]);
                        else setSelectedDirs((prev) => prev.filter((d) => d !== dir));
                      }} />
                    <span>{dir}/</span>
                  </label>
                ))}
              </div>
            </div>
          )}
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
    </>
  );

  const footerContent = phase === 'done' ? (
    <button
      type="button"
      className="kb-btn kb-btn-primary"
      data-testid="publish-close-btn"
      onClick={props.onClose}
    >
      {t('common.close')}
    </button>
  ) : (
    <>
      <button
        type="button"
        className="kb-btn kb-btn-ghost"
        data-testid="publish-cancel-btn"
        disabled={phase === 'working'}
        onClick={props.onClose}
      >
        {t('common.cancel')}
      </button>
      <button
        type="button"
        className="kb-btn kb-btn-primary"
        data-testid="publish-submit-btn"
        disabled={phase === 'working'}
        onClick={() => void submit()}
      >
        {isUpdate ? t('publish.submitUpdate') : t('publish.submit')}
      </button>
    </>
  );

  if (props.variant === 'page') {
    return (
      <div className="kb-publish-pane" data-testid="kb-publish-pane">
        <div className="kb-publish-pane-head">
          <h2>{t('publish.title')}</h2>
        </div>
        <div className="kb-modal-body publish-body kb-publish-pane-body">
          {bodyContent}
        </div>
        <div className="kb-modal-footer publish-footer kb-publish-pane-footer">
          {footerContent}
        </div>
      </div>
    );
  }

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
          {bodyContent}
        </div>
        <div className="kb-modal-footer publish-footer">
          {footerContent}
        </div>
      </div>
    </div>
  );
}
