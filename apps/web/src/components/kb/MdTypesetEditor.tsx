/**
 * MdTypesetEditor — WYSIWYG Markdown editor with style panel for publishing.
 *
 * 2-column layout:
 * - Left: Milkdown WYSIWYG editor (responds to theme changes via dynamic CSS)
 * - Right: MdStylePanel (controls doocs/md publish theme)
 *
 * A hidden offscreen MdRenderer keeps #output available for publish/copy flows.
 * Theme changes are bridged to Milkdown via a live <style> element so the
 * WYSIWYG editor reflects font, color, width, indent, and justify settings
 * in real time — no edit/preview toggle needed.
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
const MILKDOWN_THEME_STYLE_ID = 'milkdown-theme-override';

/** Build CSS overrides so Milkdown reflects doocs/md theme configuration */
function buildMilkdownThemeCSS(config: ThemeConfig): string {
  const isMobile = config.previewWidth === 'mobile';
  const primary = config.primaryColor;
  // fontSize from doocs/md already includes 'px' suffix (e.g. '16px')
  const fontSize = config.fontSize.endsWith('px') ? config.fontSize : `${config.fontSize}px`;
  const fontFamily = config.fontFamily.includes("'") ? config.fontFamily : `'${config.fontFamily}'`;

  return [
    // Layout
    `.milkdown .editor {`,
    `  font-family: ${fontFamily};`,
    `  font-size: ${fontSize};`,
    isMobile
      ? [
          '  max-width: 375px;',
          '  margin: 24px auto;',
          '  background: var(--bg-panel);',
          '  box-shadow: 0 0 0 1px var(--border), 0 4px 16px rgba(0,0,0,0.07);',
          '  border-radius: 4px;',
          '  padding: 32px 24px 48px;',
        ].join('\n')
      : '  max-width: 100%;',
    config.isUseJustify ? '  text-align: justify;' : '',
    `}`,
    config.isUseIndent ? `.milkdown .editor > p { text-indent: 2em; }` : '',
    // Primary color
    `.milkdown { --crepe-color-primary: ${primary}; }`,
    `.milkdown .editor a { color: ${primary}; }`,
    `.milkdown .editor blockquote { border-left-color: ${primary}; }`,
    `.milkdown .editor th { border-bottom-color: ${primary}; }`,
    `.milkdown .editor code { color: ${primary}; }`,
    `.milkdown .editor li[data-item-type="task"] input[type="checkbox"] { accent-color: ${primary}; }`,
    `.milkdown .editor .ProseMirror-focused .ProseMirror-selectednode { outline-color: ${primary}; }`,
  ].filter(Boolean).join('\n');
}

/** Rewrite proxied host src to daemon proxy — DOM manipulation, doesn't touch ProseMirror doc */
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

  // Bridge doocs/md theme config → Milkdown live CSS overrides
  useEffect(() => {
    let styleEl = document.getElementById(MILKDOWN_THEME_STYLE_ID) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = MILKDOWN_THEME_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = buildMilkdownThemeCSS(themeConfig);
    return () => {
      styleEl?.remove();
    };
  }, [themeConfig]);

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

  // Content for Milkdown editor — same preprocessing as Read mode
  const milkdownContent = vaultId
    ? proxyExternalImages(preprocessWikiEmbeds(stripTrackingPixels(initialContent), vaultId))
    : proxyExternalImages(stripTrackingPixels(initialContent));

  // Content for publish preview (uses live-updating `content` state)
  const publishContent = vaultId
    ? proxyExternalImages(preprocessWikiEmbeds(stripTrackingPixels(content), vaultId))
    : proxyExternalImages(stripTrackingPixels(content));

  return (
    <div className="kb-typeset-editor">
      {/* Left: Milkdown WYSIWYG editor */}
      <div className="kb-typeset-left">
        <div className="kb-typeset-cm" ref={editorContainerRef}>
          <MdMilkdownEditor
            initialContent={milkdownContent}
            onContentChange={handleContentChange}
            vaultId={vaultId}
            fileKey={selectedFile}
          />
        </div>
      </div>

      {/* Right: Style Panel */}
      <MdStylePanel config={themeConfig} onChange={handleThemeChange} />

      {/* Hidden: doocs/md renderer for publish/copy compatibility */}
      <div className="kb-typeset-preview-hidden" aria-hidden="true">
        <MdRenderer content={publishContent} themeConfig={themeConfig} />
      </div>
    </div>
  );
}
