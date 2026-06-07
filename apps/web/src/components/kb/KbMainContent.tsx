/**
 * Main content area — renders files based on type:
 * - Text (md/txt/html/json/yaml): doocs/md rendering with optional typeset mode
 * - Images (png/jpg/gif/svg/webp): inline <img> preview
 * - Binary (pdf/docx/pptx): file info card + "open with system app" button
 */

import type { FileContent } from '@molio/contracts';
import type { ThemeConfig } from './MdStylePanel';
import { MdRenderer } from './MdRenderer';
import { MdTypesetEditor } from './MdTypesetEditor';
import { api } from '../../api/client';

/** File categories for rendering strategy */
type FileCategory = 'text' | 'image' | 'binary';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);
const BINARY_EXTS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls']);

function getFileCategory(fileName: string): FileCategory {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (BINARY_EXTS.has(ext)) return 'binary';
  return 'text';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface KbMainContentProps {
  fileContent: FileContent | null;
  selectedFile: string | null;
  vaultId: string | null;
  vaultPath: string | null;
  isTypesetMode: boolean;
  themeConfig: ThemeConfig;
  wikiInitialized: boolean;
  onToggleTypeset: () => void;
  onThemeConfigChange: (config: ThemeConfig) => void;
  onContentChange: (content: string) => void;
  onCopy: () => void;
  onPublish: () => void;
  onBuildWiki: () => void;
}

export function KbMainContent({
  fileContent,
  selectedFile,
  vaultId,
  vaultPath,
  isTypesetMode,
  themeConfig,
  wikiInitialized,
  onToggleTypeset,
  onContentChange,
  onCopy,
  onPublish,
  onBuildWiki,
}: KbMainContentProps) {
  // No file selected — show empty state or wiki CTA
  if (!selectedFile) {
    if (!wikiInitialized) {
      return (
        <main className="kb-main">
          <div className="kb-empty-state">
            <div className="kb-empty-icon">🏗</div>
            <h3>构建知识库 Wiki</h3>
            <p>使用 AI 自动扫描 vault 中的文件，生成结构化的 wiki 页面。</p>
            <button type="button" className="wiki-cta-btn" onClick={onBuildWiki}>
              开始构建 Wiki
            </button>
          </div>
        </main>
      );
    }

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

  const fileName = selectedFile.split('/').pop() ?? selectedFile;
  const category = getFileCategory(fileName);

  // Build absolute path for shell.openPath (Electron only)
  const absolutePath = vaultPath && selectedFile
    ? `${vaultPath.replace(/[\\/]+$/, '')}/${selectedFile}`
    : null;

  const handleOpenExternal = () => {
    if (absolutePath && window.__electron__?.openPath) {
      window.__electron__.openPath(absolutePath);
    }
  };

  const isElectron = !!window.__electron__?.openPath;

  return (
    <main className="kb-main">
      {/* Header with filename and action buttons */}
      <div className="kb-main-header">
        <div className="kb-header-left">
          <span className="kb-header-filename">{fileName}</span>
        </div>
        <div className="kb-header-actions">
          {/* Text file actions: typeset, copy, publish */}
          {category === 'text' && (
            <>
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
            </>
          )}

          {/* Binary file: open with system app (Electron only) */}
          {category === 'binary' && isElectron && (
            <button type="button" className="kb-btn" onClick={handleOpenExternal}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              <span>用外部程序打开</span>
            </button>
          )}
        </div>
      </div>

      {/* Content area — branch by file category */}
      {category === 'text' && isTypesetMode ? (
        <MdTypesetEditor
          initialContent={fileContent?.content ?? ''}
          onContentChange={onContentChange}
        />
      ) : category === 'text' ? (
        <div className="kb-content-area">
          {fileContent ? (
            <MdRenderer content={fileContent.content} themeConfig={themeConfig} />
          ) : (
            <div className="kb-empty-state"><p>Loading...</p></div>
          )}
        </div>
      ) : category === 'image' && vaultId ? (
        <div className="kb-content-area kb-image-viewer">
          <img
            src={api.rawFileUrl(vaultId, selectedFile)}
            alt={fileName}
          />
        </div>
      ) : category === 'binary' ? (
        <div className="kb-content-area">
          <div className="kb-file-card">
            <div className="kb-file-card-icon">
              {fileName.endsWith('.pdf') ? '📄' : fileName.match(/\.docx?$/i) ? '📝' : '📁'}
            </div>
            <div className="kb-file-card-info">
              <h3>{fileName}</h3>
              <p>{fileContent ? formatFileSize(fileContent.size) : '—'}</p>
            </div>
            {isElectron && (
              <button type="button" className="kb-file-card-open" onClick={handleOpenExternal}>
                用外部程序打开
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="kb-content-area">
          <div className="kb-empty-state"><p>Loading...</p></div>
        </div>
      )}
    </main>
  );
}
