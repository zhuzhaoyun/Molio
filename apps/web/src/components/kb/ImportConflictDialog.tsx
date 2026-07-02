/**
 * Import conflict dialog — shown when files already exist at the target.
 * Presents three strategies (skip / rename / replace) with clear visual
 * distinction between selected and unselected options.
 */

import { useState } from 'react';

interface ConflictFile {
  file: string;
}

interface ImportConflictDialogProps {
  show: boolean;
  conflicts: ConflictFile[];
  onCancel: () => void;
  onContinue: (strategy: 'skip' | 'replace' | 'rename') => void;
}

const STRATEGIES = [
  {
    value: 'rename' as const,
    label: '保留两者',
    desc: '新文件自动重命名，已有文件不受影响',
  },
  {
    value: 'skip' as const,
    label: '跳过',
    desc: '不导入这些文件，保留已有文件',
  },
  {
    value: 'replace' as const,
    label: '替换',
    desc: '用新文件覆盖已有文件',
  },
];

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
      <div className="kb-modal" style={{ width: 440 }}>
        <div className="kb-modal-header">
          <h2>文件冲突</h2>
          <button className="kb-modal-close" onClick={onCancel}>&times;</button>
        </div>

        <div className="kb-modal-body" style={{ padding: '14px 20px', overflowY: 'auto' }}>
          <p className="conflict-desc">
            {conflicts.length} 个文件在目标位置已存在：
          </p>

          <ul className="conflict-file-list">
            {conflicts.map((c) => (
              <li key={c.file} className="conflict-file-item">
                <span className="conflict-file-icon">📄</span>
                <span className="conflict-file-name">{c.file}</span>
              </li>
            ))}
          </ul>

          <p className="conflict-desc">选择处理方式：</p>

          <div className="conflict-strategy-list">
            {STRATEGIES.map((s) => (
              <label
                key={s.value}
                className={`conflict-strategy-option${strategy === s.value ? ' is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="conflict-strategy"
                  value={s.value}
                  checked={strategy === s.value}
                  onChange={() => setStrategy(s.value)}
                />
                <span className="conflict-strategy-text">
                  <span className="conflict-strategy-label">{s.label}</span>
                  <span className="conflict-strategy-desc">{s.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="kb-modal-footer">
          <button className="kb-btn" onClick={onCancel}>取消</button>
          <button className="kb-btn kb-btn-primary" onClick={() => onContinue(strategy)}>
            继续
          </button>
        </div>
      </div>
    </div>
  );
}
