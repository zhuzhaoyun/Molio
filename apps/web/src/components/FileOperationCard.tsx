// apps/web/src/components/FileOperationCard.tsx
import { useState } from 'react';
import { DiffView } from './DiffView';
import { useFileNavigation } from '../hooks/useFileNavigation';
import './FileOperationCard.css';

interface Props {
  filePath: string;
  toolName: string;
  /** The raw input from the tool event, expected to contain old_string/new_string for Edit tool */
  toolInput: unknown;
}

/** Try to extract old_string and new_string from a tool input. */
function extractDiffInput(input: unknown): { oldStr: string; newStr: string } | null {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
      return { oldStr: obj.old_string, newStr: obj.new_string };
    }
    // Write tool: old is empty, new is the content
    if (typeof obj.content === 'string' && !obj.old_string) {
      return { oldStr: '', newStr: obj.content };
    }
  }
  return null;
}

export function FileOperationCard({ filePath, toolName, toolInput }: Props) {
  const [showDiff, setShowDiff] = useState(false);
  const { openFile, askAboutFile, getActiveVaultId } = useFileNavigation();
  const vaultId = getActiveVaultId();

  const diffInput = extractDiffInput(toolInput);
  const fileName = filePath.split('/').pop() ?? filePath;

  const handleOpen = () => {
    if (vaultId) openFile(vaultId, filePath);
  };

  const handleDiscuss = () => {
    if (vaultId) askAboutFile(vaultId, filePath);
  };

  return (
    <div className="file-op-card" data-testid="file-op-card">
      <div className="file-op-card-header">
        <span className="file-op-card-icon">📄</span>
        <span className="file-op-card-path" title={filePath}>{fileName}</span>
      </div>
      <div className="file-op-card-actions">
        {vaultId && (
          <button type="button" className="file-op-card-btn" data-testid="file-op-open" onClick={handleOpen}>
            打开文件
          </button>
        )}
        {diffInput && (
          <button
            type="button"
            className="file-op-card-btn"
            data-testid="file-op-diff-toggle"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? '收起变更' : '查看本次修改'}
          </button>
        )}
        {vaultId && (
          <button type="button" className="file-op-card-btn" data-testid="file-op-discuss" onClick={handleDiscuss}>
            💬 讨论这个文件
          </button>
        )}
      </div>
      {showDiff && diffInput && (
        <div className="file-op-card-diff">
          <DiffView oldStr={diffInput.oldStr} newStr={diffInput.newStr} />
        </div>
      )}
    </div>
  );
}

/** Check if a tool event represents a file write operation. */
export function isFileWriteTool(toolName: string): boolean {
  const writeTools = ['Write', 'Edit', 'write', 'edit', 'write_file', 'edit_file', 'WriteFile', 'EditFile'];
  return writeTools.includes(toolName);
}

/** Extract file path from tool input (best-effort). */
export function extractFilePath(toolInput: unknown): string | null {
  if (toolInput && typeof toolInput === 'object') {
    const obj = toolInput as Record<string, unknown>;
    if (typeof obj.file_path === 'string') return obj.file_path;
    if (typeof obj.filePath === 'string') return obj.filePath;
    if (typeof obj.path === 'string') return obj.path;
  }
  return null;
}
