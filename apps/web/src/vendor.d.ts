/**
 * Type declarations for vendored doocs/md module.
 *
 * These declarations provide type safety for imports from the vendor directory
 * without requiring strict TypeScript checking on the vendored code itself.
 */

declare module '*/vendor/doocs-md/src/renderer/renderer-impl' {
  export interface IOpts {
    legend?: string;
    citeStatus?: boolean;
    countStatus?: boolean;
    isMacCodeBlock?: boolean;
    isShowLineNumber?: boolean;
    themeMode?: 'light' | 'dark';
    components?: unknown;
  }

  export interface RendererAPI {
    reset: (newOpts: Partial<IOpts>) => void;
    setOptions: (newOpts: Partial<IOpts>) => void;
    getOpts: () => IOpts;
    parseFrontMatterAndContent: (markdown: string) => {
      yamlData: Record<string, unknown>;
      markdownContent: string;
      readingTime: { words: number; minutes: number };
    };
    renderMarkdownToHtml: (markdown: string) => string;
    buildReadingTime: (reading: { words: number; minutes: number }) => string;
    buildFootnotes: () => string;
    buildAddition: () => string;
    createContainer: (html: string) => string;
  }

  export function initRenderer(opts?: IOpts): RendererAPI;
  export const hljs: unknown;
  /** [MOLIO] Leading YAML frontmatter block delimiter — single source of truth
   *  shared by the renderer's parse-failure fallback and preprocessKbMarkdown. */
  export const FRONTMATTER_BLOCK_RE: RegExp;
}

declare module '*/vendor/doocs-md/src/utils/markdownHelpers' {
  import type { RendererAPI } from '*/vendor/doocs-md/src/renderer/renderer-impl';

  export function renderMarkdown(
    raw: string,
    renderer: RendererAPI
  ): {
    html: string;
    readingTime: { words: number; minutes: number };
  };

  export function postProcessHtml(
    baseHtml: string,
    reading: { words: number; minutes: number },
    renderer: RendererAPI
  ): string;

  export function modifyHtmlContent(
    content: string,
    renderer: RendererAPI
  ): string;
}

declare module '*/vendor/doocs-md/shared/types/common' {
  export interface IOpts {
    legend?: string;
    citeStatus?: boolean;
    countStatus?: boolean;
    isMacCodeBlock?: boolean;
    isShowLineNumber?: boolean;
    themeMode?: 'light' | 'dark';
    components?: unknown;
  }

  export interface IConfigOption<VT = string> {
    label: string;
    value: VT;
    desc: string;
  }
}
