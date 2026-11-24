// apps/web/src/components/diagnostics/CheckupDialog.tsx
// Molio 体检面板：知识库页听诊器按钮点开后的确定性体检结果。
// 结果由 daemon 的 GET /api/diagnostics 产出（确定性代码，不是模型生成的猜测），
// 面板只负责「先给结论、问题给步骤、正常项收进安静区」的排版。
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DiagnosticsReport, DiagnosticItem } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import {
  readDesktopBridge, canRunAction, runDiagnosticAction, type DesktopBridge,
} from './checkupActions';

export interface CheckupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Wiki 已构建时，安静区提供「继续检查 Wiki 内容健康」（走原有 lint 会话）。 */
  wikiInitialized: boolean;
  /** 有可用 agent 时才提供「让 AI 帮我看」。 */
  canRunAgent: boolean;
  onWikiLint: () => void;
  onAskDoctor: (message: string) => void;
}

/** 取数状态机：loading → ready(report) | unreachable。后两者不是 view——view 是 report/confirm/result。 */
type FetchStatus = 'loading' | 'ready' | 'unreachable';

/** 与视觉稿一致的 chevron（收起指右，details[open] 时旋 90°，见 diagnostics.css）。 */
const CHEVRON = (
  <svg className="checkup-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 1.5 7 5 3.5 8.5" />
  </svg>
);

/** 单条问题：标题 + 摘要 + 「你要做的事」编号步骤；严重度只用左侧 3px 色带，不堆卡片。 */
function CheckIssueItem({
  item, bridge, onOpenUrl, stepsLabel,
}: {
  item: DiagnosticItem;
  bridge: DesktopBridge | null;
  onOpenUrl: (path: string) => void;
  stepsLabel: string;
}) {
  // 桌面专属动作（重启 / 检查更新）在浏览器里没有桥——按钮不渲染，而不是点了没反应
  const actionable = (item.actions ?? []).filter((a) => canRunAction(a, bridge));
  return (
    <div className="checkup-item" data-level={item.level} data-testid="checkup-item">
      <div className="checkup-item-head">
        <div>
          <p className="checkup-item-title">{item.title}</p>
          <p className="checkup-item-summary">{item.summary}</p>
        </div>
        {actionable.length > 0 && (
          <div className="checkup-item-actions">
            {actionable.map((a) => (
              <button key={a.code} type="button" className="kb-btn" onClick={() => runDiagnosticAction(a, bridge, onOpenUrl)}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {item.steps && item.steps.length > 0 && (
        <>
          <div className="checkup-steps-label">{stepsLabel}</div>
          <ol className="checkup-steps" data-testid="checkup-steps">
            {item.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </>
      )}
    </div>
  );
}

export function CheckupDialog({
  open, onClose, wikiInitialized, canRunAgent, onWikiLint, onAskDoctor,
}: CheckupDialogProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // 每次检查自增：慢请求回来时若用户已点了「重新检查」，旧响应直接丢弃
  const reqIdRef = useRef(0);

  const [status, setStatus] = useState<FetchStatus>('loading');
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  // view 是支持包（Task 9）的 confirm/result 预留；本任务只渲染 report
  const [view, setView] = useState<'report' | 'confirm' | 'result'>('report');

  // 桌面桥在整个会话期不变（preload 注入一次），memo 一次即可
  const bridge = useMemo(() => readDesktopBridge(window), []);

  const runCheck = useCallback(() => {
    const req = ++reqIdRef.current;
    setStatus('loading');
    api.getDiagnostics()
      .then((r) => { if (reqIdRef.current === req) { setReport(r); setStatus('ready'); } })
      .catch(() => { if (reqIdRef.current === req) setStatus('unreachable'); });
  }, []);

  useEffect(() => {
    if (!open) return;
    runCheck();
  }, [open, runCheck]);

  // 打开时焦点落在面板上：对话框语义（Esc / Tab 都收在面板内），键盘用户不用先摸索
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
  }, [open]);

  // Esc 关闭（点遮罩关闭在外壳 onClick 上，同 KbModals 的既有模式）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onOpenUrl = useCallback((path: string) => navigate(path), [navigate]);

  const openLogFolder = useCallback(async () => {
    // getLogPath 返回的是日志「文件」路径，openPath 要的是文件夹——剥掉最后一段
    const p = await bridge?.getLogPath?.();
    if (!p || !bridge?.openPath) return;
    bridge.openPath(p.replace(/[\\/][^\\/]+$/, ''));
  }, [bridge]);

  if (!open) return null;

  const items = report?.items ?? [];
  const errors = items.filter((i) => i.level === 'error');
  const warns = items.filter((i) => i.level === 'warn');
  const oks = items.filter((i) => i.level === 'ok');
  const skips = items.filter((i) => i.level === 'skip');
  const hasIssues = errors.length > 0 || warns.length > 0;

  // 结论是一句话而不是计数拼成的汇总行：用户第一眼要的是「有没有事」，
  // 明细让下面的清单与安静区承担。圆点颜色替句子标了严重度。
  let verdictLevel: 'error' | 'warn' | 'ok';
  let verdictText: string;
  let verdictNote: string | null;
  if (errors.length > 0) {
    verdictLevel = 'error';
    verdictText = t('checkup.verdictIssues', { n: errors.length });
    verdictNote = warns.length > 0 ? t('checkup.verdictWarnNote', { n: warns.length }) : null;
  } else if (warns.length > 0) {
    verdictLevel = 'warn';
    verdictText = t('checkup.verdictWarnOnly');
    verdictNote = t('checkup.verdictWarnNote', { n: warns.length });
  } else {
    verdictLevel = 'ok';
    verdictText = t('checkup.verdictOk');
    verdictNote = t('checkup.verdictOkNote', { n: oks.length });
  }

  const stepsLabel = t('checkup.stepsLabel');

  return (
    <div className={`kb-overlay ${open ? 'show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="kb-modal checkup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        data-testid="checkup-dialog"
      >
        <div className="kb-modal-header">
          <h2 id={titleId}>{t('checkup.title')}</h2>
          <button className="kb-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="kb-modal-body">
          {status === 'loading' && (
            // 占位 64px：面板不会先矮一截再被结果撑高（视觉稿「加载中」态）
            <div className="checkup-loading" data-testid="checkup-loading">
              <span className="checkup-spinner" />
              {t('checkup.loading')}
            </div>
          )}

          {status === 'ready' && report && view === 'report' && (
            <div data-testid="checkup-view-report">
              <h3 className="checkup-verdict" data-testid="checkup-verdict">
                <span className="checkup-dot" data-level={verdictLevel} />
                <span>{verdictText}</span>
              </h3>
              {verdictNote && <p className="checkup-verdict-note" data-testid="checkup-verdict-note">{verdictNote}</p>}

              <div className="checkup-list">
                {[...errors, ...warns].map((item) => (
                  <CheckIssueItem key={item.code} item={item} bridge={bridge} onOpenUrl={onOpenUrl} stepsLabel={stepsLabel} />
                ))}
              </div>

              {/* 安静区：正常的、没查成的、下一步可选的深检查——都不抢「有问题」的戏 */}
              <div className="checkup-quiet">
                <details className="checkup-ok" data-testid="checkup-ok">
                  <summary>
                    {CHEVRON}
                    {hasIssues ? t('checkup.okToggleOthers', { n: oks.length }) : t('checkup.okToggleAll', { n: oks.length })}
                  </summary>
                  <ul className="checkup-ok-list" data-testid="checkup-ok-list">
                    {oks.map((i) => <li key={i.code}>{i.title}</li>)}
                  </ul>
                </details>
                {skips.length > 0 && (
                  <p className="checkup-skip" data-testid="checkup-skip">
                    {t('checkup.skipNote', { n: skips.length, names: skips.map((s) => s.title).join('、') })}
                  </p>
                )}
                {wikiInitialized && (
                  <div className="checkup-wiki">
                    <span>{t('checkup.wikiLint')}</span>
                    <button type="button" className="kb-btn" data-testid="checkup-wiki-lint" onClick={onWikiLint}>
                      {t('checkup.wikiLintBtn')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {status === 'unreachable' && (
            // 后台服务没回应：不是白屏也不是裸报错，给「重启 + 日志文件夹」指引。
            // 复用 checkup-item 的红色色带排版；这个状态没有底部栏（没有可重试的确定性动作）。
            <div data-testid="checkup-unreachable">
              <div className="checkup-item" data-level="error">
                <div className="checkup-item-head">
                  <div>
                    <p className="checkup-item-title">{t('checkup.unreachableTitle')}</p>
                    <p className="checkup-item-summary">{t('checkup.unreachableSummary')}</p>
                  </div>
                </div>
                <div className="checkup-steps-label">{stepsLabel}</div>
                <ol className="checkup-steps">
                  <li>{t('checkup.unreachableStep1')}</li>
                  <li>{t('checkup.unreachableStep2')}</li>
                </ol>
                {(bridge?.restartApp || (bridge?.getLogPath && bridge?.openPath)) && (
                  <div className="checkup-item-actions checkup-item-actions--below">
                    {bridge?.restartApp && (
                      // 按钮文案与步骤 1 同串（视觉稿即如此）：动作就是那一步本身
                      <button type="button" className="kb-btn kb-btn-primary" onClick={() => { void bridge.restartApp?.(); }}>
                        {t('checkup.unreachableStep1')}
                      </button>
                    )}
                    {bridge?.getLogPath && bridge?.openPath && (
                      <button type="button" className="kb-btn" data-testid="checkup-open-log-folder" onClick={() => { void openLogFolder(); }}>
                        {t('checkup.openLogFolder')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {status === 'ready' && view === 'report' && (
          <div className="kb-modal-footer">
            <button type="button" className="kb-btn" data-testid="checkup-recheck" onClick={runCheck}>
              {t('checkup.recheck')}
            </button>
            {canRunAgent && (
              <button
                type="button"
                className={`kb-btn${hasIssues ? ' kb-btn-primary' : ''}`}
                data-testid="checkup-ask-ai"
                onClick={() => onAskDoctor(hasIssues ? t('checkup.askAiIssues') : t('checkup.askAiAllOk'))}
              >
                {t('checkup.askAi')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
