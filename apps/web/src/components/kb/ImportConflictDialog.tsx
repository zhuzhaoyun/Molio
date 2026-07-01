/**
 * Import conflict dialog — shown when files already exist at the target.
 * macOS Finder style: radio button strategy selection + "apply to all" checkbox.
 */

import { useState, useCallback } from 'react';

interface ConflictFile {
  file: string;
}

interface ImportConflictDialogProps {
  show: boolean;
  conflicts: ConflictFile[];
  onCancel: () => void;
  onContinue: (strategy: 'skip' | 'replace' | 'rename') => void;
}

export function ImportConflictDialog({
  show,
  conflicts,
  onCancel,
  onContinue,
}: ImportConflictDialogProps) {
  const [strategy, setStrategy] = useState<'skip' | 'rename' | 'replace'>('rename');

  if (!show) return null;

  return (
    <div
      className="kb-overlay show"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="kb-modal" style={{ width: 480 }}>
        <div className="kb-modal-header">
          <h2>文件冲突</h2>
          <button className="kb-modal-close" onClick={onCancel}>&times;</button>
        </div>
        <div className="kb-modal-body">
          <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 10 }}>
            以下文件在目标位置已存在：
          </p>
          <div
            style={{
              maxHeight: 160,
              overflowY: 'auto',
              marginBottom: 16,
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {conflicts.map((c, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  fontSize: 12.5,
                  color: 'var(--text)',
                  borderBottom: i < conflicts.length - 1 ? '1px solid var(--border)' : 'none',
                }}
              >
                <span style={{ fontSize: 14 }}>📄</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.file}
                </span>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            操作
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              ['skip', '跳过 — 保留已有文件'],
              ['rename', '保留两者 — 新文件自动重命名'],
              ['replace', '替换 — 覆盖已有文件'],
            ] as const).map(([val, label]) => (
              <label
                key={val}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  background: strategy === val ? 'var(--accent-tint)' : 'transparent',
                  fontSize: 13,
                  color: 'var(--text)',
                }}
              >
                <input
                  type="radio"
                  name="conflict-strategy"
                  value={val}
                  checked={strategy === val}
                  onChange={() => setStrategy(val)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="kb-modal-footer">
          <button className="kb-btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="kb-btn kb-btn-primary"
            onClick={() => onContinue(strategy)}
          >
            继续
          </button>
        </div>
      </div>
    </div>
  );
}
