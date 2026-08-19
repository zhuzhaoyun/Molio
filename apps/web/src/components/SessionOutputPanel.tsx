// apps/web/src/components/SessionOutputPanel.tsx
// 会话产出聚合面板（主页 dock）——整个会话写入的 KB 文件 + 引用的来源 rollup。
// 与逐消息 WorkCompleteBanner/SourceChips 共存：dock = 会话级汇总，消息内 = 单条 provenance。
// 纯前端聚合（aggregateSessionOutput），零 daemon/contracts。
import { useMemo, useState, useRef, useCallback } from 'react';
import type { ChatMessage } from '../hooks/useChat';
import { aggregateSessionOutput } from '../utils/workSteps';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useActiveVaultId } from '../stores/vaultStore';
import { useI18n } from '../i18n';
import { FileIcon, ExternalLinkIcon } from './icons';

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
  const { openFile } = useFileNavigation();

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

  const empty = output.writes.length === 0 && output.sources.length === 0;

  return (
    <aside
      ref={panelElRef}
      className="session-output-panel"
      data-testid="session-output-panel"
      style={{ width }}
    >
      <header className="session-output-header">
        <span className="session-output-title">{t('output.title')}</span>
        <span className="session-output-stats" data-testid="session-output-stats">
          {t('output.stats', { writes: output.writes.length, sources: output.sources.length, turns: output.turns })}
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
                  title={w.path}
                  disabled={!vaultId}
                  onClick={() => { if (vaultId) openFile(vaultId, w.path); }}
                >
                  <span className="session-output-item-icon" aria-hidden>{w.kind === 'create' ? '＋' : '✎'}</span>
                  <span className="session-output-item-label">{w.label}</span>
                </button>
              ))}
            </section>
          )}
          {output.sources.length > 0 && (
            <section className="session-output-section">
              <h3 className="session-output-section-label">{t('output.sourcesLabel')}</h3>
              {output.sources.map((s) => (
                <button
                  key={s.target}
                  type="button"
                  className="session-output-item"
                  data-testid="session-output-source"
                  data-kind={s.kind}
                  title={s.target}
                  disabled={s.kind !== 'url' && (!s.navigable || !vaultId)}
                  onClick={() => {
                    if (s.kind === 'url') { window.open(s.target, '_blank'); return; }
                    if (s.navigable && vaultId) openFile(vaultId, s.target);
                  }}
                >
                  <span className="session-output-item-icon" aria-hidden>
                    {s.kind === 'url' ? <ExternalLinkIcon size={13} /> : <FileIcon size={13} />}
                  </span>
                  <span className="session-output-item-label">{s.label}</span>
                </button>
              ))}
            </section>
          )}
        </div>
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
