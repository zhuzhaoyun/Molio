/**
 * pdfjs-dist 惰性加载器。留在主 bundle 之外——仅在首次打开 PDF 时取回。
 * worker 与 CJK cmaps 在此集中配置。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
// ES2025 Map polyfill —— 必须在 pdfjs-dist 求值前安装（Electron 40 / Chromium 144 缺失）。
import { installMapPolyfills } from './map-polyfills';

// `?worker&url` 让 Vite 把 pdf-worker.mjs（包装入口：先装 polyfill 再加载真实 worker）按 worker 打包并返回 URL。
// 真实 worker（pdfjs-dist/build/pdf.worker.min.mjs）仍作为独立 `?url` 资产发射。
import pdfWorkerUrl from './pdf-worker.mjs?worker&url';

export type { PDFDocumentProxy };

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** 惰性加载 pdfjs-dist 并设置 worker 源（幂等）。 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    // 防御性重装：即使 Map 方法被运行时移除（或启动顺序变化），pdfjs 求值前仍保证 polyfill 在位。
    // 幂等 —— 原生实现存在时跳过。
    installMapPolyfills();
    pdfjsPromise = import('pdfjs-dist')
      .then((m) => {
        m.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        return m;
      })
      .catch((err) => {
        // 失败不缓存：允许 reloadNonce 触发的新加载重试
        pdfjsPromise = null;
        throw err;
      });
  }
  return pdfjsPromise;
}

/** getDocument() 选项 —— CJK cmaps，让中文 PDF 字形正确渲染。 */
export function pdfCMapOptions(): { cMapUrl: string; cMapPacked: boolean } {
  return { cMapUrl: `${import.meta.env.BASE_URL}cmaps/`, cMapPacked: true };
}
