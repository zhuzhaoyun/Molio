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
import { mathJaxReady, ensureMathJax } from '../../utils/mathjaxLoader';
import type { IOpts } from '@molio/doocs-md/shared/types/common';
import type { ThemeConfig } from './MdStylePanel';

/**
 * Append CSS to the #md-theme <style> element so publish/copy flows
 * which read from #md-theme automatically include the appended styles.
 */
function appendToThemeStyle(css: string): void {
  const el = document.getElementById('md-theme');
  if (el) {
    el.textContent += '\n' + css;
  }
}

export interface MdRendererProps {
  /** Markdown content to render */
  content: string;
  /** Theme configuration */
  themeConfig?: ThemeConfig;
  /** Renderer options */
  options?: Partial<IOpts>;
  /** Additional CSS class */
  className?: string;
  /**
   * Content is UNTRUSTED (e.g. a remote hub SKILL.md readme): render under
   * the strict sanitization profile — no `onerror` allowlist, no
   * mermaid/infographic protect-and-restore. Leave unset for
   * locally-authored content (KB docs), which relies on those affordances.
   */
  untrusted?: boolean;
  /**
   * 渲染结果**已写入 DOM** 后回调，回传产出这份 HTML 的 `content`。
   *
   * 渲染是异步的（下方 effect 里 setState），所以「入参换了」并不等于「DOM
   * 里已经是新的」。需要等真正上屏才能做事的调用方（如阅读视窗的滚动位置
   * 恢复——落位会被上一篇的 scrollHeight 截断）靠这个信号判断。
   * 用内容串而非布尔：调用方拿它跟当前 content 比相等即可，换文档自动失效。
   */
  onRendered?: (content: string) => void;
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
  untrusted = false,
  onRendered,
}: MdRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // html + 产出它的 content 一起存：一起 setState 保证「DOM 里的 html」与
  // 「它是哪一篇」永远同步，onRendered 才敢照实回传。
  const [rendered, setRendered] = useState<{ html: string; source: string }>({
    html: '',
    source: '',
  });
  const renderedHtml = rendered.html;
  // Store the latest loaded code theme CSS so it can be re-appended
  // after applyTheme overwrites #md-theme.
  const codeThemeCssRef = useRef<string>('');

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

  // Render markdown content. Formulas are typeset by the doocs/md KaTeX
  // extension through the global window.MathJax, which Molio loads lazily as a
  // local asset. If MathJax isn't ready yet, render immediately with the
  // extension's raw-LaTeX fallback (so content never waits), then re-render
  // once MathJax is ready so formulas upgrade to real SVG. If the asset fails
  // to load, the fallback render stays — no crash, no blank page.
  useEffect(() => {
    if (!content) {
      setRendered({ html: '', source: '' });
      return;
    }

    let cancelled = false;

    const doRender = () => {
      try {
        const { html, readingTime } = renderMarkdown(
          content,
          renderer,
          untrusted ? { untrusted: true } : undefined,
        );
        const finalHtml = postProcessHtml(html, readingTime, renderer);
        if (!cancelled) setRendered({ html: finalHtml, source: content });
      } catch (error) {
        console.error('Markdown rendering error:', error);
        if (!cancelled) setRendered({ html: `<p>Error rendering content: ${String(error)}</p>`, source: content });
      }
    };

    doRender();
    if (!mathJaxReady()) {
      ensureMathJax()
        .then(doRender)
        .catch((err) => {
          console.error('MathJax unavailable; formulas render as raw LaTeX:', err);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [content, renderer, untrusted]);

  // 上屏通知：这个 effect 属于「rendered 已提交」的那次 commit，此刻 DOM 里
  // 就是 rendered.source 那一篇（MathJax 就绪后的二次渲染 source 不变，不重复通知）。
  useEffect(() => {
    onRendered?.(rendered.source);
  }, [rendered.source, onRendered]);

  // Apply theme CSS when themeConfig changes.
  // The doocs/md theme system handles all styles — do NOT inject styles manually.
  // Re-append stored code theme CSS after applyTheme overwrites #md-theme.
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
    }).then(() => {
      // applyTheme overwrites #md-theme — restore the code theme CSS
      if (codeThemeCssRef.current) {
        appendToThemeStyle(codeThemeCssRef.current);
      }
    }).catch((err) => {
      console.error('Failed to apply theme:', err);
    });
  }, [themeConfig]);

  // Load highlight.js code theme CSS when codeBlockTheme changes.
  // Appends to #md-theme so the publish/copy flows (which read #md-theme)
  // automatically include syntax-highlighting styles.
  useEffect(() => {
    const codeThemeUrl = themeConfig?.codeBlockTheme;
    if (!codeThemeUrl) return;

    let aborted = false;

    fetch(codeThemeUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((css) => {
        if (aborted) return;
        codeThemeCssRef.current = css;
        appendToThemeStyle(css);
      })
      .catch((err) => {
        if (!aborted) console.error('Failed to load code theme CSS:', err);
      });

    return () => {
      aborted = true;
    };
  }, [themeConfig?.codeBlockTheme]);

  return (
    <div
      ref={containerRef}
      id="output"
      className={`md-preview ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
});
