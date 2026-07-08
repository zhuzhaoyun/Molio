/**
 * Main content area — renders files based on type:
 * - Text (md/txt/html/json/yaml): doocs/md rendering with optional typeset mode
 * - Images (png/jpg/gif/svg/webp): inline <img> preview
 * - Binary (pdf/docx/pptx): file info card + "open with system app" button
 */

import { useEffect, useState, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import type { FileContent } from '@molio/contracts';
import type { ThemeConfig } from './MdStylePanel';
import { MdRenderer } from './MdRenderer';
import { MdTypesetEditor } from './MdTypesetEditor';
import { MdEditor } from './MdEditor';
import { ContextMenu } from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import { TooLargeCard } from './TooLargeCard';
import { ViewerErrorBoundary } from './ViewerErrorBoundary';
import type { KbCodeMirrorViewerHandle } from './KbCodeMirrorViewer';
import { formatFileSize } from '../../utils/format';
import { preprocessWikiEmbeds, proxyExternalImages, stripTrackingPixels } from '../../hooks/useKnowledge';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Lazy-load the CodeMirror viewer (heavy CM bundle) only when a text file
// actually takes the CM path (non-md / large md). Named export → default shape.
const KbCodeMirrorViewer = lazy(() =>
  import('./KbCodeMirrorViewer').then((m) => ({ default: m.KbCodeMirrorViewer })),
);

/** .md files at or below this size still render via doocs/md. Above → source mode. */
const MD_RENDER_THRESHOLD = 1 * 1024 * 1024;
const MD_EXTS = new Set(['.md', '.markdown']);
/**
 * Max selection length sent to QA via "就此提问" (chars). Mirrors
 * KbCodeMirrorViewer.MAX_ASK_SELECTION — inlined here (rather than imported)
 * so the CodeMirror bundle stays in the lazy chunk and out of the main bundle.
 */
const MAX_ASK_SELECTION = 50 * 1024;

/**
 * Lazy singleton HTML→Markdown converter. Used by the copy action to write a
 * Markdown `text/plain` slot alongside `text/html`, so pasting a table (or
 * any selection) into Obsidian / a Markdown editor / 记事本 yields Markdown
 * source instead of flat text or HTML. GFM plugin enables pipe-table support.
 */
let _turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!_turndown) {
    _turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
    _turndown.use(gfm);
  }
  return _turndown;
}

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

/** CJK character range + English word count. Returns "word count" (CJK each char = 1 + English word count). */
function countWords(text: string): number {
  const cjkMatches = text.match(/[一-鿿㐀-䶿]/g);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  // English words (strip CJK then split by non-alphanumeric)
  const stripped = text.replace(/[一-鿿㐀-䶿]/g, ' ');
  const enMatches = stripped.match(/[A-Za-z0-9]+/g);
  const en = enMatches ? enMatches.length : 0;
  return cjk + en;
}

function formatReadTime(words: number, suffix: string): string {
  const mins = Math.max(1, Math.ceil(words / 300));
  return `~${mins} ${suffix}`;
}

interface KbMainContentProps {
  fileContent: FileContent | null;
  selectedFile: string | null;
  vaultId: string | null;
  vaultPath: string | null;
  isTypesetMode: boolean;
  themeConfig: ThemeConfig;
  wikiInitialized: boolean;
  /** Non-null when file load failed (e.g. 404). */
  fileLoadError?: string | null;
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
  /** Callback when user selects text and clicks the float "就此提问" button. */
  onAskAboutSelection?: (selectedText: string) => void;
  /** Open the document outline panel. */
  onOpenOutline?: () => void;
  /** Open the unified KB chat panel in QA mode for the current file. */
  onAskAboutFile?: () => void;
  /** 编辑后的内容（用于阅读模式显示未保存的更改） */
  editedContent?: string | null;
  /** Force-load a too-large file past the safe cap (wired to useKnowledge.forceLoadFile). */
  onForceLoad?: () => void;
  /** Close the active tab (wired from useKbTabs by KnowledgeBasePage). */
  onCloseTab?: () => void;
}

export function KbMainContent({
  fileContent,
  selectedFile,
  vaultId,
  vaultPath,
  isTypesetMode,
  themeConfig,
  wikiInitialized,
  fileLoadError,
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
  onAskAboutSelection,
  onOpenOutline,
  onAskAboutFile,
  editedContent,
  onForceLoad,
  onCloseTab,
}: KbMainContentProps) {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const cmRef = useRef<KbCodeMirrorViewerHandle>(null);
  const [wrap, setWrap] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; source: 'doocs' | 'codemirror'; selectedText?: string } | null
  >(null);

  // Routing flags — computed from extension + size + tooLarge.
  const fileName = selectedFile ? (selectedFile.split('/').pop() ?? selectedFile) : '';
  const ext = fileName ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
  const isMarkdown = MD_EXTS.has(ext);
  const isLargeMd = isMarkdown && (fileContent?.size ?? 0) > MD_RENDER_THRESHOLD;
  const isSmallMd = isMarkdown && !isLargeMd;
  const category = fileName ? getFileCategory(fileName) : null;
  // CM path: text category, not too-large, and (large md OR non-markdown).
  const isCmPath = category === 'text' && !fileContent?.tooLarge && (isLargeMd || !isMarkdown);

  // Raw text used by the CM viewer — NO doocs preprocessing (those transforms
  // mutate HTML/rendered markdown, not raw source).
  const rawContent = useMemo(
    () => editedContent ?? fileContent?.content ?? '',
    [editedContent, fileContent?.content],
  );

  // Memoize the rendered markdown content so MdRenderer (wrapped in memo)
  // doesn't see a new string prop on unrelated re-renders. Preprocessing only
  // runs for the small-.md doocs path — never for the CM source view.
  const renderedContent = useMemo(
    () => isSmallMd
      ? proxyExternalImages(preprocessWikiEmbeds(stripTrackingPixels(editedContent ?? fileContent?.content ?? ''), vaultId ?? ''))
      : '',
    [editedContent, fileContent?.content, vaultId, isSmallMd],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, source: 'doocs' });
  }, []);

  const handleCmContextMenu = useCallback(
    (e: { x: number; y: number; selectedText: string; source: 'codemirror' }) => {
      setCtxMenu({ x: e.x, y: e.y, source: 'codemirror', selectedText: e.selectedText });
    },
    [],
  );

  const closeContextMenu = useCallback(() => setCtxMenu(null), []);

  const selectionText = useCallback(() => {
    const sel = window.getSelection();
    return sel ? sel.toString().trim() : '';
  }, []);

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

  // Compute file metadata null-safe so the header can render in empty states
  // (search / more-menu stay visible even when no file is open).
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
      {/* Header — always rendered so view actions (search / more-menu) stay
          visible even in empty states. File actions only render when a file is open. */}
      <div className="kb-main-header">
        {showFileName && selectedFile && (
          <div className="kb-header-filename-center">
            <span>
              {fileName}
              {hasUnsavedChanges && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>●</span>}
            </span>
          </div>
        )}
        <div className="kb-header-actions">
          {/* ── File edit / output actions (text files only, small-.md doocs path) ── */}
          {category === 'text' && selectedFile && !isCmPath && (
            <>
              {/* Save — only in editing modes (read mode has nothing to save) */}
              {onSave && (isEditMode || isTypesetMode) && (
                <button type="button" className="kb-btn kb-btn-ghost" onClick={onSave} title={t('kb.save')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                </button>
              )}

              {/* Copy and Publish (typeset mode only) */}
              {isTypesetMode && (
                <>
                  <button type="button" className="kb-btn kb-btn-ghost" onClick={onCopy} title={t('kb.copy')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  <button type="button" className="kb-btn kb-btn-ghost" onClick={onPublish} title={t('kb.publish')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  </button>
                </>
              )}

              {/* Typeset toggle — signature action. Read mode: T icon + "排版"
                  label (entry, prominent). Typeset mode: exit icon only (leave). */}
              <button
                type="button"
                className={`kb-btn ${isTypesetMode ? 'is-active' : ''}`}
                onClick={onToggleTypeset}
                title={isTypesetMode ? t('kb.exitTypeset') : t('kb.typeset')}
                data-testid="kb-btn-typeset"
              >
                {isTypesetMode ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="M4 7V4h16v3" />
                    <path d="M9 20h6" />
                    <path d="M12 4v16" />
                  </svg>
                )}
                {!isTypesetMode && <span>{t('kb.typeset')}</span>}
              </button>
            </>
          )}

          {/* ── CodeMirror viewer actions (text files on the CM path only) ── */}
          {category === 'text' && selectedFile && isCmPath && (
            <>
              <button
                type="button"
                className={`kb-btn kb-btn-ghost ${wrap ? 'is-active' : ''}`}
                onClick={() => setWrap((w) => !w)}
                title={t('kb.wrap')}
                data-testid="kb-btn-wrap"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <polyline points="16 4 21 4 21 9" />
                  <line x1="21" y1="4" x2="14" y2="11" />
                  <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => {
                  const n = Number(window.prompt(t('kb.gotoLine')));
                  if (n) cmRef.current?.gotoLine(n);
                }}
                title={t('kb.gotoLine')}
                data-testid="kb-btn-goto"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M4 7V4h16v3" />
                  <path d="M9 20h6" />
                  <path d="M12 4v16" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => cmRef.current?.scrollToBottom()}
                title={t('kb.scrollToBottom')}
                data-testid="kb-btn-bottom"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
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
              <span>{t('kb.openExternal')}</span>
            </button>
          )}

          {/* Divider: file actions │ view / command actions */}
          {selectedFile && category && (onOpenOutline || onAskAboutFile) && (
            <span className="kb-header-actions-divider" />
          )}

          {/* ── View / command actions ── */}
          {/* Document outline (file-scoped) */}
          {onOpenOutline && selectedFile && (
            <button
              type="button"
              className="kb-btn kb-btn-ghost"
              onClick={onOpenOutline}
              title={t('kb.moreMenuOutline')}
              data-testid="kb-btn-outline"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          )}

          {/* Edit / Read toggle — icon-only, grouped with search (doocs path only) */}
          {!isTypesetMode && !isCmPath && (
            <button
              type="button"
              className={`kb-btn kb-btn-ghost ${isEditMode ? 'is-active' : ''}`}
              onClick={onToggleEdit}
              title={isEditMode ? t('kb.readMode') : t('kb.editMode')}
              data-testid="kb-btn-edit"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                {isEditMode ? (
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                ) : (
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                )}
                {isEditMode && <circle cx="12" cy="12" r="3" />}
              </svg>
            </button>
          )}

          {/* 💬 Ask about this file — document-scoped, direct (one click) */}
          {onAskAboutFile && selectedFile && (
            <button
              type="button"
              className="kb-btn kb-btn-ghost"
              onClick={onAskAboutFile}
              title={t('kb.askButton')}
              data-testid="kb-btn-ask"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Body: empty states / error / content ── */}
      {!selectedFile ? (
        !vaultId ? (
          <div className="kb-empty-state">
            <div className="kb-empty-icon">📚</div>
            <h3>欢迎使用知识库</h3>
            <p>创建一个知识库来管理你的文档和笔记。</p>
            <p className="kb-empty-hint">知识库是存储和组织文档的地方，支持 Markdown 文件管理、AI 辅助阅读和 Wiki 生成。</p>
          </div>
        ) : !wikiInitialized ? (
          <div className="kb-empty-state">
            <div className="kb-empty-icon">🏗</div>
            <h3>构建知识库 Wiki</h3>
            <p>使用 AI 自动扫描 vault 中的文件，生成结构化的 wiki 页面。</p>
            <button type="button" className="wiki-cta-btn" onClick={onBuildWiki}>
              开始构建 Wiki
            </button>
          </div>
        ) : (
          <div className="kb-empty-state">
            <div className="kb-empty-icon">📄</div>
            <h3>未选择文件</h3>
            <p>从左侧文件树中选择一个文件查看内容。</p>
          </div>
        )
      ) : fileLoadError ? (
        <div className="kb-load-error">
          <div className="kb-load-error-icon">⚠</div>
          <p className="kb-load-error-title">{t('kb.cannotOpen')}</p>
          <p className="kb-load-error-path">{selectedFile}</p>
          <p className="kb-load-error-hint">{t('kb.fileNotFound')}</p>
        </div>
      ) : category === 'text' && fileContent?.tooLarge ? (
        <TooLargeCard
          fileName={fileName}
          size={fileContent.size}
          encoding={fileContent.encoding}
          canForce={fileContent.size <= 256 * 1024 * 1024}
          onForce={() => onForceLoad?.()}
          onOpenExternal={isElectron ? handleOpenExternal : undefined}
          onCloseTab={() => onCloseTab?.()}
        />
      ) : category === 'text' && isSmallMd && isTypesetMode ? (
        <MdTypesetEditor
          key={selectedFile}
          initialContent={fileContent?.content ?? ''}
          onContentChange={onContentChange}
          vaultId={vaultId ?? ''}
          selectedFile={selectedFile}
        />
      ) : category === 'text' && isSmallMd && isEditMode ? (
        // Edit mode: Milkdown WYSIWYG Markdown editor
        <MdEditor
          initialContent={fileContent?.content ?? ''}
          onContentChange={onContentChange}
          selectedFile={selectedFile}
        />
      ) : category === 'text' && isSmallMd ? (
        <div className="kb-content-area" ref={contentRef} onContextMenu={handleContextMenu}>
          {fileContent ? (
            // 优先使用编辑后的内容（未保存的更改），否则使用原始文件内容
            <MdRenderer content={renderedContent} themeConfig={themeConfig} />
          ) : (
            <div className="kb-empty-state"><p>Loading...</p></div>
          )}
        </div>
      ) : category === 'text' && isCmPath ? (
        <div className="kb-content-area kb-cm-area" ref={contentRef}>
          <ViewerErrorBoundary
            onRetry={() => onForceLoad?.()}
            onOpenExternal={isElectron ? handleOpenExternal : undefined}
          >
            {isLargeMd && (
              <div className="kb-source-mode-notice">
                {t('kb.largeFileSourceMode', { name: fileName, size: formatFileSize(fileContent?.size ?? 0) })}
              </div>
            )}
            {fileContent?.encoding && fileContent.encoding !== 'utf-8' && (
              <div className="kb-encoding-notice">
                {t('kb.encodingDetected', { encoding: fileContent.encoding })}
              </div>
            )}
            <Suspense fallback={<div className="kb-empty-state"><p>Loading...</p></div>}>
              <KbCodeMirrorViewer
                ref={cmRef}
                content={rawContent}
                fileName={fileName}
                encoding={fileContent?.encoding}
                wrap={wrap}
                onRequestContextMenu={handleCmContextMenu}
              />
            </Suspense>
          </ViewerErrorBoundary>
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

      {ctxMenu && (
        <ContextMenu
          items={(() => {
            // CM source: selection text captured at contextmenu-event time
            // (stored in ctxMenu.selectedText). doocs source: read live
            // window.getSelection() at menu-open.
            const isCmSource = ctxMenu.source === 'codemirror';
            const sel = isCmSource ? (ctxMenu.selectedText ?? '') : selectionText();
            // Rich triple-slot copy (text/html + text/plain markdown) only for
            // the doocs source — CM has raw text, no rendered HTML to convert.
            const selHtml = isCmSource ? '' : (() => {
              const s = window.getSelection();
              if (!s || s.rangeCount === 0) return '';
              const div = document.createElement('div');
              div.appendChild(s.getRangeAt(0).cloneContents());
              // doocs/md injects <style> blocks inside #output; strip them so
              // their CSS text doesn't leak into the copied markdown/html.
              div.querySelectorAll('style, script').forEach((el) => el.remove());
              return div.innerHTML;
            })();
            const selMd = (() => {
              if (!selHtml) return sel;
              try {
                const md = getTurndown().turndown(selHtml);
                return md || sel;
              } catch {
                return sel;
              }
            })();
            const items: MenuItem[] = [
              {
                label: t('kb.copy'),
                disabled: !sel,
                onClick: async () => {
                  if (!sel) return;
                  // doocs path: triple-slot copy (text/plain = Markdown +
                  // text/html = rich). CM path: plain text only.
                  if (!isCmSource && selHtml) {
                    try {
                      const item = new ClipboardItem({
                        'text/plain': new Blob([selMd], { type: 'text/plain' }),
                        'text/html': new Blob([selHtml], { type: 'text/html' }),
                      });
                      await navigator.clipboard.write([item]);
                      return;
                    } catch { /* ClipboardItem/write unavailable — fall back */ }
                  }
                  try {
                    await navigator.clipboard.writeText(sel);
                  } catch {
                    // 回退：用遗留命令复制
                    try {
                      const ta = document.createElement('textarea');
                      ta.value = sel;
                      document.body.appendChild(ta);
                      ta.select();
                      document.execCommand('copy');
                      ta.remove();
                    } catch { /* 静默 */ }
                  }
                },
              },
              {
                label: t('kb.ctxSelectAll'),
                onClick: () => {
                  if (isCmSource) {
                    cmRef.current?.selectAll();
                    return;
                  }
                  const out = contentRef.current?.querySelector('#output');
                  if (!out) return;
                  const range = document.createRange();
                  range.selectNodeContents(out);
                  const s = window.getSelection();
                  if (!s) return;
                  s.removeAllRanges();
                  s.addRange(range);
                },
              },
              { divider: true },
              {
                label: t('kb.askSelection'),
                disabled: !sel || sel.length > MAX_ASK_SELECTION,
                title: sel.length > MAX_ASK_SELECTION ? t('kb.selectionTooLarge') : undefined,
                onClick: () => {
                  if (sel && sel.length <= MAX_ASK_SELECTION) onAskAboutSelection?.(sel);
                },
              },
            ];
            return items;
          })()}
          position={ctxMenu}
          onClose={closeContextMenu}
        />
      )}

      {/* Status bar: word count / char count / read time (small-.md doocs path).
          CM path shows size/chars/encoding only — countWords would freeze on a
          15MB document. */}
      {category === 'text' && (
        <div className="kb-status-bar" data-testid="kb-status-bar">
          {(() => {
            const text = editedContent ?? fileContent?.content ?? '';
            if (isCmPath || text.length > 1_000_000) {
              return (
                <>
                  <span>{t('kb.statsChars')}: {text.length.toLocaleString()}</span>
                  <span className="kb-status-sep">/</span>
                  <span>{formatFileSize(text.length)}</span>
                  {fileContent?.encoding && fileContent.encoding !== 'utf-8' && (
                    <>
                      <span className="kb-status-sep">/</span>
                      <span>{fileContent.encoding}</span>
                    </>
                  )}
                </>
              );
            }
            const words = countWords(text);
            return (
              <>
                <span>{t('kb.statsWords')}: {words.toLocaleString()}</span>
                <span className="kb-status-sep">/</span>
                <span>{t('kb.statsChars')}: {text.length.toLocaleString()}</span>
                <span className="kb-status-sep">/</span>
                <span>{t('kb.statsReadTime')}: {formatReadTime(words, t('kb.statsReadTimeSuffix'))}</span>
              </>
            );
          })()}
        </div>
      )}
    </main>
  );
}
