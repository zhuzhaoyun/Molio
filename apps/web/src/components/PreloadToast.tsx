/**
 * PreloadToast — bottom-right toast that prompts the user to download heavy
 * skill tools (docling, remotion) in the background before they're first needed.
 *
 * States:
 *   - hidden: all skills installed or dismissed
 *   - prompt: one or more skills missing, shows "Download?" with action buttons
 *   - downloading: progress bar for active preload
 *   - done: briefly shows green "done" then auto-hides
 *   - error: shows failure with retry option
 *
 * Interaction:
 *   - "下载" → starts preload for all missing skills via POST /api/preload/start
 *   - "不再提示" → dismisses the skill via POST /api/preload/dismiss
 *   - Download progress is streamed via SSE and shown in a progress bar
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api/client';

// ─── Types ───────────────────────────────────────────────────────────────────

type PreloadableSkill = 'docling' | 'remotion';

interface SkillInfo {
  status: string;
  progress?: number;
  message?: string;
  error?: string;
}

interface ToastState {
  visible: boolean;
  mode: 'prompt' | 'downloading' | 'done' | 'error';
  skills: PreloadableSkill[];
  /** Per-skill progress 0–100 */
  progress: Record<string, number>;
  /** Per-skill message */
  messages: Record<string, string>;
  /** Error message */
  error?: string;
  /** When true, a downloading toast collapses to a small pill so the user
   *  can keep working without the full card in the way. The download keeps
   *  running; clicking the pill re-expands. Completion forces it open again
   *  so the "done" notification is always seen. */
  minimized: boolean;
}

const SKILL_LABELS: Record<PreloadableSkill, {
  label: string;
  scenario: string;
  includes: string;
  size: string;
  time: string;
}> = {
  docling: {
    label: 'docling',
    scenario: '解析 PDF / Word / PPT / Excel、图片 OCR、音视频转写',
    includes: 'Python 包（含 PyTorch）+ AI 模型',
    size: '约 1.5 GB',
    time: '5–15 分钟',
  },
  remotion: {
    label: 'Remotion',
    scenario: '用 React 生成视频、动画、动效',
    includes: 'npm 依赖 + 项目骨架（复用本地浏览器，无需另下 Chrome）',
    size: '约 100 MB',
    time: '1–3 分钟',
  },
};

// ─── Component ──────────────────────────────────────────────────────────────

export function PreloadToast() {
  const [state, setState] = useState<ToastState>({
    visible: false,
    mode: 'prompt',
    skills: [],
    progress: {},
    messages: {},
    minimized: false,
  });
  const [dismissed, setDismissed] = useState(false);
  const mountedRef = useRef(true);

  // Fetch preload status on mount
  useEffect(() => {
    mountedRef.current = true;

    // Don't render the always-on toast under Playwright/automation. In a
    // clean CI environment docling/remotion are never installed, so the
    // toast would pop and sit fixed over the bottom-right corner —
    // intercepting clicks on the chat selection confirm bar's delete button
    // (and any other bottom-right control). Real users aren't automated
    // browsers, so this gate is invisible to them. A future preload-toast E2E
    // can set window.__MOLIO_TEST_FORCE_PRELOAD_TOAST__ = true to override.
    const isAutomation = typeof navigator !== 'undefined' && (navigator as any).webdriver === true;
    const forceForTest = (window as any).__MOLIO_TEST_FORCE_PRELOAD_TOAST__ === true;
    if (isAutomation && !forceForTest) return;

    const check = async () => {
      try {
        const statuses: Record<string, SkillInfo> = await api.getPreloadStatus();
        if (!mountedRef.current) return;

        const missing: PreloadableSkill[] = [];
        for (const [skill, info] of Object.entries(statuses)) {
          if (info.status === 'missing') {
            missing.push(skill as PreloadableSkill);
          }
        }

        if (missing.length > 0) {
          setState({
            visible: true,
            mode: 'prompt',
            skills: missing,
            progress: {},
            messages: {},
            minimized: false,
          });
          setDismissed(false);
        }
      } catch {
        // Silently fail — daemon might not be ready yet
      }
    };

    // Check immediately and again after a short delay (daemon may still be starting)
    check();
    const timer = setTimeout(check, 3000);

    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, []);

  // Start preloading for all missing skills
  const handleDownload = useCallback(async () => {
    if (state.skills.length === 0) return;

    const skills = state.skills;
    setState((prev) => ({
      ...prev,
      mode: 'downloading',
      minimized: false,
      progress: Object.fromEntries(skills.map((s) => [s, 0])),
      messages: Object.fromEntries(skills.map((s) => [s, '准备中...'])),
    }));

    try {
      await api.startPreload(skills, (event) => {
        setState((prev) => ({
          ...prev,
          mode: 'downloading',
          progress: { ...prev.progress, [event.skill]: event.progress },
          messages: { ...prev.messages, [event.skill]: event.message },
        }));
      });

      // All done — force the toast open (un-minimize) so the completion
      // notification is always visible, even if the user had collapsed it.
      setState((prev) => ({ ...prev, mode: 'done', minimized: false, error: undefined }));

      // Auto-hide after 5 seconds
      setTimeout(() => {
        setState((prev) => ({ ...prev, visible: false }));
      }, 5000);
    } catch (err) {
      // On failure also surface the toast — the user needs to see it failed.
      setState((prev) => ({
        ...prev,
        mode: 'error',
        minimized: false,
        error: err instanceof Error ? err.message : '下载失败',
      }));
    }
  }, [state.skills]);

  /** Collapse the downloading toast to a small pill. The download keeps
   *  running; completion will force it back open. */
  const handleMinimize = useCallback(() => {
    setState((prev) => ({ ...prev, minimized: true }));
  }, []);

  /** Re-expand a minimized pill back to the full progress card. */
  const handleExpand = useCallback(() => {
    setState((prev) => ({ ...prev, minimized: false }));
  }, []);

  // Dismiss all missing skills
  const handleDismiss = useCallback(() => {
    const skills = state.skills;
    api.dismissPreload(skills).catch(() => {});
    setDismissed(true);
    setState((prev) => ({ ...prev, visible: false }));
  }, [state.skills]);

  // Retry after error
  const handleRetry = useCallback(() => {
    handleDownload();
  }, [handleDownload]);

  // Close
  const handleClose = useCallback(() => {
    setDismissed(true);
    setState((prev) => ({ ...prev, visible: false }));
  }, []);

  if (!state.visible || dismissed) return null;

  // Minimized pill: a downloading toast the user collapsed. Clicking it
  // re-expands. Completion (handled above) forces minimized=false, so this
  // pill only renders mid-download.
  if (state.mode === 'downloading' && state.minimized) {
    const pct = computeOverallProgress(state.skills, state.progress);
    return (
      <button
        className="preload-toast__pill"
        onClick={handleExpand}
        aria-label="展开下载进度"
        title="点击查看下载进度"
      >
        <span className="preload-toast__pill-spinner" aria-hidden="true" />
        <span className="preload-toast__pill-label">正在下载</span>
        <span className="preload-toast__pill-pct">{Math.round(pct)}%</span>
      </button>
    );
  }

  // During download, the top-right control minimizes (does NOT close) —
  // closing mid-download would swallow the completion notification. A real
  // close is only available on prompt / done / error.
  const isDownloading = state.mode === 'downloading';

  return (
    <div className="preload-toast">
      <button
        className="preload-toast__close"
        onClick={isDownloading ? handleMinimize : handleClose}
        aria-label={isDownloading ? '最小化' : '关闭'}
        title={isDownloading ? '最小化（下载继续，完成后通知）' : '关闭'}
      >
        {isDownloading ? '—' : '✕'}
      </button>

      {state.mode === 'prompt' && <PromptView skills={state.skills} onDownload={handleDownload} onDismiss={handleDismiss} />}
      {state.mode === 'downloading' && <DownloadingView skills={state.skills} progress={state.progress} messages={state.messages} onMinimize={handleMinimize} />}
      {state.mode === 'done' && <DoneView skills={state.skills} />}
      {state.mode === 'error' && <ErrorView error={state.error} onRetry={handleRetry} onDismiss={handleDismiss} />}
    </div>
  );
}

/** Average progress across the skills currently being downloaded. Used for
 *  the minimized pill's single percentage. */
function computeOverallProgress(skills: PreloadableSkill[], progress: Record<string, number>): number {
  if (skills.length === 0) return 0;
  const sum = skills.reduce((acc, sk) => acc + (progress[sk] ?? 0), 0);
  return sum / skills.length;
}

// ─── Sub-views ──────────────────────────────────────────────────────────────

function PromptView({ skills, onDownload, onDismiss }: {
  skills: PreloadableSkill[];
  onDownload: () => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <p className="preload-toast__title">可预下载的工具</p>
      <p className="preload-toast__subtitle">后台提前下载，首次使用时无需等待</p>
      <div className="preload-toast__cards">
        {skills.map((sk) => {
          const info = SKILL_LABELS[sk];
          return (
            <div key={sk} className="preload-toast__card">
              <div className="preload-toast__card-head">
                <span className="preload-toast__card-name">{info.label}</span>
                <span className="preload-toast__card-size">{info.size}</span>
              </div>
              <p className="preload-toast__card-scenario">{info.scenario}</p>
              <p className="preload-toast__card-meta">
                {info.includes}<span className="preload-toast__card-dot">·</span>约 {info.time}
              </p>
            </div>
          );
        })}
      </div>
      <div className="preload-toast__actions">
        <button className="rt-btn rt-btn--sm preload-toast__primary" onClick={onDownload}>
          后台下载
        </button>
        <button className="rt-btn rt-btn--sm" onClick={onDismiss}>
          不再提示
        </button>
      </div>
    </>
  );
}

function DownloadingView({ skills, progress, messages, onMinimize }: {
  skills: string[];
  progress: Record<string, number>;
  messages: Record<string, string>;
  onMinimize: () => void;
}) {
  return (
    <>
      <p className="preload-toast__title">正在后台下载</p>
      <p className="preload-toast__subtitle">
        可继续使用 Molio，完成后会通知你
        <button className="preload-toast__minimize-link" onClick={onMinimize}>
          最小化
        </button>
      </p>
      <div className="preload-toast__progress-list">
        {skills.map((sk) => {
          const pct = Math.min(progress[sk] ?? 0, 100);
          const msg = messages[sk] ?? '';
          const label = SKILL_LABELS[sk as PreloadableSkill]?.label ?? sk;
          return (
            <div key={sk} className="preload-toast__progress-item">
              <div className="preload-toast__progress-header">
                <span className="preload-toast__card-name">{label}</span>
                <span className="preload-toast__progress-pct">{Math.round(pct)}%</span>
              </div>
              <div className="preload-toast__progress-bar">
                <div
                  className="preload-toast__progress-fill"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {msg && <p className="preload-toast__progress-msg">{msg}</p>}
            </div>
          );
        })}
      </div>
    </>
  );
}

function DoneView({ skills }: { skills: string[] }) {
  return (
    <>
      <p className="preload-toast__title preload-toast__title--done">预下载完成</p>
      <p className="preload-toast__done-desc">
        {skills.map((sk) => SKILL_LABELS[sk as PreloadableSkill]?.label ?? sk).join('、')} 已就绪，首次使用无需等待
      </p>
    </>
  );
}

function ErrorView({ error, onRetry, onDismiss }: {
  error?: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <p className="preload-toast__title preload-toast__title--error">✕ 下载失败</p>
      <p className="preload-toast__error-msg">{error ?? '未知错误'}</p>
      <div className="preload-toast__actions">
        <button className="rt-btn rt-btn--sm preload-toast__primary" onClick={onRetry}>
          重试
        </button>
        <button className="rt-btn rt-btn--sm" onClick={onDismiss}>
          关闭
        </button>
      </div>
    </>
  );
}
