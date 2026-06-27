/**
 * ✨ Command launcher — quick AI commands for the current context.
 * Each command opens the chat panel with a specific instruction:
 *   问答此文件 / 构建 Wiki / Wiki 健康检查 (+ Phase 3 AI placeholders).
 * Pure presentation + callbacks. `/` in the chat composer is the keyboard
 * alternative to this launcher.
 */
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import './KbMoreMenu.css';

interface KbCommandLauncherProps {
  /** Ask AI about the current file. Undefined when no file open → item disabled. */
  onAskAboutFile?: () => void;
  onBuildWiki?: () => void;
  onLintWiki?: () => void;
}

export function KbCommandLauncher({ onAskAboutFile, onBuildWiki, onLintWiki }: KbCommandLauncherProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside / ESC
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn?: () => void) => {
    setOpen(false);
    fn?.();
  };

  const item = (
    testId: string,
    icon: string,
    label: string,
    onClick?: () => void,
    disabledTitle?: string,
  ) => (
    <button
      type="button"
      className="kb-more-item"
      data-testid={testId}
      role="menuitem"
      disabled={!onClick}
      title={!onClick ? disabledTitle : undefined}
      onClick={() => onClick && run(onClick)}
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="kb-more-menu" ref={ref}>
      <button
        type="button"
        className="kb-more-menu-btn"
        data-testid="kb-cmd-launcher-btn"
        onClick={() => setOpen((o) => !o)}
        title={t('kb.cmdLauncherLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15" aria-hidden="true">
          <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
          <path d="M19 14l.7 1.8L21.5 16.5l-1.8.7L19 19l-.7-1.8L16.5 16.5l1.8-.7L19 14z" />
        </svg>
      </button>
      {open && (
        <div className="kb-more-menu-dropdown" data-testid="kb-cmd-launcher" role="menu">
          {item('cmd-item-ask', '💬', t('kb.askAboutFile'), onAskAboutFile, t('kb.cmdNeedsFile'))}
          {item('cmd-item-build-wiki', '📚', t('kb.buildWiki'), onBuildWiki, t('kb.cmdNeedsVault'))}
          {item('cmd-item-lint-wiki', '🩺', t('kb.lintWiki'), onLintWiki, t('kb.cmdNeedsVault'))}
          <div className="kb-more-divider" />
          {item('cmd-item-ai-summary', '🤖', t('kb.moreMenuAiSummary'), undefined, t('kb.moreMenuComingSoon'))}
          {item('cmd-item-ai-key-points', '🤖', t('kb.moreMenuAiKeyPoints'), undefined, t('kb.moreMenuComingSoon'))}
          {item('cmd-item-ai-related', '🤖', t('kb.moreMenuAiRelated'), undefined, t('kb.moreMenuComingSoon'))}
        </div>
      )}
    </div>
  );
}
