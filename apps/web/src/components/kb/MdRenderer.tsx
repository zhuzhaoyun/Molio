/**
 * MdRenderer — React wrapper for doocs/md rendering engine.
 *
 * Renders Markdown content using the full doocs/md pipeline:
 * - marked v18 with custom extensions (KaTeX, Mermaid, alerts, etc.)
 * - highlight.js code highlighting
 * - DOMPurify XSS sanitization
 */

import { useEffect, useRef, useMemo, useState } from 'react';
import { initRenderer } from '@molio/doocs-md/src/renderer/renderer-impl';
import { renderMarkdown, postProcessHtml } from '@molio/doocs-md/src/utils/markdownHelpers';
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

export function MdRenderer({
  content,
  themeConfig,
  options = defaultOptions,
  className,
}: MdRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderedHtml, setRenderedHtml] = useState('');

  // Initialize renderer (memoized)
  const renderer = useMemo(() => initRenderer(options), [
    options.legend,
    options.citeStatus,
    options.countStatus,
    options.isMacCodeBlock,
    options.isShowLineNumber,
    options.themeMode,
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

  // Apply theme CSS
  useEffect(() => {
    if (!containerRef.current || !themeConfig) return;

    // Apply CSS variables from theme config
    const root = containerRef.current;
    root.style.setProperty('--md-primary-color', themeConfig.primaryColor);
    root.style.setProperty('--md-font-family', themeConfig.fontFamily);
    root.style.setProperty('--md-font-size', themeConfig.fontSize);
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
