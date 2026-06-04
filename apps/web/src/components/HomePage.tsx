import { useRef, useEffect, useCallback, useMemo } from 'react';
import { ChatComposer } from './ChatComposer';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import type { ChatMessage } from '../hooks/useChat';

interface Props {
  selectedAgentName: string | null;
  messages: ChatMessage[];
  isRunning: boolean;
  onSend: (message: string) => void;
  onCancel: () => void;
  onNewChat: () => void;
  onSubmitToolResult?: (toolUseId: string, content: string) => Promise<void>;
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
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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

  // If there are messages, show chat layout
  if (messages.length > 0) {
    return (
      <div className="home-page chat-active">
        {/* Header */}
        <div className="home-header">
          <div className="home-header-left">
            <span className="home-header-logo">K</span>
            <span className="home-header-title">Knowledge Growth Engine</span>
          </div>
          <div className="home-header-right">
            {!isRunning && (
              <button type="button" className="icon-only" onClick={onNewChat} title="New chat">
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
                  onSubmitForm={onSend}
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
            onSend={onSend}
            onCancel={onCancel}
            disabled={!selectedAgentName}
            disabledPlaceholder="No agent selected — set a default in Runtimes"
          />
        </div>
      </div>
    );
  }

  // Landing page — no messages yet
  return (
    <div className="home-page home-landing">
      <div className="home-landing-content">
        {/* Brand */}
        <div className="home-brand">
          <div className="home-brand-logo">K</div>
          <div className="home-brand-title">知识增长引擎</div>
          <div className="home-brand-subtitle">
            典策法书，藏于兰台。博观约取，厚积薄发。
          </div>
        </div>

        {/* Feature cards */}
        <div className="home-features">
          <div className="home-feature-card">
            <div className="home-feature-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <div className="home-feature-body">
              <div className="home-feature-title">知识库管理</div>
              <div className="home-feature-desc">本地知识库，结构化管理文档与笔记</div>
            </div>
          </div>
          <div className="home-feature-card">
            <div className="home-feature-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </div>
            <div className="home-feature-body">
              <div className="home-feature-title">AI 写作助手</div>
              <div className="home-feature-desc">调用 Claude / Codex 智能创作与编写文档</div>
            </div>
          </div>
          <div className="home-feature-card">
            <div className="home-feature-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
            </div>
            <div className="home-feature-body">
              <div className="home-feature-title">多平台发布</div>
              <div className="home-feature-desc">Markdown 排版，一键分发到 30+ 内容平台</div>
            </div>
          </div>
        </div>

        {/* Quick prompts */}
        <div className="home-quick-prompts">
          <button
            type="button"
            className="home-quick-chip"
            onClick={() => onSend('帮我写一篇关于 AI 技术趋势的文章')}
            disabled={!selectedAgentName}
          >
            ✍️ 写一篇 AI 技术趋势文章
          </button>
          <button
            type="button"
            className="home-quick-chip"
            onClick={() => onSend('整理我的知识库，生成一份目录索引')}
            disabled={!selectedAgentName}
          >
            📚 整理知识库目录
          </button>
          <button
            type="button"
            className="home-quick-chip"
            onClick={() => onSend('帮我把这篇笔记排版成适合微信公众号发布的格式')}
            disabled={!selectedAgentName}
          >
            📤 排版并发布文章
          </button>
        </div>

        {/* Composer */}
        <div className="home-composer-wrap">
          <ChatComposer
            isRunning={isRunning}
            onSend={onSend}
            onCancel={onCancel}
            disabled={!selectedAgentName}
            disabledPlaceholder="No agent selected — set a default in Runtimes"
          />
        </div>
      </div>
    </div>
  );
}
