/**
 * MdTypesetEditor — 3-column typeset mode (doocs/md pattern).
 *
 * Layout:
 * - Left:   Milkdown WYSIWYG source editor (editable, no theme styling)
 * - Middle: doocs/md themed preview (read-only, full theme rendering)
 * - Right:  MdStylePanel (controls doocs/md publish theme)
 *
 * Content flows: source edit → content state → middle preview re-renders.
 * Theme flows:   style panel → themeConfig → middle preview re-renders.
 * Copy/publish reads #output from the visible middle preview.
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

const PROXIED_HOSTS_DOM = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'mpvideo.qpic.cn'];

/** Rewrite proxied host src to daemon proxy — DOM manipulation only, doesn't touch ProseMirror doc */
function proxyMediaInDOM(container: HTMLElement) {
  container.querySelectorAll('img, video, source').forEach((el) => {
    const rawSrc = el.getAttribute('src');
    if (!rawSrc) return;
    try {
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
  const editorContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  // After Milkdown renders, proxy mmbiz images in the DOM
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) return;
    const timer = setTimeout(() => proxyMediaInDOM(container), 500);
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

  // Content for Milkdown source editor
  const sourceContent = vaultId
    ? proxyExternalImages(preprocessWikiEmbeds(stripTrackingPixels(initialContent), vaultId))
    : proxyExternalImages(stripTrackingPixels(initialContent));

  // Content for doocs/md themed preview (live-updating as user edits)
  const previewContent = vaultId
    ? proxyExternalImages(preprocessWikiEmbeds(stripTrackingPixels(content), vaultId))
    : proxyExternalImages(stripTrackingPixels(content));

  return (
    <div className="kb-typeset-editor">
      {/* Left: Milkdown source editor */}
      <div className="kb-typeset-source">
        <div className="kb-typeset-source-header">Markdown 源</div>
        <div className="kb-typeset-cm" ref={editorContainerRef}>
          <MdMilkdownEditor
            initialContent={sourceContent}
            onContentChange={handleContentChange}
            vaultId={vaultId}
            fileKey={selectedFile}
          />
        </div>
      </div>

      {/* Middle: doocs/md themed preview */}
      <div className="kb-typeset-preview">
        <div className="kb-typeset-preview-header">排版预览</div>
        <div className="kb-typeset-preview-body">
          <MdRenderer content={previewContent} themeConfig={themeConfig} />
        </div>
      </div>

      {/* Right: Style Panel */}
      <MdStylePanel config={themeConfig} onChange={handleThemeChange} />
    </div>
  );
}
