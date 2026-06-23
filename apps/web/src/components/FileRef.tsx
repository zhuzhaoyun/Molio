import { useCallback } from 'react';
import { useFileNavigation } from '../hooks/useFileNavigation';
import './FileRef.css';

export interface FileRefProps {
  vaultId: string;
  filePath: string;
  /** Display name — defaults to filename extracted from path. */
  displayName?: string;
  /** CSS class override. */
  className?: string;
}

function extractFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function getFileIcon(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'md') return '📄';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') return '🖼️';
  if (ext === 'pdf') return '📕';
  return '📄';
}

export function FileRef({ vaultId, filePath, displayName, className }: FileRefProps) {
  const { openFile } = useFileNavigation();
  const name = displayName || extractFileName(filePath);
  const icon = getFileIcon(filePath);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openFile(vaultId, filePath);
    },
    [openFile, vaultId, filePath],
  );

  return (
    <a
      className={`file-ref ${className ?? ''}`}
      data-testid="file-ref"
      data-file-path={filePath}
      data-file-vault={vaultId}
      title={`${filePath}\n点击打开文件`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
    >
      <span className="file-ref__icon">{icon}</span>
      <span className="file-ref__name">{name}</span>
    </a>
  );
}
