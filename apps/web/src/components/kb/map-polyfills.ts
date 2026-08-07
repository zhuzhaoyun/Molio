/**
 * ES2025 `Map` 补充方法 polyfill。
 *
 * pdf.js v6 依赖 `Map.prototype.getOrInsert` / `getOrInsertComputed`
 * （ES2025，Chromium 145+ 才落地）。Electron 40 内置 Chromium 144 尚未实现，
 * 直接运行会抛 `this._requestsByChunk.getOrInsertComputed is not a function`，
 * 导致所有 PDF 加载失败（主线程 getDocument 与 worker 页面渲染都会踩到）。
 *
 * 这两个方法都是纯 JS 语义（无引擎内部依赖），可以安全 polyfill。
 * 必须在 pdfjs-dist 及其 worker 加载前执行：
 *   - 主线程：main.tsx（应用入口）导入本模块
 *   - worker：pdf-worker.mjs（worker 包装入口）导入本模块
 */

declare global {
  interface Map<K, V> {
    /** 若 key 已存在返回现值，否则插入 value 并返回它（ES2025）。 */
    getOrInsert(key: K, value: V): V;
    /** 若 key 已存在返回现值，否则调用 callback(key) 得到值并插入返回（ES2025）。 */
    getOrInsertComputed(key: K, callback: (key: K) => V): V;
  }
}

export function installMapPolyfills(): void {
  if (typeof Map.prototype.getOrInsert !== 'function') {
    Map.prototype.getOrInsert = function getOrInsert<K, V>(this: Map<K, V>, key: K, value: V): V {
      if (!this.has(key)) this.set(key, value);
      return this.get(key)!;
    };
  }
  if (typeof Map.prototype.getOrInsertComputed !== 'function') {
    Map.prototype.getOrInsertComputed = function getOrInsertComputed<K, V>(
      this: Map<K, V>,
      key: K,
      callback: (key: K) => V,
    ): V {
      if (!this.has(key)) this.set(key, callback(key));
      return this.get(key)!;
    };
  }
}

// 副作用：导入即安装（幂等），保证先于任何 pdfjs-dist 代码执行
installMapPolyfills();
