/**
 * MdTypesetEditor — WYSIWYG Markdown editor with style panel for publishing.
 *
 * 2-column layout:
 * - Left: Milkdown WYSIWYG editor
 * - Right: MdStylePanel (controls doocs/md publish theme)
 *
 * A hidden offscreen MdRenderer keeps #output available for publish/copy flows.
 */
import { useState, useCallback, useEffect } from 'react';
import { MdMilkdownEditor } from './MdMilkdownEditor';
import { MdRenderer } from './MdRenderer';
import { MdStylePanel, defaultThemeConfig, type ThemeConfig } from './MdStylePanel';
import { preprocessWikiEmbeds, proxyExternalImages } from '../../hooks/useKnowledge';

export interface MdTypesetEditorProps {
  initialContent: string;
  onContentChange?: (content: string) => void;
  vaultId?: string;
}

export function MdTypesetEditor({
  initialContent,
  onContentChange,
  vaultId,
}: MdTypesetEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [themeConfig, setThemeConfig] = useState<ThemeConfig>(defaultThemeConfig);

  useEffect(() => {
    setContent(initialContent);
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

  // Preprocessed content for the hidden publish preview
  const publishContent = vaultId
    ? proxyExternalImages(preprocessWikiEmbeds(content, vaultId))
    : proxyExternalImages(content);

  return (
    <div className="kb-typeset-editor">
      {/* Left: Milkdown WYSIWYG editor */}
      <div className="kb-typeset-left">
        <div className="kb-typeset-cm">
          <MdMilkdownEditor
            initialContent={initialContent}
            onContentChange={handleContentChange}
            vaultId={vaultId}
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
