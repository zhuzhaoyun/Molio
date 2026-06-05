/**
 * MdRenderer — React wrapper for doocs/md rendering engine.
 *
 * Renders Markdown content using the full doocs/md pipeline:
 * - marked v18 with custom extensions (KaTeX, Mermaid, alerts, etc.)
 * - highlight.js code highlighting
 * - DOMPurify XSS sanitization
 * - Full theme system (CSS variables + theme CSS injection)
 */

import { useEffect, useRef, useMemo, useState } from 'react';
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
 * Maps theme-level booleans (isMacCodeBlock, isShowLineNumber) into IOpts fields.
 */
function buildRendererOptions(base: Partial<IOpts>, themeConfig?: ThemeConfig): IOpts {
  return {
    ...defaultOptions,
    ...base,
    // Override with theme config if available
    isMacCodeBlock: themeConfig?.isMacCodeBlock ?? base.isMacCodeBlock ?? defaultOptions.isMacCodeBlock,
    isShowLineNumber: themeConfig?.isShowLineNumber ?? base.isShowLineNumber ?? defaultOptions.isShowLineNumber,
  };
}

export function MdRenderer({
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
  useEffect(() => {
    if (!themeConfig) return;

    // Build heading styles from theme config (can be extended later)
    const headingStyles = themeConfig.themeName === 'grace'
      ? { h1: 'default' as const, h2: 'default' as const, h3: 'default' as const, h4: 'default' as const, h5: 'default' as const, h6: 'default' as const }
      : themeConfig.themeName === 'simple'
        ? { h1: 'default' as const, h2: 'default' as const, h3: 'default' as const, h4: 'default' as const, h5: 'default' as const, h6: 'default' as const }
        : { h1: 'default' as const, h2: 'default' as const, h3: 'default' as const, h4: 'default' as const, h5: 'default' as const, h6: 'default' as const };

    applyTheme({
      themeName: themeConfig.themeName,
      variables: {
        primaryColor: themeConfig.primaryColor,
        fontFamily: themeConfig.fontFamily,
        fontSize: themeConfig.fontSize,
        isUseIndent: themeConfig.isUseIndent,
        isUseJustify: themeConfig.isUseJustify,
        headingStyles,
      },
      customCSS: themeConfig.customCSS,
    }).catch((err) => {
      console.error('Failed to apply theme:', err);
    });

    // Cleanup: remove theme style on unmount
    return () => {
      // ThemeInjector keeps a singleton; we don't remove on every config change
      // because applyTheme reuses the same <style> tag. Only clean up if needed.
    };
  }, [themeConfig]);

  return (
    <div
      ref={containerRef}
      id="output"
      className={`md-preview ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
