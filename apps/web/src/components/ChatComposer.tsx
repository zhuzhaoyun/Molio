import { useState, useRef, useEffect } from 'react';

interface Props {
  isRunning: boolean;
  onSend: (message: string) => void;
  onCancel: () => void;
}

export function ChatComposer({ isRunning, onSend, onCancel }: Props) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 184) + 'px';
    }
  }, [text]);

  // Focus on mount and when run completes
  useEffect(() => {
    if (!isRunning) textareaRef.current?.focus();
  }, [isRunning]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (trimmed && !isRunning) {
      onSend(trimmed);
      setText('');
      // Reset textarea height
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = text.trim().length > 0 && !isRunning;

  return (
    <div className="composer">
      <div className="composer-shell">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? 'Waiting for response...' : 'Type a message...'}
          disabled={isRunning}
          rows={1}
        />
        <div className="composer-row">
          <span className="composer-spacer" />
          {isRunning ? (
            <button
              type="button"
              className="composer-send stop"
              onClick={onCancel}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              </svg>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              disabled={!canSend}
              onClick={handleSend}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              Send
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">Shift+Enter for new line</div>
    </div>
  );
}
