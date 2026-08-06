// apps/web/src/components/kb/KbChatSessionsPanel.tsx
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import { useI18n } from '../../i18n';
import {
  kbChatSessionsStore, useKbChatSessions, useKbChatActiveSessionId,
  MAX_CHAT_SESSIONS, type ChatSessionTab,
} from '../../stores/kbChatSessionsStore';
import { ChatSessionTabBar } from './ChatSessionTabBar';
import { KbChatSession, type KbChatSessionApi } from './KbChatSession';
import { WIKI_PROMPTS, WIKI_INGEST_PROMPT, WIKI_TITLES } from './kbChatPrompts';
import { ConfirmDialog } from './KbModals';

export interface KbChatSessionsPanelHandle {
  runWikiOp: (opts: { mode: 'build' | 'lint' | 'ingest'; filePath?: string; isDirectory?: boolean }) => void;
  openQa: (opts: { filePath: string | null; vaultId: string | null; selectedText?: string | null }) => void;
}

interface WikiOpOpts { mode: 'build' | 'lint' | 'ingest'; filePath?: string; isDirectory?: boolean }

interface Props {
  agentId: string | null;
  vaultPath: string | null;
  /** 当前选中文件，供新 QA 会话快照 @上下文 */
  currentFilePath: string | null;
  currentVaultId: string | null;
  onWikiComplete?: () => void;
}

export const KbChatSessionsPanel = forwardRef<KbChatSessionsPanelHandle, Props>(function KbChatSessionsPanel(
  { agentId, vaultPath, currentFilePath, currentVaultId, onWikiComplete }, ref,
) {
  const { t } = useI18n();
  const sessions = useKbChatSessions();
  const activeSessionId = useKbChatActiveSessionId();

  const [panelWidth, setPanelWidth] = useState(360);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [runningMap, setRunningMap] = useState<Record<string, boolean>>({});
  const [confirmDialog, setConfirmDialog] = useState<{ show: boolean; title: string; message: string }>({ show: false, title: '', message: '' });
  const [toast, setToast] = useState<string | null>(null);
  // 关闭「运行中会话」的确认态（ref 作真值源，state 触发渲染）
  const [closePendingOpen, setClosePendingOpen] = useState(false);

  const sessionApisRef = useRef(new Map<string, KbChatSessionApi>());
  const pendingWikiRef = useRef<WikiOpOpts | null>(null);
  // 新开的 wiki 会话尚未 mount（API 未注册）时缓存待自动发送的提示词，registerApi 时补发
  const pendingAutoSendRef = useRef(new Map<string, string>());
  const closePendingRef = useRef<string | null>(null);
  // 拖拽 resize 状态（照搬旧 KbChatPanel）
  const resizingRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const registerApi = useCallback((id: string, a: KbChatSessionApi) => {
    sessionApisRef.current.set(id, a);
    const prompt = pendingAutoSendRef.current.get(id);
    if (prompt !== undefined) {
      pendingAutoSendRef.current.delete(id);
      a.clear();
      a.send(prompt);
    }
  }, []);
  const unregisterApi = useCallback((id: string) => { sessionApisRef.current.delete(id); }, []);
  const handleRunningChange = useCallback((id: string, running: boolean) => {
    setRunningMap((prev) => (prev[id] === running ? prev : { ...prev, [id]: running }));
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeIsRunning = activeSession ? !!runningMap[activeSession.id] : false;
  const anyWikiRunning = useMemo(
    () => sessions.some((s) => s.mode !== 'qa' && runningMap[s.id]),
    [sessions, runningMap],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  }, []);

  // ─── 拖拽 resize（照搬旧 KbChatPanel 第 41–69 行） ───
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = { startX: e.clientX, startWidth: panelWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = resizingRef.current.startX - e.clientX;
      const newWidth = Math.min(
        Math.max(resizingRef.current.startWidth + delta, 280),
        window.innerWidth * 0.5,
      );
      setPanelWidth(newWidth);
    };
    const handleMouseUp = () => {
      resizingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // ─── 命令下发 ───
  const wikiPrompt = useCallback((opts: WikiOpOpts) => {
    if (opts.mode === 'build' || opts.mode === 'lint') return WIKI_PROMPTS[opts.mode];
    return WIKI_INGEST_PROMPT(opts.filePath ?? '', opts.isDirectory);
  }, []);

  const clearAndSend = useCallback(async (sessionId: string, opts: WikiOpOpts) => {
    const a = sessionApisRef.current.get(sessionId);
    if (!a) {
      // 会话刚 open、尚未 mount（API 未注册）→ 缓存提示词，registerApi 时补发
      pendingAutoSendRef.current.set(sessionId, wikiPrompt(opts));
      return;
    }
    // D3「新构建停旧构建」：先 cancel 该会话正在跑的 run（daemon 侧 DELETE /api/runs/:id，
    // 杀旧 agent 进程，杜绝新旧构建并发写 vault），再清空、再自动发送。
    // api.cancel 在无 run 时是安全的 no-op；await 确保 cancel 的收尾 setState
    // 不会覆盖随后新 run 的 running 状态。
    await a.cancel();
    a.clear();
    a.send(wikiPrompt(opts));
  }, [wikiPrompt]);

  const runWikiOp = useCallback((opts: WikiOpOpts) => {
    // 1) 找/建该类型 wiki 会话标签
    let tab = sessions.find((s) => s.mode === opts.mode);
    if (!tab) {
      const res = kbChatSessionsStore.openSession({
        mode: opts.mode, title: WIKI_TITLES[opts.mode], conversationId: null, filePath: null,
      });
      if (!res.opened && res.reason === 'limit') {
        showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
        return;
      }
      tab = res.tab;
    } else {
      kbChatSessionsStore.activateSession(tab.id);
      // 已存在的 wiki 标签：重新打开可能已被收起的面板，保证点击构建/检查必有反馈
      kbChatSessionsStore.setPanelOpen(true);
    }
    if (!tab) return;
    // 2) 任意 wiki 任务在跑 → 三选一
    if (anyWikiRunning) {
      pendingWikiRef.current = opts;
      setConfirmDialog({
        show: true,
        title: '当前任务进行中',
        message: '当前有 Wiki 任务正在运行。选择如何处理：',
      });
      return;
    }
    // 3) 无冲突 → 清空 + 自动发送
    clearAndSend(tab.id, opts);
  }, [sessions, anyWikiRunning, clearAndSend, showToast]);

  const handleConfirmDialog = useCallback((action: 'interrupt' | 'queue') => {
    setConfirmDialog((prev) => ({ ...prev, show: false }));
    const opts = pendingWikiRef.current;
    pendingWikiRef.current = null;
    if (!opts) return;
    if (action === 'interrupt') {
      const tab = kbChatSessionsStore.getSessions().find((s) => s.mode === opts.mode);
      if (tab) clearAndSend(tab.id, opts);
    } else {
      // 排队 → 发到正在运行的 wiki 会话
      const running = kbChatSessionsStore.getSessions()
        .find((s) => s.mode !== 'qa' && runningMap[s.id]);
      if (running) sessionApisRef.current.get(running.id)?.send(wikiPrompt(opts));
    }
  }, [clearAndSend, runningMap, wikiPrompt]);

  const openQa = useCallback((opts: { filePath: string | null; vaultId: string | null; selectedText?: string | null }) => {
    const active = kbChatSessionsStore.getActiveSession();
    if (opts.selectedText) setPendingSelection(opts.selectedText);
    if (active && active.mode === 'qa') {
      kbChatSessionsStore.setPanelOpen(true);
      return;
    }
    const res = kbChatSessionsStore.openSession({
      mode: 'qa', title: '新会话', conversationId: null,
      vaultId: opts.vaultId ?? undefined, filePath: opts.filePath,
    });
    if (!res.opened && res.reason === 'limit') showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
  }, [showToast]);

  useImperativeHandle(ref, () => ({ runWikiOp, openQa }), [runWikiOp, openQa]);

  // ─── 面板级事件 ───
  const handleNewSession = useCallback(() => {
    const res = kbChatSessionsStore.openSession({
      mode: 'qa', title: '新会话', conversationId: null,
      vaultId: currentVaultId ?? undefined, filePath: currentFilePath,
    });
    if (!res.opened && res.reason === 'limit') showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
  }, [currentFilePath, currentVaultId, showToast]);

  const handleCloseTab = useCallback((id: string) => {
    if (runningMap[id]) {
      closePendingRef.current = id;
      setClosePendingOpen(true);
      return;
    }
    kbChatSessionsStore.closeSession(id);
  }, [runningMap]);

  const handleCloseConfirm = useCallback((interrupt: boolean) => {
    const id = closePendingRef.current;
    closePendingRef.current = null;
    setClosePendingOpen(false);
    if (!id) return;
    if (interrupt) sessionApisRef.current.get(id)?.cancel();
    kbChatSessionsStore.closeSession(id);
  }, []);

  const handleOpenConversation = useCallback((conversationId: string) => {
    const res = kbChatSessionsStore.openConversation(conversationId);
    if (!res.opened && res.reason === 'limit') showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
  }, [showToast]);

  const handleLoadError = useCallback(() => {
    showToast('该会话已不存在或无法加载，已关闭标签');
    const active = kbChatSessionsStore.getActiveSession();
    if (active) kbChatSessionsStore.closeSession(active.id);
  }, [showToast]);

  // 面板头部活动会话的模式标签
  const activeContextLabel = (session: ChatSessionTab): string => {
    if (session.mode === 'qa') return t('kb.askButton');
    if (session.mode === 'build') return t('kb.chatContextBuildWiki');
    if (session.mode === 'lint') return t('kb.chatContextLintWiki');
    return t('kb.askButton'); // ingest 兜底
  };

  return (
    <aside
      className="file-chat-panel"
      data-testid="kb-chat-panel"
      style={{ width: panelWidth, minWidth: 280, maxWidth: '50vw' }}
    >
      <div className="file-chat-resize-handle" onMouseDown={startResize} />
      <div className="file-chat-header">
        <div className="file-chat-header-left">
          <span className="file-chat-label">
            {activeSession ? activeContextLabel(activeSession) : t('kb.askButton')}
          </span>
          {activeIsRunning && <span className="file-chat-status">{t('fileChat.running')}</span>}
        </div>
        <button type="button" className="file-chat-close" data-testid="kb-chat-close"
          onClick={() => kbChatSessionsStore.setPanelOpen(false)} title={t('fileChat.close')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <ChatSessionTabBar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onActivate={kbChatSessionsStore.activateSession}
        onClose={handleCloseTab}
        onNewSession={handleNewSession}
      />
      <div className="file-chat-session-stack">
        {sessions.map((s) => (
          <KbChatSession
            key={s.id}
            session={s}
            active={s.id === activeSessionId}
            agentId={agentId}
            vaultPath={vaultPath}
            selectedText={pendingSelection}
            onSelectedTextConsumed={() => setPendingSelection(null)}
            onRunningChange={handleRunningChange}
            onComplete={onWikiComplete}
            onLoadError={handleLoadError}
            registerApi={registerApi}
            unregisterApi={unregisterApi}
            onOpenConversation={handleOpenConversation}
          />
        ))}
      </div>
      {toast && <div className="kb-save-toast" data-testid="kb-notice">{toast}</div>}

      {/* wiki 三选一 */}
      <ConfirmDialog
        show={confirmDialog.show}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel="中断并立即执行"
        tertiaryLabel="排队等当前完成"
        danger
        onConfirm={() => handleConfirmDialog('interrupt')}
        onTertiary={() => handleConfirmDialog('queue')}
        onCancel={() => { setConfirmDialog((p) => ({ ...p, show: false })); pendingWikiRef.current = null; }}
      />
      {/* 关闭运行中会话：中断并关闭 / 后台继续并关闭 */}
      <ConfirmDialog
        show={closePendingOpen}
        title="任务正在运行"
        message="关闭该会话前，请选择对正在运行任务的处理："
        confirmLabel="中断并关闭"
        tertiaryLabel="后台继续并关闭"
        danger
        onConfirm={() => handleCloseConfirm(true)}
        onTertiary={() => handleCloseConfirm(false)}
        onCancel={() => { closePendingRef.current = null; setClosePendingOpen(false); }}
      />
    </aside>
  );
});
