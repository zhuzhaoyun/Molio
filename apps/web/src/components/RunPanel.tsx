import { useState } from 'react';

interface Props {
  isRunning: boolean;
  onSubmit: (message: string) => void;
  onCancel: () => void;
  onReset: () => void;
  hasRun: boolean;
}

export function RunPanel({ isRunning, onSubmit, onCancel, onReset, hasRun }: Props) {
  const [message, setMessage] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && !isRunning) {
      onSubmit(message.trim());
      setMessage('');
    }
  };

  return (
    <div className="run-panel">
      <form onSubmit={handleSubmit}>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Enter your prompt..."
          rows={3}
          disabled={isRunning}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
        />
        <div className="run-actions">
          {!isRunning && (
            <button type="submit" className="btn-primary" disabled={!message.trim()}>
              {hasRun ? 'New Run' : 'Send'}
            </button>
          )}
          {isRunning && (
            <button type="button" className="btn-danger" onClick={onCancel}>
              Cancel
            </button>
          )}
          {hasRun && !isRunning && (
            <button type="button" className="btn-secondary" onClick={onReset}>
              Clear
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
