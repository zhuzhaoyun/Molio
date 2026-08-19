// apps/web/src/components/SessionOutputPanel.tsx
// 会话产出聚合面板（主页 dock）——本次会话 Molio 写入的 KB 文件 rollup。
// 与逐消息 WorkCompleteBanner/SourceChips 共存：dock = 会话级汇总，消息内 = 单条 provenance
// （外部引用只在消息内联的 SourceChips 展示，不在此重复）。
// 纯前端聚合（aggregateSessionOutput），零 daemon/contracts。
import { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import type { ChatMessage } from '../hooks/useChat';
import { aggregateSessionOutput } from '../utils/workSteps';
import { useActiveVaultId } from '../stores/vaultStore';
import { useI18n } from '../i18n';
import { api } from '../api/client';
import { MdRenderer } from './kb/MdRenderer';

/** dock 宽度：默认 280，可拖宽 200–480 并持久化（复用 KbChatSessionsPanel 存储模式） */
const DOCK_W_DEFAULT = 280;
const DOCK_W_MIN = 200;
const DOCK_W_MAX = 480;
const STORAGE_KEY_WIDTH = 'molio.home-dock-w';

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

export function SessionOutputPanel({ messages }: Props) {
  const { t } = useI18n();
  const output = useMemo(() => aggregateSessionOutput(messages), [messages]);
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
              <MdRenderer content={preview.content} className="session-output-preview" />
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
          </header>

          {empty ? (
            <p className="session-output-empty" data-testid="session-output-empty">{t('output.empty')}</p>
          ) : (
            <div className="session-output-body">
              {output.writes.length > 0 && (
                <section className="session-output-section">
                  <h3 className="session-output-section-label">{t('output.writesLabel')}</h3>
                  {output.writes.map((w) => (
                    <button
                      key={w.path}
                      type="button"
                      className="session-output-item"
                      data-testid="session-output-write"
                      data-kind={w.kind}
                      title={w.path}
                      disabled={!vaultId}
                      onClick={() => openPreview(w.kind, w.path, w.label)}
                    >
                      <span className="session-output-item-icon" aria-hidden>{w.kind === 'create' ? '＋' : '✎'}</span>
                      <span className="session-output-item-label">{w.label}</span>
                    </button>
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
