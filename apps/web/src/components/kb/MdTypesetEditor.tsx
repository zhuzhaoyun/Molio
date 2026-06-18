/**
 * MdTypesetEditor — WYSIWYG Markdown editor with style panel for publishing.
 *
 * 2-column layout:
 * - Left: Milkdown WYSIWYG editor
 * - Right: MdStylePanel (controls doocs/md publish theme)
 *
 * A hidden offscreen MdRenderer keeps #output available for publish/copy flows.
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
}

/** Rewrite mmbiz img src to daemon proxy — DOM manipulation, doesn't touch ProseMirror doc */
function proxyImagesInDOM(container: HTMLElement) {
  const imgs = container.querySelectorAll('img');
  imgs.forEach((img) => {
    try {
      const host = new URL(img.src).hostname;
      if (host === 'mmbiz.qpic.cn' || host.endsWith('.mmbiz.qpic.cn')) {
        img.src = `${window.location.origin}/api/proxy/image?url=${encodeURIComponent(img.src)}`;
      }
    } catch { /* invalid URL, skip */ }
  });
}

export function MdTypesetEditor({
  initialContent,
  onContentChange,
  vaultId,
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
    // Small delay for Milkdown to finish rendering
    const timer = setTimeout(() => proxyImagesInDOM(container), 500);
    // Also observe for mutations (e.g., new images added during editing)
    const observer = new MutationObserver(() => proxyImagesInDOM(container));
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

  // Preprocessed content for hidden publish preview + Milkdown display
  const displayContent = stripTrackingPixels(
    vaultId
      ? proxyExternalImages(preprocessWikiEmbeds(content, vaultId))
      : proxyExternalImages(content),
  );

  return (
    <div className="kb-typeset-editor">
      {/* Left: Milkdown WYSIWYG editor */}
      <div className="kb-typeset-left">
        <div className="kb-typeset-cm" ref={editorContainerRef}>
          <MdMilkdownEditor
            initialContent={stripTrackingPixels(initialContent)}
            onContentChange={handleContentChange}
            vaultId={vaultId}
          />
        </div>
      </div>

      {/* Right: Style Panel */}
      <MdStylePanel config={themeConfig} onChange={handleThemeChange} />

      {/* Hidden: doocs/md renderer for publish/copy compatibility */}
      <div className="kb-typeset-preview-hidden" aria-hidden="true">
        <MdRenderer content={displayContent} themeConfig={themeConfig} />
      </div>
    </div>
  );
}
