import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChatComposer } from './ChatComposer';
import type { FileRef } from './ChatComposer';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { useI18n } from '../i18n';
import type { ChatMessage } from '../hooks/useChat';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useActiveVault } from '../stores/vaultStore';
import { api } from '../api/client';
import type { TreeNode } from '@molio/contracts';

interface Props {
  selectedAgentName: string | null;
  messages: ChatMessage[];
  isRunning: boolean;
  onSend: (message: string) => void;
  onCancel: () => void;
  onNewChat: () => void;
  onSubmitToolResult?: (toolUseId: string, content: string) => Promise<void>;
}

/** Flatten tree into files, sort by modifiedAt desc, take top N. */
function getRecentFiles(tree: TreeNode[], count: number): TreeNode[] {
  const files: TreeNode[] = [];
  function walk(nodes: TreeNode[]) {
    for (const n of nodes) {
      if (n.type === 'file') files.push(n);
      if (n.children) walk(n.children);
    }
  }
  walk(tree);
  files.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  return files.slice(0, count);
}

/** Format time ago in Chinese. */
function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}个月前`;
}

export function HomePage({
  selectedAgentName,
  messages,
  isRunning,
  onSend,
  onCancel,
  onNewChat,
  onSubmitToolResult,
}: Props) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeVault = useActiveVault();
  const { openFile } = useFileNavigation();

  // Recent files state
  const [recentFiles, setRecentFiles] = useState<TreeNode[]>([]);

  // Fetch recent files when vault changes
  useEffect(() => {
    if (!activeVault) {
      setRecentFiles([]);
      return;
    }
    let cancelled = false;
    api.getFileTree(activeVault.id)
      .then((tree) => {
        if (!cancelled) setRecentFiles(getRecentFiles(tree, 5));
      })
      .catch(() => {
        if (!cancelled) setRecentFiles([]);
      });
    return () => { cancelled = true; };
  }, [activeVault?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  // Find the last assistant message ID so only that card stays interactive
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === 'assistant') return msg.id;
    }
    return null;
  }, [messages]);

  // Wire onAnswerToolUse: route tool_result back to the open stream-json child
  const onAnswerToolUse = useCallback(
    async (toolUseId: string, content: string) => {
      if (!onSubmitToolResult) return false;
      try {
        await onSubmitToolResult(toolUseId, content);
        return true;
      } catch {
        return false;
      }
    },
    [onSubmitToolResult],
  );

  // Wrap onSend to handle fileRefs → message prefix
  const handleSend = useCallback(
    (message: string, fileRefs?: FileRef[]) => {
      if (fileRefs && fileRefs.length > 0) {
        const prefix = fileRefs
          .map((r) => `[📄 ${r.filePath.split('/').pop() ?? r.filePath}](${r.filePath})`)
          .join(' ');
        const fullMessage = `${prefix}\n\n${message || '请根据以上文件帮我分析。'}`;
        onSend(fullMessage);
      } else {
        onSend(message);
      }
    },
    [onSend],
  );

  // Command callbacks
  const handleCommand = useCallback(
    (key: string) => {
      switch (key) {
        case 'new-chat':
          onNewChat();
          break;
        case 'new-doc':
          navigate('/knowledge');
          break;
        case 'polish':
          handleSend('请帮我优化以下文字的表达，使其更清晰流畅：', []);
          break;
        case 'outline':
          handleSend('请为以下内容生成一个结构化大纲：', []);
          break;
      }
    },
    [onNewChat, navigate, handleSend],
  );

  // If there are messages, show chat layout
  if (messages.length > 0) {
    return (
      <div className="home-page chat-active">
        {/* Header */}
        <div className="home-header">
          <div className="home-header-left">
            <span className="home-header-logo">墨</span>
            <span className="home-header-title">Molio</span>
          </div>
          <div className="home-header-right">
            {!isRunning && (
              <button type="button" data-testid="new-chat-btn" className="icon-only" onClick={onNewChat} title={t('home.newChat')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
            {selectedAgentName && (
              <span className="home-active-agent">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                {selectedAgentName}
              </span>
            )}
          </div>
        </div>

        {/* Chat log */}
        <div className="home-chat-log" ref={logRef}>
          {messages.map((msg) => {
            if (msg.role === 'user') {
              return <UserMessage key={msg.id} content={msg.content} timestamp={msg.timestamp} />;
            }
            if (msg.role === 'assistant') {
              return (
                <AssistantMessage
                  key={msg.id}
                  message={msg}
                  isLast={msg.id === lastAssistantId}
                  onAnswerToolUse={onSubmitToolResult ? onAnswerToolUse : undefined}
                  onSubmitForm={(text: string) => handleSend(text, [])}
                />
              );
            }
            if (msg.role === 'error') {
              return (
                <div key={msg.id} className="msg error">
                  {msg.content}
                </div>
              );
            }
            return null;
          })}
          <div ref={bottomRef} />
        </div>

        {/* Composer at the bottom */}
        <div className="home-composer-bar">
          <ChatComposer
            isRunning={isRunning}
            onSend={handleSend}
            onCancel={onCancel}
            disabled={!selectedAgentName}
            disabledPlaceholder={t('home.noAgent')}
            onCommand={handleCommand}
          />
        </div>
      </div>
    );
  }

  // Landing page — no messages yet
  return (
    <div className="home-page home-landing">
      <div className="home-hero-view">
        {/* Hero */}
        <div className="home-hero">
          <div className="home-hero__brand">
            <span className="home-hero__brand-mark">墨</span>
            <span className="home-hero__brand-name" data-testid="hero-brand">Molio</span>
          </div>
          <p className="home-hero__tagline" data-testid="hero-tagline">{t('home.tagline')}</p>
        </div>

        {/* Recent files + Quick actions */}
        <div className="home-landing-sections">
          {/* Recent files */}
          {activeVault && (
            <div className="home-recent-files" data-testid="home-recent-files">
              <div className="home-recent-header">最近文件</div>
              {recentFiles.length === 0 ? (
                <div className="home-recent-empty">暂无文件</div>
              ) : (
                recentFiles.map((f) => (
                  <div
                    key={f.path}
                    className="home-recent-item"
                    data-testid="home-recent-item"
                    onClick={() => openFile(activeVault.id, f.path)}
                  >
                    <span className="home-recent-item-icon">📄</span>
                    <span className="home-recent-item-name">{f.name}</span>
                    <span className="home-recent-item-time">
                      {f.modifiedAt ? timeAgo(f.modifiedAt) : ''}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Quick actions */}
          <div className="home-quick-actions">
            <button
              type="button"
              className="home-quick-btn"
              data-testid="home-quick-new-doc"
              onClick={() => navigate('/knowledge')}
            >
              📝 新建文档
            </button>
            <button
              type="button"
              className="home-quick-btn"
              data-testid="home-quick-browse-kb"
              onClick={() => navigate('/knowledge')}
            >
              📂 浏览知识库
            </button>
          </div>
        </div>

        {/* Composer */}
        <div className="home-composer-wrap">
          <ChatComposer
            isRunning={isRunning}
            onSend={handleSend}
            onCancel={onCancel}
            onCommand={handleCommand}
            disabled={!selectedAgentName}
            disabledPlaceholder={t('home.noAgent')}
          />
        </div>
      </div>
    </div>
  );
}
