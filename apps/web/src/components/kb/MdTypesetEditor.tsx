/**
 * MdTypesetEditor — Typeset mode with themed preview and WYSIWYG editing.
 *
 * 2-column layout:
 * - Left: Tab switcher (Edit → Milkdown WYSIWYG, Preview → doocs/md themed output)
 * - Right: MdStylePanel (controls doocs/md publish theme)
 *
 * The doocs/md preview is always rendered (visible or hidden) to keep
 * #output available for publish/copy flows.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { MdMilkdownEditor } from './MdMilkdownEditor';
import { MdRenderer } from './MdRenderer';
import { MdStylePanel, defaultThemeConfig, type ThemeConfig } from './MdStylePanel';
import { preprocessWikiEmbeds, proxyExternalImages, stripTrackingPixels } from '../../hooks/useKnowledge';

export interface MdTypesetEditorProps {
  initialContent: string;
  onContentChange?: (content: string) => void;
  vaultId?: string;
  selectedFile?: string | null;
}

type TypesetTab = 'edit' | 'preview';

const PROXIED_HOSTS_DOM = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'mpvideo.qpic.cn'];

/** Rewrite proxied host src to daemon proxy — DOM manipulation, doesn't touch ProseMirror doc */
function proxyMediaInDOM(container: HTMLElement) {
  container.querySelectorAll('img, video, source').forEach((el) => {
    const rawSrc = el.getAttribute('src');
    if (!rawSrc) return;
    try {
      // Decode HTML entities (&amp; → &) before URL parsing
      const src = rawSrc.replace(/&amp;/g, '&');
      const host = new URL(src).hostname;
      if (PROXIED_HOSTS_DOM.some(h => host === h || host.endsWith('.' + h))) {
        el.setAttribute('src', `${window.location.origin}/api/proxy/image?url=${encodeURIComponent(src)}`);
      }
    } catch { /* invalid URL, skip */ }
  });
}

export function MdTypesetEditor({
  initialContent,
  onContentChange,
  vaultId,
  selectedFile,
}: MdTypesetEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [themeConfig, setThemeConfig] = useState<ThemeConfig>(defaultThemeConfig);
  const [activeTab, setActiveTab] = useState<TypesetTab>('preview');
  const editorContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  // After Milkdown renders, proxy mmbiz images in the DOM
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) return;
    // Small delay for Milkdown to finish rendering
    const timer = setTimeout(() => proxyMediaInDOM(container), 500);
    // Also observe for mutations (e.g., new images added during editing)
    const observer = new MutationObserver(() => proxyMediaInDOM(container));
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [initialContent]);

  const handleContentChange = useCallback(
    (newContent: string) => {
      setContent(newContent);
      onContentChange?.(newContent);
    },
    [onContentChange],
  );

  const handleThemeChange = useCallback((newConfig: ThemeConfig) => {
    setThemeConfig(newConfig);
  }, []);

  // Content for Milkdown visible editor — same preprocessing as Read mode
  const milkdownContent = vaultId
    ? proxyExternalImages(preprocessWikiEmbeds(stripTrackingPixels(initialContent), vaultId))
    : proxyExternalImages(stripTrackingPixels(initialContent));

  // Content for preview (uses live-updating `content` state so edits are reflected)
  const previewContent = vaultId
    ? proxyExternalImages(preprocessWikiEmbeds(stripTrackingPixels(content), vaultId))
    : proxyExternalImages(stripTrackingPixels(content));

  const isPreview = activeTab === 'preview';
  const isEdit = activeTab === 'edit';

  return (
    <div className="kb-typeset-editor">
      {/* Left: Tab switcher + content area */}
      <div className="kb-typeset-left">
        {/* Tab bar */}
        <div className="kb-typeset-tabs">
          <button
            type="button"
            className={`kb-typeset-tab ${isEdit ? 'is-active' : ''}`}
            onClick={() => setActiveTab('edit')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
            <span>编辑</span>
          </button>
          <button
            type="button"
            className={`kb-typeset-tab ${isPreview ? 'is-active' : ''}`}
            onClick={() => setActiveTab('preview')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span>预览</span>
          </button>
        </div>

        {/* Milkdown editor (hidden when preview tab active) */}
        <div
          className="kb-typeset-cm"
          ref={editorContainerRef}
          style={{ display: isEdit ? 'flex' : 'none' }}
        >
          <MdMilkdownEditor
            initialContent={milkdownContent}
            onContentChange={handleContentChange}
            vaultId={vaultId}
            fileKey={selectedFile}
          />
        </div>

        {/* doocs/md themed preview (hidden when edit tab active) */}
        <div
          className="kb-typeset-preview"
          style={{ display: isPreview ? 'flex' : 'none' }}
        >
          <MdRenderer content={previewContent} themeConfig={themeConfig} />
        </div>
      </div>

      {/* Right: Style Panel */}
      <MdStylePanel config={themeConfig} onChange={handleThemeChange} />
    </div>
  );
}
