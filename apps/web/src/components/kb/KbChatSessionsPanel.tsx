// apps/web/src/components/kb/KbChatSessionsPanel.tsx
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import {
  kbChatSessionsStore, useKbChatSessions, useKbChatActiveSessionId,
  MAX_CHAT_SESSIONS,
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
  const sessions = useKbChatSessions();
  const activeSessionId = useKbChatActiveSessionId();

  const [panelWidth, setPanelWidth] = useState(500);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  // #5: pendingSelection 归属的会话 id（null = 无）。只投给目标会话，避免广播给所有空会话、
  // 被任意会话的首条消息消费。
  const [pendingSelectionSessionId, setPendingSelectionSessionId] = useState<string | null>(null);
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
  // #1: 待关闭会话是否为 wiki 模式。wiki 关闭确认只允许「中断并关闭/取消」——
  // 杜绝「后台继续并关闭」让已移除标签的 run 逃过 anyWikiRunning 单例守卫（D3 并发写同一 vault）。
  const closePendingIsWikiRef = useRef(false);
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
  const unregisterApi = useCallback((id: string) => {
    sessionApisRef.current.delete(id);
    // #7: 会话在 mount 前就被关闭 → 清掉缓存的待自动发送提示词，避免泄漏
    pendingAutoSendRef.current.delete(id);
  }, []);
  const handleRunningChange = useCallback((id: string, running: boolean) => {
    setRunningMap((prev) => (prev[id] === running ? prev : { ...prev, [id]: running }));
  }, []);
  // #7: 会话关闭时同步清理 runningMap，防止残留条目误判互斥/关闭态
  const pruneRunning = useCallback((id: string) => {
    setRunningMap((prev) => {
      if (!(id in prev)) return prev;
      const n = { ...prev };
      delete n[id];
      return n;
    });
  }, []);

  // 传给标签栏：哪些会话在运行（驱动标签上的运行指示点）
  const runningSessionIds = useMemo(
    () => new Set(Object.entries(runningMap).filter(([, v]) => v).map(([k]) => k)),
    [runningMap],
  );
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
    // cancel 的网络失败不中止中断（同 useChatCore.send 里 api.cancelRun().catch(() => {}) 模式）：
    // 旧进程可能没杀掉，但 clear + 新 run 照常进行，避免中断无响应。
    try {
      await a.cancel();
    } catch { /* cancel 失败仍继续 clear + send */ }
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
    if (opts.selectedText) {
      // #5: pendingSelection 只投给目标会话（活跃 qa 会话，或新建的 qa 会话），
      // 不再面板级广播给所有空会话。
      setPendingSelection(opts.selectedText);
      setPendingSelectionSessionId(active?.mode === 'qa' ? active.id : null);
    }
    if (active && active.mode === 'qa') {
      kbChatSessionsStore.setPanelOpen(true);
      // #4: 用户对「新选中的文件」再次 💬问答 → 把活跃 qa 会话的 @上下文指向该文件，
      // 否则 composer badge 仍显示旧文档（D7「每个会话记忆自己的文档」依然成立——
      // 显式问答动作把会话重新指向当前文件，恢复旧单会话行为）。
      kbChatSessionsStore.updateSession(active.id, {
        filePath: opts.filePath,
        vaultId: opts.vaultId ?? active.vaultId,
      });
      return;
    }
    const res = kbChatSessionsStore.openSession({
      mode: 'qa', title: '新会话', conversationId: null,
      vaultId: opts.vaultId ?? undefined, filePath: opts.filePath,
    });
    if (res.opened && res.tab) {
      if (opts.selectedText) setPendingSelectionSessionId(res.tab.id);
    } else if (!res.opened && res.reason === 'limit') {
      // 创建失败（达上限）→ 放弃这次 pendingSelection，避免悬空预览
      setPendingSelection(null);
      setPendingSelectionSessionId(null);
      showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
    }
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
      // #1: 记录被关闭会话的模式 —— wiki 模式只允许「中断并关闭/取消」。
      closePendingIsWikiRef.current =
        kbChatSessionsStore.getSessions().find((s) => s.id === id)?.mode !== 'qa';
      setClosePendingOpen(true);
      return;
    }
    kbChatSessionsStore.closeSession(id);
    pruneRunning(id);
  }, [runningMap, pruneRunning]);

  const handleCloseConfirm = useCallback((interrupt: boolean) => {
    const id = closePendingRef.current;
    closePendingRef.current = null;
    closePendingIsWikiRef.current = false;
    setClosePendingOpen(false);
    if (!id) return;
    if (interrupt) sessionApisRef.current.get(id)?.cancel();
    kbChatSessionsStore.closeSession(id);
    pruneRunning(id);
  }, [pruneRunning]);

  const handleOpenConversation = useCallback((conversationId: string) => {
    const active = kbChatSessionsStore.getActiveSession();
    const activeRunning = active ? runningMap[active.id] : false;
    if (activeRunning) {
      // 运行中会话禁止就地切换 —— 开新标签保留直播中的会话（切历史不中断回复）。
      // openSession 已按 conversationId 去重（目标会话已在其他标签 → 激活，不重复建标签）；
      // 新建标签 mount 时自动从 DB 加载 + 恢复活跃 run。
      const res = kbChatSessionsStore.openSession({
        mode: 'qa', title: '加载中…', conversationId, filePath: null,
      });
      if (!res.opened && res.reason === 'limit') {
        showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
      }
      return;
    }
    const res = kbChatSessionsStore.openConversation(conversationId);
    if (res.reason === 'limit') {
      showToast(`已达 ${MAX_CHAT_SESSIONS} 个会话标签上限`);
      return;
    }
    // 就地切换（不新建标签）：store 已更新活动会话的 conversationId，这里触发它真正加载
    if (res.switched && res.tab) {
      sessionApisRef.current.get(res.tab.id)?.loadConversation?.(conversationId);
    }
  }, [runningMap, showToast]);

  const handleLoadError = useCallback((sessionId: string) => {
    showToast('该会话已不存在或无法加载，已关闭标签');
    // #2: 只关「报错的那个」会话标签（可能是隐藏标签），不误关当前活跃标签。
    // closeSession 内部已守卫不存在；这里仍做一次存在性校验以免误 toast 后无标签可关。
    if (kbChatSessionsStore.getSessions().some((s) => s.id === sessionId)) {
      kbChatSessionsStore.closeSession(sessionId);
      pruneRunning(sessionId);
    }
  }, [showToast, pruneRunning]);

  // 面板头部活动会话的模式标签
  return (
    <aside
      className="file-chat-panel"
      data-testid="kb-chat-panel"
      style={{ width: panelWidth, minWidth: 280, maxWidth: '50vw' }}
    >
      <div className="file-chat-resize-handle" onMouseDown={startResize} />
      <ChatSessionTabBar
        sessions={sessions}
        activeSessionId={activeSessionId}
        runningSessionIds={runningSessionIds}
        onActivate={kbChatSessionsStore.activateSession}
        onClose={handleCloseTab}
        onNewSession={handleNewSession}
        onOpenConversation={handleOpenConversation}
        onClosePanel={() => kbChatSessionsStore.setPanelOpen(false)}
      />
      <div className="file-chat-session-stack">
        {sessions.length === 0 ? (
          <div className="file-chat-sessions-empty" data-testid="kb-chat-sessions-empty">
            <div className="file-chat-empty-icon">💬</div>
            <p>还没有会话，点右侧「+」新建一个会话</p>
            <button type="button" className="kb-btn kb-btn-ghost" onClick={handleNewSession}>
              + 新建会话
            </button>
          </div>
        ) : (
          sessions.map((s) => (
            <KbChatSession
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              agentId={agentId}
              vaultPath={vaultPath}
              selectedText={pendingSelectionSessionId === s.id ? pendingSelection : null}
              onSelectedTextConsumed={() => { setPendingSelection(null); setPendingSelectionSessionId(null); }}
              onRunningChange={handleRunningChange}
              onComplete={onWikiComplete}
              onLoadError={handleLoadError}
              registerApi={registerApi}
              unregisterApi={unregisterApi}
            />
          ))
        )}
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
      {/* 关闭运行中会话：qa 会话 → 中断并关闭 / 后台继续并关闭；wiki 会话 → 只有中断并关闭/取消（#1） */}
      <ConfirmDialog
        show={closePendingOpen}
        title="任务正在运行"
        message={closePendingIsWikiRef.current
          ? '关闭该会话将中断正在运行的 Wiki 任务，Wiki 任务不支持后台继续。'
          : '关闭该会话前，请选择对正在运行任务的处理：'}
        confirmLabel="中断并关闭"
        tertiaryLabel={closePendingIsWikiRef.current ? undefined : '后台继续并关闭'}
        danger
        onConfirm={() => handleCloseConfirm(true)}
        onTertiary={closePendingIsWikiRef.current ? undefined : () => handleCloseConfirm(false)}
        onCancel={() => { closePendingRef.current = null; closePendingIsWikiRef.current = false; setClosePendingOpen(false); }}
      />
    </aside>
  );
});
