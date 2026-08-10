/**
 * pdf.js worker 包装入口。
 *
 * pdf.js v6 的 worker 与主线程一样依赖 ES2025 `Map.prototype.getOrInsert` /
 * `getOrInsertComputed`，而 Electron 40（Chromium 144）尚未实现 —— 直接跑真实
 * worker 会在对象解析、栅格化缓存等路径抛错。本文件先安装 polyfill，再导入真实
 * 的 pdf.worker 模块（其顶层代码同步注册 self.onmessage 消息处理）。
 *
 * 用**静态 import** 而非动态 import + 顶层 await：Vite 会把 polyfill 与真实 worker
 * 一起打进同一 worker bundle（`worker.format: 'es'`，见 vite.config.ts），模块求值
 * 期间 onmessage 就已就位，避免 pdf.js 握手消息在异步 gap 里被丢弃。
 *
 * pdfjs-setup.ts 通过 `?worker&url` 引用本文件，Vite 按 worker 打包/服务。
 */
import './map-polyfills';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
