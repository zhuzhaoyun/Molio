/**
 * MdTypesetEditor — Left-right split editor for Markdown content.
 *
 * Features:
 * - Left panel: Markdown source editor (textarea)
 * - Right panel: Live preview using MdRenderer
 * - Optional style panel overlay
 */

import { useState, useCallback, useEffect } from 'react';
import { MdRenderer } from './MdRenderer';
import { MdStylePanel, defaultThemeConfig, type ThemeConfig } from './MdStylePanel';

export interface MdTypesetEditorProps {
  /** Initial Markdown content */
  initialContent: string;
  /** Callback when content changes */
  onContentChange?: (content: string) => void;
  /** Whether style panel is visible */
  showStylePanel?: boolean;
  /** Close style panel callback */
  onCloseStylePanel?: () => void;
}

export function MdTypesetEditor({
  initialContent,
  onContentChange,
  showStylePanel = false,
  onCloseStylePanel,
}: MdTypesetEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [themeConfig, setThemeConfig] = useState<ThemeConfig>(defaultThemeConfig);

  // Sync initial content when it changes (e.g., file switch)
  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value;
      setContent(newContent);
      onContentChange?.(newContent);
    },
    [onContentChange]
  );

  const handleThemeChange = useCallback((newConfig: ThemeConfig) => {
    setThemeConfig(newConfig);
  }, []);

  return (
    <div className="kb-typeset-editor">
      {/* Left: Editor */}
      <div className="kb-typeset-left">
        <div className="kb-typeset-header">
          <span className="kb-editor-label">Markdown</span>
          <span className="kb-editor-hint">实时保存</span>
        </div>
        <textarea
          className="kb-typeset-textarea"
          value={content}
          onChange={handleContentChange}
          placeholder="在此输入 Markdown..."
          spellCheck={false}
        />
      </div>

      {/* Right: Preview + Style Panel */}
      <div className="kb-typeset-right">
        <div className="kb-typeset-header">
          <span className="kb-editor-label">Preview</span>
          <span className="kb-editor-hint">doocs/md 渲染</span>
        </div>
        <div className="kb-typeset-preview">
          <MdRenderer content={content} themeConfig={themeConfig} />
        </div>

        {/* Style Panel Overlay */}
        <MdStylePanel
          config={themeConfig}
          onChange={handleThemeChange}
          visible={showStylePanel}
          onClose={onCloseStylePanel ?? (() => {})}
        />
      </div>
    </div>
  );
}
