/**
 * Main content area — renders files based on type:
 * - Text (md/txt/html/json/yaml): doocs/md rendering with optional typeset mode
 * - Images (png/jpg/gif/svg/webp): inline <img> preview
 * - Binary (pdf/docx/pptx): file info card + "open with system app" button
 */

import { useEffect } from 'react';
import type { FileContent } from '@molio/contracts';
import type { ThemeConfig } from './MdStylePanel';
import { MdRenderer } from './MdRenderer';
import { MdTypesetEditor } from './MdTypesetEditor';
import { MdEditor } from './MdEditor';
import { preprocessWikiEmbeds, proxyExternalImages, stripTrackingPixels } from '../../hooks/useKnowledge';
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
  /** Whether the edited content has unsaved changes */
  hasUnsavedChanges?: boolean;
  onToggleTypeset: () => void;
  onThemeConfigChange: (config: ThemeConfig) => void;
  onContentChange: (content: string) => void;
  onSave?: () => void;
  onCopy: () => void;
  onPublish: () => void;
  onBuildWiki: () => void;
  /** 当 tab bar 存在时，可选择隐藏 header 中的文件名 */
  showFileName?: boolean;
  /** 是否为编辑模式（仅文本文件） */
  isEditMode?: boolean;
  onToggleEdit?: () => void;
  /** 编辑后的内容（用于阅读模式显示未保存的更改） */
  editedContent?: string | null;
}

export function KbMainContent({
  fileContent,
  selectedFile,
  vaultId,
  vaultPath,
  isTypesetMode,
  themeConfig,
  wikiInitialized,
  hasUnsavedChanges,
  onToggleTypeset,
  onContentChange,
  onSave,
  onCopy,
  onPublish,
  onBuildWiki,
  showFileName = true,
  isEditMode = false,
  onToggleEdit,
  editedContent,
}: KbMainContentProps) {
  // Ctrl+S / Cmd+S to save
  useEffect(() => {
    if (!onSave) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onSave]);

  // No file selected — show appropriate empty state
  if (!selectedFile) {
    // No vault created yet — prompt to create a vault
    if (!vaultId) {
      return (
        <main className="kb-main">
          <div className="kb-empty-state">
            <div className="kb-empty-icon">📚</div>
            <h3>欢迎使用知识库</h3>
            <p>创建一个知识库来管理你的文档和笔记。</p>
            <p className="kb-empty-hint">知识库是存储和组织文档的地方，支持 Markdown 文件管理、AI 辅助阅读和 Wiki 生成。</p>
          </div>
        </main>
      );
    }

    // Vault exists but wiki not initialized yet
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
          <div className="kb-empty-icon">📄</div>
          <h3>未选择文件</h3>
          <p>从左侧文件树中选择一个文件查看内容。</p>
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
        {showFileName && (
          <div className="kb-header-filename-center">
            <span>
              {fileName}
              {hasUnsavedChanges && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>●</span>}
            </span>
          </div>
        )}
        <div className="kb-header-actions">
          {/* Text file actions: edit, copy, publish (typeset mode only), typeset */}
          {category === 'text' && (
            <>
              {/* Edit/Read toggle button (Milkdown WYSIWYG ↔ doocs/md read) */}
              <button
                type="button"
                className={`kb-btn ${isEditMode ? 'is-active' : ''}`}
                onClick={onToggleEdit}
                title={isEditMode ? '阅读模式' : '编辑模式'}
              >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    {isEditMode ? (
                      // Eye icon for read mode
                      <>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    ) : (
                      // Pencil icon for edit mode
                      <>
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </>
                    )}
                  </svg>
                  <span>{isEditMode ? '阅读' : '编辑'}</span>
                </button>

              {/* Save button (shown in both typeset mode and edit mode) */}
              {onSave && (
                <button type="button" className="kb-btn" onClick={onSave}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                  <span>保存</span>
                </button>
              )}

              {/* Copy and Publish buttons (only in typeset mode) */}
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

              {/* Typeset button - always at the rightmost position */}
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
          vaultId={vaultId ?? ''}
          selectedFile={selectedFile}
        />
      ) : category === 'text' && isEditMode ? (
        // Edit mode: Milkdown WYSIWYG Markdown editor
        <MdEditor
          initialContent={fileContent?.content ?? ''}
          onContentChange={onContentChange}
          selectedFile={selectedFile}
        />
      ) : category === 'text' ? (
        <div className="kb-content-area">
          {fileContent ? (
            // 优先使用编辑后的内容（未保存的更改），否则使用原始文件内容
            <MdRenderer content={proxyExternalImages(preprocessWikiEmbeds(stripTrackingPixels(editedContent ?? fileContent.content), vaultId ?? ''))} themeConfig={themeConfig} />
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
