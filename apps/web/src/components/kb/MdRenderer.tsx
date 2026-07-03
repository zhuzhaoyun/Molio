/**
 * MdRenderer — React wrapper for doocs/md rendering engine.
 *
 * Renders Markdown content using the full doocs/md pipeline:
 * - marked v18 with custom extensions (KaTeX, Mermaid, alerts, etc.)
 * - highlight.js code highlighting
 * - DOMPurify XSS sanitization
 * - Full theme system (CSS variables + theme CSS injection)
 *
 * Note: All styles are managed by doocs/md theme system (applyTheme).
 * Do NOT add custom CSS here — use the theme system instead.
 */

import { useEffect, useRef, useMemo, useState, memo } from 'react';
import { initRenderer } from '@molio/doocs-md/src/renderer/renderer-impl';
import { renderMarkdown, postProcessHtml } from '@molio/doocs-md/src/utils/markdownHelpers';
import { applyTheme } from '@molio/doocs-md/src/theme/themeApplicator';
import type { IOpts } from '@molio/doocs-md/shared/types/common';
import type { ThemeConfig } from './MdStylePanel';

export interface MdRendererProps {
  /** Markdown content to render */
  content: string;
  /** Theme configuration */
  themeConfig?: ThemeConfig;
  /** Renderer options */
  options?: Partial<IOpts>;
  /** Additional CSS class */
  className?: string;
}

// Default renderer options
const defaultOptions: IOpts = {
  legend: 'alt-title',
  citeStatus: false,
  countStatus: false,
  isMacCodeBlock: true,
  isShowLineNumber: false,
  themeMode: 'light',
};

/**
 * Build renderer options from themeConfig.
 * Maps theme-level booleans and config values into IOpts fields.
 */
function buildRendererOptions(base: Partial<IOpts>, themeConfig?: ThemeConfig): IOpts {
  return {
    ...defaultOptions,
    ...base,
    legend: themeConfig?.legend ?? base.legend ?? defaultOptions.legend,
    citeStatus: themeConfig?.citeStatus ?? base.citeStatus ?? defaultOptions.citeStatus,
    countStatus: themeConfig?.countStatus ?? base.countStatus ?? defaultOptions.countStatus,
    isMacCodeBlock: themeConfig?.isMacCodeBlock ?? base.isMacCodeBlock ?? defaultOptions.isMacCodeBlock,
    isShowLineNumber: themeConfig?.isShowLineNumber ?? base.isShowLineNumber ?? defaultOptions.isShowLineNumber,
  };
}

export const MdRenderer = memo(function MdRenderer({
  content,
  themeConfig,
  options = defaultOptions,
  className,
}: MdRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderedHtml, setRenderedHtml] = useState('');

  // Build final renderer options (merging base + themeConfig overrides)
  const finalOptions = useMemo(() => buildRendererOptions(options, themeConfig), [options, themeConfig]);

  // Initialize renderer (memoized)
  const renderer = useMemo(() => initRenderer(finalOptions), [
    finalOptions.legend,
    finalOptions.citeStatus,
    finalOptions.countStatus,
    finalOptions.isMacCodeBlock,
    finalOptions.isShowLineNumber,
    finalOptions.themeMode,
  ]);

  // Render markdown content
  useEffect(() => {
    if (!content) {
      setRenderedHtml('');
      return;
    }

    try {
      const { html, readingTime } = renderMarkdown(content, renderer);
      const finalHtml = postProcessHtml(html, readingTime, renderer);
      setRenderedHtml(finalHtml);
    } catch (error) {
      console.error('Markdown rendering error:', error);
      setRenderedHtml(`<p>Error rendering content: ${String(error)}</p>`);
    }
  }, [content, renderer]);

  // Apply theme CSS when themeConfig changes
  // The doocs/md theme system handles all styles — do NOT inject styles manually
  useEffect(() => {
    if (!themeConfig) return;

    applyTheme({
      themeName: themeConfig.themeName,
      variables: {
        primaryColor: themeConfig.primaryColor,
        fontFamily: themeConfig.fontFamily,
        fontSize: themeConfig.fontSize,
        isUseIndent: themeConfig.isUseIndent,
        isUseJustify: themeConfig.isUseJustify,
        headingStyles: themeConfig.headingStyles,
      },
      customCSS: themeConfig.customCSS,
    }).catch((err) => {
      console.error('Failed to apply theme:', err);
    });
  }, [themeConfig]);

  return (
    <div
      ref={containerRef}
      id="output"
      className={`md-preview ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
});
