/**
 * PreloadToast — bottom-right toast that prompts the user to download heavy
 * skill tools (docling) in the background before they're first needed.
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
import { useSelectMode } from '../stores/messageSelectionStore';

// ─── Types ───────────────────────────────────────────────────────────────────

type PreloadableSkill = 'docling';

interface SkillInfo {
  status: string;
  progress?: number;
  message?: string;
  error?: string;
  path?: string | null;
}

interface ToastState {
  visible: boolean;
  mode: 'prompt' | 'downloading' | 'paused' | 'done' | 'error';
  skills: PreloadableSkill[];
  /** Per-skill progress 0–100 */
  progress: Record<string, number>;
  /** Per-skill message */
  messages: Record<string, string>;
  /** Real on-disk install location per skill (venv / global / conda / …), as
   *  reported by the daemon. Surfaced so testers/users see WHERE a tool lives
   *  (the core of the two-location story) and what "stop" will/won't clean. */
  paths: Record<string, string | null>;
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
};

// ─── Component ──────────────────────────────────────────────────────────────

export function PreloadToast() {
  const [state, setState] = useState<ToastState>({
    visible: false,
    mode: 'prompt',
    skills: [],
    progress: {},
    messages: {},
    paths: {},
    minimized: false,
  });
  const [dismissed, setDismissed] = useState(false);
  const mountedRef = useRef(true);
  const selectMode = useSelectMode();
  /** Tracks an in-flight pause/stop intent so the streaming completion logic
   *  doesn't override the mode the user just switched to. */
  const userActionRef = useRef<'pause' | 'stop' | null>(null);

  // Yield the bottom-right corner to the chat selection confirm bar: when the
  // user enters message-deletion selection mode, collapse a downloading toast
  // to the small pill so the confirm bar's delete button stays clickable. The
  // pill is narrow and docks at the very corner, sitting to the right of the
  // 900px-centered confirm bar on a typical viewport. We don't auto-restore on
  // exit — the completion handler already force-expands when done, and the user
  // can click the pill to re-expand whenever they like.
  useEffect(() => {
    if (!selectMode) return;
    setState((prev) => {
      // Only collapse a real, expanded, downloading toast — leave prompt /
      // done / error modes (transient or non-overlapping) untouched.
      if (prev.mode !== 'downloading' || !prev.visible || prev.minimized) return prev;
      return { ...prev, minimized: true };
    });
  }, [selectMode]);

  // Fetch preload status on mount
  useEffect(() => {
    mountedRef.current = true;

    // Don't render the always-on toast under Playwright/automation. In a
    // clean CI environment docling is never installed, so the
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
        const paths: Record<string, string | null> = {};
        for (const [skill, info] of Object.entries(statuses)) {
          paths[skill] = info.path ?? null;
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
            paths,
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

  /** Re-fetch daemon status and, if any skill is `missing`, (re)show the
   *  prompt card. This is what makes the toast re-appear after a clean stop
   *  (the skills go back to `missing`): there is NO periodic re-check — only
   *  the mount-time one — so without this the toast would stay hidden forever
   *  after pause→stop, leaving the user no way to download again (the
   *  2026-07 "can't re-download after pause→stop" bug). */
  const refreshFromStatus = useCallback(async () => {
    try {
      const statuses: Record<string, SkillInfo> = await api.getPreloadStatus();
      if (!mountedRef.current) return;
      const missing: PreloadableSkill[] = [];
      const paths: Record<string, string | null> = {};
      for (const [skill, info] of Object.entries(statuses)) {
        paths[skill] = info.path ?? null;
        if (info.status === 'missing') missing.push(skill as PreloadableSkill);
      }
      if (missing.length > 0) {
        setDismissed(false);
        setState({
          visible: true,
          mode: 'prompt',
          skills: missing,
          progress: {},
          messages: {},
          paths,
          minimized: false,
        });
      } else {
        setState((prev) => ({ ...prev, visible: false }));
      }
    } catch {
      // Daemon gone / unreachable — leave the toast as-is.
    }
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

    // Track each skill's terminal outcome as progress events arrive. The
    // SSE stream closes once every skill reaches completed/failed/paused/
    // stopped, but the stream closing alone does NOT mean success — a skill
    // can emit 'failed' and the stream still ends. Without tracking this,
    // the toast would show green "完成" even when docling's pip install
    // actually failed (verified: venv skeleton created but no docling binary).
    const outcomes = new Map<string, { ok: boolean; message: string }>();
    // Set when the user hits pause/stop so the post-stream logic doesn't
    // override the mode the handler already switched to.
    let userAction: 'pause' | 'stop' | null = null;
    userActionRef.current = null;

    try {
      await api.startPreload(skills, (event) => {
        if (event.status === 'completed') {
          outcomes.set(event.skill, { ok: true, message: event.message });
        } else if (event.status === 'failed') {
          outcomes.set(event.skill, { ok: false, message: event.message });
        } else if (event.status === 'paused') {
          // Daemon confirmed the pause. Switch to the paused view (the
          // handler already set it optimistically; this re-affirms once the
          // abort propagated through the stream).
          userAction = 'pause';
          setState((prev) => ({ ...prev, mode: 'paused', minimized: false }));
          return;
        } else if (event.status === 'stopped') {
          userAction = 'stop';
          // Don't hide here. The post-await refresh re-shows the prompt when
          // the skills are `missing` again (the usual case after a clean stop).
          // Hiding with no re-show was the "can't re-download" bug.
          return;
        }
        // Don't let stray 'preloading' events un-pause a toast the user
        // just asked to pause/stop.
        if (userAction) return;
        setState((prev) => ({
          ...prev,
          mode: 'downloading',
          progress: { ...prev.progress, [event.skill]: event.progress },
          messages: { ...prev.messages, [event.skill]: event.message },
        }));
      });

      // If the user stopped, the skills are `missing` again — re-show the
      // prompt so they can download again. If paused, keep the paused view.
      if (userAction === 'stop') {
        await refreshFromStatus();
        return;
      }
      if (userAction === 'pause') {
        return;
      }

      // Decide done vs error from actual per-skill outcomes, not from the
      // stream having closed. Force open (un-minimize) either way so the
      // result is always seen.
      const failed = [...outcomes.values()].filter((o) => !o.ok);
      if (failed.length > 0) {
        const names = skills
          .filter((sk) => outcomes.get(sk)?.ok === false)
          .map((sk) => SKILL_LABELS[sk as PreloadableSkill]?.label ?? sk);
        setState((prev) => ({
          ...prev,
          mode: 'error',
          minimized: false,
          error: `${names.join('、')} 预下载失败：${failed[0]!.message}`,
        }));
      } else {
        setState((prev) => ({ ...prev, mode: 'done', minimized: false, error: undefined }));
        // Auto-hide only on full success. Errors stay until the user acts.
        setTimeout(() => {
          setState((prev) => ({ ...prev, visible: false }));
        }, 5000);
      }
    } catch (err) {
      if (userAction) return; // pause/stop surfaced via event, not a throw
      // Stream itself errored (network drop, daemon gone) — surface as error.
      setState((prev) => ({
        ...prev,
        mode: 'error',
        minimized: false,
        error: err instanceof Error ? err.message : '下载失败',
      }));
    }
  }, [state.skills, refreshFromStatus]);

  /** Pause all in-progress downloads. Partial artifacts are kept on disk so
   *  resume picks up where it left off (pip / HuggingFace caches). */
  const handlePause = useCallback(() => {
    userActionRef.current = 'pause';
    const skills = state.skills;
    setState((prev) => ({ ...prev, mode: 'paused', minimized: false }));
    api.pausePreload(skills).catch(() => {});
  }, [state.skills]);

  /** Resume a paused preload — just re-runs startPreload, which resumes via
   *  the caches. */
  const handleResume = useCallback(() => {
    handleDownload();
  }, [handleDownload]);

  /** Stop all preloads AND delete partial artifacts (clean reset). Hides the
   *  toast; on next check the skills show as missing again. */
  const handleStop = useCallback(async () => {
    userActionRef.current = 'stop';
    const skills = state.skills;
    // Optimistically hide the progress/paused card. refreshFromStatus below
    // re-shows the prompt once the daemon confirms the clean reset (skills go
    // back to `missing`) — so the user always has a working "download" button
    // again instead of a toast that vanished with no way back.
    setState((prev) => ({ ...prev, visible: false }));
    try {
      await api.stopPreload(skills);
    } catch {
      // best-effort — still try to refresh the prompt
    }
    await refreshFromStatus();
  }, [state.skills, refreshFromStatus]);

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

      {/* key={mode} remounts the body on every state change so the view-in
          animation re-fires — gives prompt→downloading→done→paused a soft
          settle instead of a hard content swap. */}
      <div className="preload-toast__body" key={state.mode}>
        {state.mode === 'prompt' && <PromptView skills={state.skills} paths={state.paths} onDownload={handleDownload} onDismiss={handleDismiss} />}
        {state.mode === 'downloading' && <DownloadingView skills={state.skills} progress={state.progress} messages={state.messages} onMinimize={handleMinimize} onPause={handlePause} onStop={handleStop} />}
        {state.mode === 'paused' && <PausedView skills={state.skills} progress={state.progress} paths={state.paths} onResume={handleResume} onStop={handleStop} />}
        {state.mode === 'done' && <DoneView skills={state.skills} />}
        {state.mode === 'error' && <ErrorView error={state.error} onRetry={handleRetry} onDismiss={handleDismiss} />}
      </div>
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

function PromptView({ skills, paths, onDownload, onDismiss }: {
  skills: PreloadableSkill[];
  paths: Record<string, string | null>;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  // Skills that ARE installed elsewhere (global/conda/…) but aren't in the
  // missing list — surfaced so the two-location reality is visible, not hidden.
  const installedElsewhere = (Object.keys(paths) as PreloadableSkill[])
    .filter((sk) => paths[sk] && !skills.includes(sk));
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
      {installedElsewhere.length > 0 && (
        <p className="preload-toast__elsewhere">
          另：{installedElsewhere.map((sk) => `${SKILL_LABELS[sk]?.label ?? sk} 已装在 ${paths[sk]}`).join('；')}（已识别，不会重复安装）
        </p>
      )}
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

function DownloadingView({ skills, progress, messages, onMinimize, onPause, onStop }: {
  skills: string[];
  progress: Record<string, number>;
  messages: Record<string, string>;
  onMinimize: () => void;
  onPause: () => void;
  onStop: () => void;
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
                  className="preload-toast__progress-fill preload-toast__progress-fill--active"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {msg && <p className="preload-toast__progress-msg">{msg}</p>}
            </div>
          );
        })}
      </div>
      <div className="preload-toast__actions">
        <button className="rt-btn rt-btn--sm" onClick={onPause} title="暂停下载，保留已下载部分，之后可继续">
          暂停
        </button>
        <button
          className="rt-btn rt-btn--sm"
          onClick={onStop}
          title="停止并删除本次预下载写入的内容（docling 的 venv+模型）；不会动你手动/全局安装的包"
        >
          停止
        </button>
      </div>
    </>
  );
}

function PausedView({ skills, progress, paths, onResume, onStop }: {
  skills: string[];
  progress: Record<string, number>;
  paths: Record<string, string | null>;
  onResume: () => void;
  onStop: () => void;
}) {
  // Best progress so far — shown frozen (no shimmer) so the stillness itself
  // communicates "paused", in contrast to the sweeping active bar.
  const pct = computeOverallProgress(skills as PreloadableSkill[], progress);
  return (
    <>
      <p className="preload-toast__title">已暂停</p>
      <p className="preload-toast__subtitle">
        进度已保留（{Math.round(pct)}%），继续将从断点接上
      </p>
      <div className="preload-toast__progress-list">
        {skills.map((sk) => {
          const skPct = Math.min(progress[sk] ?? 0, 100);
          const label = SKILL_LABELS[sk as PreloadableSkill]?.label ?? sk;
          return (
            <div key={sk} className="preload-toast__progress-item">
              <div className="preload-toast__progress-header">
                <span className="preload-toast__card-name">{label}</span>
                <span className="preload-toast__progress-pct">{Math.round(skPct)}%</span>
              </div>
              <div className="preload-toast__progress-bar">
                <div
                  className="preload-toast__progress-fill"
                  style={{ width: `${skPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="preload-toast__elsewhere">
        停止将删除本次预下载写入的内容
        {skills.some((sk) => paths[sk]) && `（${skills.filter((sk) => paths[sk]).map((sk) => paths[sk]).join('、')}）`}
        ，不会动你手动/全局安装的包。
      </p>
      <div className="preload-toast__actions">
        <button className="rt-btn rt-btn--sm preload-toast__primary" onClick={onResume}>
          继续
        </button>
        <button
          className="rt-btn rt-btn--sm"
          onClick={onStop}
          title="删除本次预下载写入的内容（docling 的 venv+模型）；不会动你手动/全局安装的包"
        >
          停止并清理预下载
        </button>
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
