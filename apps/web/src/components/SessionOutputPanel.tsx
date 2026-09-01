// apps/web/src/components/SessionOutputPanel.tsx
// 会话产出聚合面板（主页 dock）——本次会话 Molio 写入的 KB 文件 rollup。
// 与逐消息 WorkCompleteBanner/SourceChips 共存：dock = 会话级汇总，消息内 = 单条 provenance
// （外部引用只在消息内联的 SourceChips 展示，不在此重复）。
// 纯前端聚合（aggregateSessionOutput），零 daemon/contracts。
import { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import type { ChatMessage } from '../hooks/useChat';
import { aggregateSessionOutput, extractChanges, disambiguateLabels, type ChangeEntry } from '../utils/workSteps';
import type { DiffLine } from '../utils/diff';
import { useActiveVault, useActiveVaultId } from '../stores/vaultStore';
import { useI18n } from '../i18n';
import { api } from '../api/client';
import { MdRenderer } from './kb/MdRenderer';

/** dock 宽度：默认 280，可拖宽 200–480 并持久化（复用 KbChatSessionsPanel 存储模式） */
const DOCK_W_DEFAULT = 280;
const DOCK_W_MIN = 200;
const DOCK_W_MAX = 480;
const STORAGE_KEY_WIDTH = 'molio.home-dock-w';

/** Markdown 文件走富文本渲染；其余文本（.py/.json/.csv…）用等宽代码视图，避免被 md 语法吞掉。 */
function isMarkdownPath(p: string): boolean {
  return /(\.mdown|\.markdown|\.md)$/i.test(p);
}

/** 变更序列按 path 分组（保持首次出现的路径顺序，同 path 的多条改动原序）。 */
function groupChangesByPath(changes: ChangeEntry[]): { path: string; label: string; items: ChangeEntry[] }[] {
  const order: string[] = [];
  const map = new Map<string, { label: string; items: ChangeEntry[] }>();
  for (const c of changes) {
    let g = map.get(c.path);
    if (!g) {
      g = { label: c.label, items: [] };
      map.set(c.path, g);
      order.push(c.path);
    }
    g.items.push(c);
  }
  return order.map((p) => ({ path: p, label: map.get(p)!.label, items: map.get(p)!.items }));
}

/** 变更 tab 的单条 diff 行：type 前缀 + 行内容（等宽，280px dock 内宜读）。 */
function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <span className={`session-output-diff-line is-${line.type}`} data-testid={`session-output-diff-${line.type}`}>
      <span className="session-output-diff-mark" aria-hidden>{line.type === 'add' ? '+' : '−'}</span>
      <span className="session-output-diff-text">{line.text || ' '}</span>
    </span>
  );
}

function clampDockWidth(w: number): number {
  return Math.min(DOCK_W_MAX, Math.max(DOCK_W_MIN, Math.round(w)));
}
function readDockWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampDockWidth(n);
    }
  } catch { /* storage unavailable */ }
  return DOCK_W_DEFAULT;
}

interface Props {
  messages: ChatMessage[];
}

type PanelTab = 'overview' | 'changes';

export function SessionOutputPanel({ messages }: Props) {
  const { t } = useI18n();
  const activeVault = useActiveVault();
  const output = useMemo(
    () => aggregateSessionOutput(messages, activeVault?.path),
    [messages, activeVault?.path],
  );
  // 变更序列（同上，纯派生）：同一文件的多次改动并列，不按 path 去重。
  const changes = useMemo(() => {
    const cs = extractChanges(messages, activeVault?.path);
    disambiguateLabels(cs);
    return groupChangesByPath(cs);
  }, [messages, activeVault?.path]);
  const [tab, setTab] = useState<PanelTab>('overview');
  // 变更 tab 的手风琴：单开（点开一个收起其它），null = 全部折叠
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  // 概览统计条：新建/更新来自去重后的写入清单，追加来自变更序列
  const creates = output.writes.filter((w) => w.kind === 'create').length;
  const updates = output.writes.filter((w) => w.kind === 'update').length;
  const appends = changes.reduce((n, g) => n + g.items.filter((c) => c.kind === 'append').length, 0);
  // 早期会话判定：有 assistant 消息但整段对话没有任何过程数据（tools/thinking
  // 均未持久化的旧数据）→ 空态下附提示，避免误读为「丢了产出」的 bug。
  const legacyConversation = useMemo(
    () =>
      messages.some((m) => m.role === 'assistant')
        && !messages.some((m) => (m.tools?.length ?? 0) > 0 || !!m.thinking),
    [messages],
  );
  const vaultId = useActiveVaultId();

  const [width, setWidth] = useState<number>(readDockWidth);
  const panelElRef = useRef<HTMLDivElement>(null);
  // 拖动中真值源：释放时从 ref 提交，不依赖 el.style.width（KbChatSessionsPanel 教训）
  const dragWidthRef = useRef<number | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const commitWidth = useCallback((w: number) => {
    const clamped = clampDockWidth(w);
    setWidth(clamped);
    try { localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped)); } catch { /* storage unavailable */ }
  }, []);
  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = panelElRef.current;
    if (!el) return;
    dragRef.current = { startX: e.clientX, startWidth: el.offsetWidth };
    const handle = e.currentTarget;
    handle.classList.add('is-dragging');
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('home-dock-resizing');
  }, []);
  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = panelElRef.current;
    if (!d || !el) return;
    const w = clampDockWidth(d.startWidth + (d.startX - e.clientX));
    dragWidthRef.current = w; // 真值源
    el.style.width = `${w}px`;
  }, []);
  const onResizePointerEnd = useCallback(() => {
    const el = panelElRef.current;
    dragRef.current = null;
    if (el) {
      const w = clampDockWidth(dragWidthRef.current ?? width);
      dragWidthRef.current = null;
      el.style.width = `${w}px`;
      commitWidth(w);
    }
    document.body.classList.remove('home-dock-resizing');
  }, [width, commitWidth]);
  const onResizeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); commitWidth(width - 20); }
    if (e.key === 'ArrowRight') { e.preventDefault(); commitWidth(width + 20); }
  }, [width, commitWidth]);

  const empty = output.writes.length === 0;

  // 内嵌预览：点击写入项 → 面板切到预览视图（不跳转知识库，保持对话注意力）。
  const [preview, setPreview] = useState<{
    target: { kind: 'create' | 'update'; path: string; label: string };
    content: string;
    loading: boolean;
    error: boolean;
    tooLarge: boolean;
  } | null>(null);

  // 预览加载：进入（path 从 undefined→有值）触发一次；同项重复进入不重跑；
  // 返回（置 null）cleanup 取消 in-flight。loading 用 updater 置，避免竞态残留。
  useEffect(() => {
    const target = preview?.target;
    if (!target || !vaultId) return;
    let cancelled = false;
    setPreview((p) => (p ? { ...p, loading: true, error: false, tooLarge: false } : p));
    api.readFile(vaultId, target.path)
      .then((f) => {
        if (cancelled) return;
        setPreview({ target, content: f.content, loading: false, error: false, tooLarge: Boolean(f.tooLarge) });
      })
      .catch(() => {
        if (cancelled) return;
        setPreview((p) => (p ? { ...p, loading: false, error: true } : p));
      });
    return () => { cancelled = true; };
  }, [preview?.target.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPreview = useCallback((kind: 'create' | 'update', path: string, label: string) => {
    if (!vaultId) return;
    if (width < 420) commitWidth(420); // 预览态自动加宽到 md 渲染舒适宽度；返回不缩回
    setPreview({ target: { kind, path, label }, content: '', loading: false, error: false, tooLarge: false });
  }, [vaultId, width, commitWidth]);

  const closePreview = useCallback(() => setPreview(null), []);

  return (
    <aside
      ref={panelElRef}
      className="session-output-panel"
      data-testid="session-output-panel"
      style={{ width }}
    >
      {preview ? (
        <>
          <header className="session-output-preview-header">
            <button
              type="button"
              className="session-output-preview-back"
              data-testid="session-output-preview-back"
              onClick={closePreview}
              title={t('output.previewBack')}
            >
              <span aria-hidden>{'‹'}</span>
              <span>{t('output.previewBack')}</span>
            </button>
            <span className="session-output-preview-filename" title={preview.target.path}>
              {preview.target.label}
            </span>
          </header>
          <div className="session-output-preview-body" data-testid="session-output-preview">
            {preview.loading && <p className="session-output-preview-note">{t('output.previewLoading')}</p>}
            {!preview.loading && preview.error && <p className="session-output-preview-note">{t('output.previewError')}</p>}
            {!preview.loading && !preview.error && preview.tooLarge && (
              <p className="session-output-preview-note">{t('output.previewTooLarge')}</p>
            )}
            {!preview.loading && !preview.error && !preview.tooLarge && preview.content === '' && (
              <p className="session-output-preview-note">{t('output.previewBinary')}</p>
            )}
            {!preview.loading && !preview.error && !preview.tooLarge && preview.content !== '' && (
              isMarkdownPath(preview.target.path)
                ? <MdRenderer content={preview.content} className="session-output-preview" />
                : <pre className="session-output-preview-code">{preview.content}</pre>
            )}
          </div>
        </>
      ) : (
        <>
          <header className="session-output-header">
            <span className="session-output-title">{t('output.title')}</span>
            <span className="session-output-stats" data-testid="session-output-stats">
              {t('output.stats', { writes: output.writes.length, turns: output.turns })}
            </span>
            {/* 分段控制：概览 / 变更（WorkBuddy 式多投影；280px dock 用分段而非下拉） */}
            <nav className="session-output-tabs" role="tablist" aria-label={t('output.title')}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'overview'}
                className={`session-output-tab${tab === 'overview' ? ' is-active' : ''}`}
                data-testid="session-output-tab-overview"
                onClick={() => setTab('overview')}
              >
                {t('output.tabOverview')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'changes'}
                className={`session-output-tab${tab === 'changes' ? ' is-active' : ''}`}
                data-testid="session-output-tab-changes"
                onClick={() => setTab('changes')}
              >
                {t('output.tabChanges')}
                {changes.length > 0 && <span className="session-output-tab-count">{changes.length}</span>}
              </button>
            </nav>
          </header>

          {tab === 'changes' ? (
            /* ── 变更 tab：文件级概要行（±行数）→ 点击展开逐条 diff（WorkBuddy 式两级） ── */
            <div className="session-output-body" data-testid="session-output-changes">
              {changes.length === 0 ? (
                <p className="session-output-empty">{t('output.changesEmpty')}</p>
              ) : (
                changes.map((g) => {
                  const adds = g.items.reduce((n, c) => n + (c.adds ?? 0), 0);
                  const dels = g.items.reduce((n, c) => n + (c.dels ?? 0), 0);
                  const expanded = expandedPath === g.path;
                  return (
                    <section key={g.path} className="session-output-changes-group" data-testid="session-output-change-group">
                      <button
                        type="button"
                        className="session-output-changes-file"
                        data-testid="session-output-change-file"
                        aria-expanded={expanded}
                        title={g.path}
                        onClick={() => setExpandedPath(expanded ? null : g.path)}
                      >
                        <span className="session-output-changes-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
                        <span className="session-output-changes-file-label">{g.label}</span>
                        <span className="session-output-changes-count">
                          {adds + dels > 0 && (
                            <>
                              <b className="is-add">+{adds}</b>
                              {dels > 0 && <b className="is-del">−{dels}</b>}
                            </>
                          )}
                        </span>
                        {g.items.length > 1 && <span className="session-output-changes-file-count">×{g.items.length}</span>}
                      </button>
                      {expanded && g.items.map((c, i) => (
                        <div key={`${c.toolId}-${i}`} className="session-output-change" data-testid="session-output-change">
                          <div className="session-output-change-meta">
                            <span className={`session-output-change-kind is-${c.kind}`}>
                              {t(`output.changeKind.${c.kind}`)}
                            </span>
                            <button
                              type="button"
                              className="session-output-item-locate"
                              data-testid="session-output-change-locate"
                              title={t('output.locate')}
                              aria-label={t('output.locate')}
                              onClick={() => {
                                window.dispatchEvent(new CustomEvent('molio:evidence-target', {
                                  detail: { toolId: c.toolId, messageId: c.messageId },
                                }));
                              }}
                            >
                              <span aria-hidden>⌖</span>
                            </button>
                          </div>
                          {c.diff && c.diff.length > 0 ? (
                            <div className="session-output-diff" data-testid="session-output-diff">
                              {c.diff.map((l, li) => <DiffLineRow key={li} line={l} />)}
                            </div>
                          ) : (
                            <p className="session-output-change-note">
                              {c.placeholder === 'write-new-file' && t('output.writeNewFile')}
                              {c.placeholder === 'write-overwrite' && t('output.writeOverwrite')}
                              {c.placeholder === 'append-file' && t('output.appendFile')}
                              {c.placeholder === 'edit-no-source' && t('output.editNoSource')}
                              {c.placeholder === 'diff-truncated' && t('output.diffTruncated')}
                            </p>
                          )}
                        </div>
                      ))}
                    </section>
                  );
                })
              )}
            </div>
          ) : empty ? (
            <>
              <p className="session-output-empty" data-testid="session-output-empty">{t('output.empty')}</p>
              {legacyConversation && (
                <p className="session-output-legacy-hint" data-testid="session-output-legacy-hint">
                  {t('output.legacyHint')}
                </p>
              )}
            </>
          ) : (
            <div className="session-output-body">
              {output.writes.length > 0 && (
                <section className="session-output-section">
                  {/* 概览统计条：新建 / 更新 / 追加（纯前端聚合，WorkBuddy 概览式读数） */}
                  <div className="session-output-statbar" data-testid="session-output-statbar">
                    {creates > 0 && (
                      <span className="session-output-stat" data-testid="session-output-stat-creates">
                        {t('output.statCreates')} <b>{creates}</b>
                      </span>
                    )}
                    {updates > 0 && (
                      <span className="session-output-stat" data-testid="session-output-stat-updates">
                        {t('output.statUpdates')} <b>{updates}</b>
                      </span>
                    )}
                    {appends > 0 && (
                      <span className="session-output-stat" data-testid="session-output-stat-appends">
                        {t('output.statAppends')} <b>{appends}</b>
                      </span>
                    )}
                  </div>
                  <h3 className="session-output-section-label">{t('output.writesLabel')}</h3>
                  {output.writes.map((w) => (
                    <div
                      key={w.path}
                      role="button"
                      tabIndex={0}
                      className="session-output-item"
                      data-testid="session-output-write"
                      data-kind={w.kind}
                      data-path={w.path}
                      title={w.path}
                      onClick={() => { if (vaultId) openPreview(w.kind, w.path, w.label); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (vaultId) openPreview(w.kind, w.path, w.label);
                        }
                      }}
                    >
                      <span className="session-output-item-icon" aria-hidden>{w.kind === 'create' ? '＋' : '✎'}</span>
                      <span className="session-output-item-label">{w.label}</span>
                      <button
                        type="button"
                        className="session-output-item-locate"
                        data-testid="session-output-locate"
                        title={t('output.locate')}
                        aria-label={t('output.locate')}
                        onClick={(e) => {
                          e.stopPropagation();
                          window.dispatchEvent(new CustomEvent('molio:evidence-target', {
                            detail: { toolId: w.toolId, messageId: w.messageId },
                          }));
                        }}
                      >
                        <span aria-hidden>⌖</span>
                      </button>
                    </div>
                  ))}
                </section>
              )}
            </div>
          )}
        </>
      )}

      {/* 拖宽手柄：dock 左缘 8px 命中区，复用 KbChatSessionsPanel resize-handle 模式 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('output.toggle')}
        tabIndex={0}
        className="session-output-resize-handle"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
        onKeyDown={onResizeKeyDown}
      />
    </aside>
  );
}
