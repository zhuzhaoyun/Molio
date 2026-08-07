import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    // pdf.js CJK 字形映射 —— 构建期拷一次；pdfCMapOptions() 通过 BASE_URL + 'cmaps/' 引用
    viteStaticCopy({
      // v4 始终保留目录结构，stripBase 平铺到 dist/cmaps/，与 pdfCMapOptions() 的 /cmaps/ 引用一致
      targets: [{ src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'cmaps', rename: { stripBase: true } }],
    }),
  ],
  resolve: {
    alias: {
      // Alias for vendored doocs-md module
      '@molio/doocs-md': path.resolve(__dirname, 'vendor/doocs-md'),
    },
  },
  // pdf-worker.mjs（pdf.js worker 包装入口）被 pdf.js 以 `type: "module"` 创建，
  // `?worker&url` 的打包产物必须是 ES module（iife 无法作为模块 worker 实例化）。
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env['MOLIO_DAEMON'] ?? 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
});
