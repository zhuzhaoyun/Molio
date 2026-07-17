/**
 * MdTypesetEditor — 3-column typeset mode (doocs/md pattern).
 *
 * Layout:
 * - Left:   Raw markdown source (plain textarea, editable)
 * - Middle: doocs/md themed preview (read-only, full theme rendering)
 * - Right:  MdStylePanel (controls doocs/md publish theme)
 *
 * Content flows: source edit → content state → middle preview re-renders.
 * Theme flows:   style panel → themeConfig → middle preview re-renders.
 * Copy/publish reads #output from the visible middle preview.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { MdRenderer } from './MdRenderer';
import { MdStylePanel, defaultThemeConfig, type ThemeConfig } from './MdStylePanel';
import { preprocessWikiLinks, preprocessWikiEmbeds, proxyExternalImages, stripTrackingPixels } from '../../hooks/useKnowledge';

export interface MdTypesetEditorProps {
  initialContent: string;
  onContentChange?: (content: string) => void;
  vaultId?: string;
  selectedFile?: string | null;
}

export function MdTypesetEditor({
  initialContent,
  onContentChange,
  vaultId,
}: MdTypesetEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [themeConfig, setThemeConfig] = useState<ThemeConfig>(defaultThemeConfig);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewBodyRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  // ── Synchronized scrolling between source textarea and preview ──
  useEffect(() => {
    const textarea = textareaRef.current;
    const preview = previewBodyRef.current;
    if (!textarea || !preview) return;

    const syncScroll = (source: HTMLElement, target: HTMLElement) => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      const ratio = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
      target.scrollTop = ratio * Math.max(1, target.scrollHeight - target.clientHeight);
      requestAnimationFrame(() => { syncingRef.current = false; });
    };

    const onTextareaScroll = () => syncScroll(textarea, preview);
    const onPreviewScroll = () => syncScroll(preview, textarea);

    textarea.addEventListener('scroll', onTextareaScroll, { passive: true });
    preview.addEventListener('scroll', onPreviewScroll, { passive: true });
    return () => {
      textarea.removeEventListener('scroll', onTextareaScroll);
      preview.removeEventListener('scroll', onPreviewScroll);
    };
  }, []);

  const handleSourceChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value;
      setContent(newContent);
      onContentChange?.(newContent);
    },
    [onContentChange],
  );

  // Tab key inserts spaces in textarea instead of moving focus
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = textarea.value.slice(0, start) + '  ' + textarea.value.slice(end);
      textarea.value = newValue;
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      // Fire synthetic change
      setContent(newValue);
      onContentChange?.(newValue);
    }
  }, [onContentChange]);

  const handleThemeChange = useCallback((newConfig: ThemeConfig) => {
    setThemeConfig(newConfig);
  }, []);

  // Content for doocs/md themed preview (live-updating as user edits source).
  // Memoized to avoid re-running full-string regex scans on every keystroke.
  const previewContent = useMemo(() => {
    const stripped = stripTrackingPixels(content);
    const withEmbeds = vaultId
      ? proxyExternalImages(preprocessWikiEmbeds(stripped, vaultId))
      : proxyExternalImages(stripped);
    return preprocessWikiLinks(withEmbeds, vaultId);
  }, [content, vaultId]);

  return (
    <div className="kb-typeset-editor">
      {/* Left: Raw markdown source */}
      <div className="kb-typeset-source">
        <div className="kb-typeset-source-header">Markdown</div>
        <textarea
          ref={textareaRef}
          className="kb-typeset-textarea"
          value={content}
          onChange={handleSourceChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
      </div>

      {/* Middle: doocs/md themed preview */}
      <div className="kb-typeset-preview">
        <div className="kb-typeset-preview-header">排版预览</div>
        <div
          ref={previewBodyRef}
          className={`kb-typeset-preview-body${themeConfig.previewWidth === 'mobile' ? ' kb-preview--mobile' : ''}`}
        >
          <MdRenderer content={previewContent} themeConfig={themeConfig} />
        </div>
      </div>

      {/* Right: Style Panel */}
      <MdStylePanel config={themeConfig} onChange={handleThemeChange} />
    </div>
  );
}
