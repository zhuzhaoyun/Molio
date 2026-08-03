/**
 * pdfjs-dist 惰性加载器。留在主 bundle 之外——仅在首次打开 PDF 时取回。
 * worker 与 CJK cmaps 在此集中配置。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';

// `?url` 让 Vite 构建期把 worker 作为资产发射；dev/build 路径稳定，pnpm 下不依赖 node_modules 猜测。
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type { PDFDocumentProxy };

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** 惰性加载 pdfjs-dist 并设置 worker 源（幂等）。 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return m;
    });
  }
  return pdfjsPromise;
}

/** getDocument() 选项 —— CJK cmaps，让中文 PDF 字形正确渲染。 */
export function pdfCMapOptions(): { cMapUrl: string; cMapPacked: boolean } {
  return { cMapUrl: `${import.meta.env.BASE_URL}cmaps/`, cMapPacked: true };
}
