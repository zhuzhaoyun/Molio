// apps/web/src/components/FileOperationCard.tsx
import { useState } from 'react';
import { DiffView } from './DiffView';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { useActiveVaultId } from '../stores/vaultStore';
import { useI18n } from '../i18n';
import './FileOperationCard.css';

interface Props {
  filePath: string;
  toolName: string;
  /** The raw input from the tool event, expected to contain old_string/new_string for Edit tool */
  toolInput: unknown;
}

/** Tool names that create a file from scratch (full content), vs. Edit which patches. */
const WRITE_TOOL_NAMES = new Set(['Write', 'write', 'write_file', 'WriteFile']);

/**
 * Try to extract old_string and new_string from a tool input.
 * Uses toolName to reliably distinguish Write (content) from Edit
 * (old_string/new_string) — previously an Edit with an empty old_string
 * (e.g. an insertion) was misclassified as a Write.
 */
function extractDiffInput(toolName: string, input: unknown): { oldStr: string; newStr: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
    return { oldStr: obj.old_string, newStr: obj.new_string };
  }
  // Write tool: old is empty, new is the full content
  if (WRITE_TOOL_NAMES.has(toolName) && typeof obj.content === 'string') {
    return { oldStr: '', newStr: obj.content };
  }
  return null;
}

export function FileOperationCard({ filePath, toolName, toolInput }: Props) {
  const { t } = useI18n();
  const [showDiff, setShowDiff] = useState(false);
  const { openFile, askAboutFile } = useFileNavigation();
  // Subscribe reactively so the card re-renders when the active vault changes;
  // the imperative getActiveVaultId() read in render does not trigger updates.
  const vaultId = useActiveVaultId();

  const diffInput = extractDiffInput(toolName, toolInput);
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
            {t('fileOp.open')}
          </button>
        )}
        {diffInput && (
          <button
            type="button"
            className="file-op-card-btn"
            data-testid="file-op-diff-toggle"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? t('fileOp.collapseChanges') : t('fileOp.viewChanges')}
          </button>
        )}
        {vaultId && (
          <button type="button" className="file-op-card-btn" data-testid="file-op-discuss" onClick={handleDiscuss}>
            💬 {t('fileOp.discuss')}
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
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    const obj = toolInput as Record<string, unknown>;
    if (typeof obj.file_path === 'string') return obj.file_path;
    if (typeof obj.filePath === 'string') return obj.filePath;
    if (typeof obj.path === 'string') return obj.path;
  }
  return null;
}
