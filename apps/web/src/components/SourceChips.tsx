// apps/web/src/components/SourceChips.tsx
// 引用来源 —— 助手回复底部的地基证据条（引用文件 / 外部 URL）。
//
// 两种形态（按来源数量切换）：
// - 平铺（≤ FLAT_LIMIT）：一行 chip，与旧形态一致 —— 轻场景零变化。
// - 台账（> FLAT_LIMIT）：「引用 N 项」标题行（整条可折叠）+ 可查证层
//   （库内文档 / 外部链接，chip）+ 其余层（媒体数据 / 索引日志 / 库外 / 检索模式，
//   各自一行计数，按需展开）。
//   wiki 构建这类一轮读上百个文件的长回复，噪音被压进「其余」各行，
//   主列表只剩真正能查证的文档。
import { useMemo, useState } from 'react';
import type { ToolEvent } from '../hooks/useChatCore';
import { groupInlineSources, type InlineBucket, type InlineSourceItem } from '../utils/inlineSources';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useActiveVault, useActiveVaultId } from '../stores/vaultStore';
import { useI18n } from '../i18n';
import { FileIcon, ExternalLinkIcon, ChevronIcon } from './icons';

interface Props {
  tools: ToolEvent[];
}

/** ≤ 此数量保持平铺（轻场景与旧形态逐像素一致） */
const FLAT_LIMIT = 8;
/** 台账里每层最多直接铺出的条目数，超出折叠 */
const PAGE_LIMIT = 12;

/** 其余层的构成顺序：先「产物」，再「过程痕迹」，最后「不可打开的」 */
const BUCKET_ORDER: InlineBucket[] = ['media', 'meta', 'outside', 'pattern'];

export function SourceChips({ tools }: Props) {
  const { t } = useI18n();
  // vaultId 用 store 的 id（列表未加载时也有值 —— 旧行为如此）；
  // vaultPath 只用来判「库内/库外」与归一化路径，列表未加载时为 null → 不判库外（保守）。
  const vaultId = useActiveVaultId();
  const activeVault = useActiveVault();
  const vaultPath = activeVault?.path ?? null;
  const { openFile } = useFileNavigation();

  const sources = useMemo(
    () => groupInlineSources(tools, { vaultPath }),
    [tools, vaultPath],
  );
  const [folded, setFolded] = useState(false);
  const [allPrimary, setAllPrimary] = useState(false);
  const [openBuckets, setOpenBuckets] = useState<Set<InlineBucket>>(new Set());
  const [fullBuckets, setFullBuckets] = useState<Set<InlineBucket>>(new Set());

  if (sources.total === 0) return null;

  const open = (item: InlineSourceItem) => {
    if (item.kind === 'url') {
      window.open(item.path, '_blank');
      return;
    }
    if (item.navigable && vaultId) openFile(vaultId, item.path);
  };

  const chip = (item: InlineSourceItem) => (
    <button
      key={item.key}
      type="button"
      className="source-chip"
      data-testid="source-chip"
      data-kind={item.kind}
      title={item.path}
      disabled={item.kind !== 'url' && (!item.navigable || !vaultId)}
      onClick={() => open(item)}
    >
      <span className="source-chip-icon" aria-hidden>
        {item.kind === 'url' ? <ExternalLinkIcon size={12} /> : <FileIcon size={12} />}
      </span>
      <span className="source-chip-label">{item.label}</span>
    </button>
  );

  // ── 平铺形态：≤ FLAT_LIMIT，与旧形态一致 ──────────────────────────
  if (sources.total <= FLAT_LIMIT) {
    return (
      <div className="source-chips" data-testid="source-chips">
        <span className="source-chips-title">{t('source.title')}</span>
        {sources.ordered.map(chip)}
      </div>
    );
  }

  // ── 台账形态：> FLAT_LIMIT ────────────────────────────────────────
  const primaryShown = allPrimary ? sources.primary : sources.primary.slice(0, PAGE_LIMIT);
  const primaryHidden = sources.primary.length - primaryShown.length;

  const buckets = BUCKET_ORDER.map((bucket) => ({
    bucket,
    items: sources.minor.filter((i) => i.bucket === bucket),
  })).filter((g) => g.items.length > 0);

  const toggleBucket = (bucket: InlineBucket) =>
    setOpenBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });

  return (
    <div className="source-chips source-chips--ledger" data-testid="source-chips">
      <button
        type="button"
        className="source-ledger-head"
        data-testid="source-ledger-head"
        aria-expanded={!folded}
        onClick={() => setFolded((f) => !f)}
      >
        <span className="source-chips-title">{t('source.title')}</span>
        <span className="source-ledger-count">{t('source.count', { n: sources.total })}</span>
        <ChevronIcon size={12} className={`source-ledger-caret${folded ? ' is-folded' : ''}`} />
      </button>

      {!folded && (
        <div className="source-ledger-body">
          {sources.primary.length > 0 && (
            <div className="source-ledger-group">
              <div className="source-ledger-items">{primaryShown.map(chip)}</div>
              {primaryHidden > 0 && (
                <button
                  type="button"
                  className="source-ledger-more"
                  data-testid="source-ledger-more-primary"
                  onClick={() => setAllPrimary(true)}
                >
                  {t('source.showAll', { n: primaryHidden })}
                </button>
              )}
            </div>
          )}

          {buckets.length > 0 && (
            <div className="source-ledger-group source-ledger-group--minor">
              {buckets.map(({ bucket, items }) => {
                const isOpen = openBuckets.has(bucket);
                // 展开后先铺 PAGE_LIMIT 条，再由「还有 N 项」铺开剩下的
                const shown = isOpen && fullBuckets.has(bucket) ? items : items.slice(0, PAGE_LIMIT);
                const hidden = isOpen ? items.length - shown.length : 0;
                return (
                  <div key={bucket} className="source-ledger-bucket">
                    <button
                      type="button"
                      className="source-ledger-bucket-head"
                      data-testid={`source-ledger-bucket-${bucket}`}
                      aria-expanded={isOpen}
                      onClick={() => toggleBucket(bucket)}
                    >
                      <span className="source-ledger-bucket-name">{t(`source.bucket.${bucket}`)}</span>
                      <span className="source-ledger-bucket-count">{items.length}</span>
                      <ChevronIcon size={11} className={`source-ledger-caret${isOpen ? '' : ' is-folded'}`} />
                    </button>
                    {isOpen && (
                      <div className="source-ledger-items source-ledger-items--minor">
                        {shown.map((item) =>
                          item.navigable ? (
                            <button
                              key={item.key}
                              type="button"
                              className="source-minor-item"
                              data-testid="source-minor-item"
                              title={item.path}
                              onClick={() => open(item)}
                            >
                              {item.label}
                            </button>
                          ) : (
                            <span
                              key={item.key}
                              className="source-minor-item is-static"
                              data-testid="source-minor-item"
                              title={item.path}
                            >
                              {item.label}
                            </span>
                          ),
                        )}
                        {hidden > 0 && (
                          <button
                            type="button"
                            className="source-ledger-more"
                            data-testid="source-ledger-more-bucket"
                            onClick={() => setFullBuckets((prev) => new Set(prev).add(bucket))}
                          >
                            {t('source.more', { n: hidden })}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
