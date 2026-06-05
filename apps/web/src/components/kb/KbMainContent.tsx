/**
 * Main content area — doocs/md rendering with optional typeset mode.
 *
 * Default mode: Direct doocs/md rendering
 * Typeset mode: Three-column editor (editor | preview | style panel)
 */

import type { FileContent } from '@molio/contracts';
import type { ThemeConfig } from './MdStylePanel';
import { MdRenderer } from './MdRenderer';
import { MdTypesetEditor } from './MdTypesetEditor';

interface KbMainContentProps {
  fileContent: FileContent | null;
  selectedFile: string | null;
  isTypesetMode: boolean;
  themeConfig: ThemeConfig;
  onToggleTypeset: () => void;
  onThemeConfigChange: (config: ThemeConfig) => void;
  onContentChange: (content: string) => void;
  onCopy: () => void;
  onPublish: () => void;
}

export function KbMainContent({
  fileContent,
  selectedFile,
  isTypesetMode,
  themeConfig,
  onToggleTypeset,
  onContentChange,
  onCopy,
  onPublish,
}: KbMainContentProps) {
  // No file selected — show empty state
  if (!selectedFile) {
    return (
      <main className="kb-main">
        <div className="kb-empty-state">
          <div className="kb-empty-icon">📚</div>
          <h3>No file selected</h3>
          <p>Select a file from the tree to view its content.</p>
        </div>
      </main>
    );
  }

  // Get the filename from the path
  const fileName = selectedFile.split('/').pop() ?? selectedFile;

  return (
    <main className="kb-main">
      {/* Header with filename and action buttons */}
      <div className="kb-main-header">
        <div className="kb-header-left">
          <span className="kb-header-filename">{fileName}</span>
        </div>
        <div className="kb-header-actions">
          {/* Typeset toggle - always visible */}
          <button
            type="button"
            className={`kb-btn ${isTypesetMode ? 'is-active' : ''}`}
            onClick={onToggleTypeset}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <path d="M4 7V4h16v3" />
              <path d="M9 20h6" />
              <path d="M12 4v16" />
            </svg>
            <span>{isTypesetMode ? '退出排版' : '排版'}</span>
          </button>

          {/* Additional buttons only in typeset mode */}
          {isTypesetMode && (
            <>
              <button type="button" className="kb-btn" onClick={onCopy}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>复制</span>
              </button>
              <button type="button" className="kb-btn" onClick={onPublish}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span>发布</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Content area */}
      {isTypesetMode ? (
        <MdTypesetEditor
          initialContent={fileContent?.content ?? ''}
          onContentChange={onContentChange}
        />
      ) : (
        <div className="kb-content-area">
          {fileContent ? (
            <MdRenderer
              content={fileContent.content}
              themeConfig={themeConfig}
            />
          ) : (
            <div className="kb-empty-state">
              <p>Loading...</p>
            </div>
          )}
        </div>
      )}
    </main>
  );
}