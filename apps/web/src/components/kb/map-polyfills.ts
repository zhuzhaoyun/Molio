/**
 * pdf.js v6 所需、而 Electron 40（内置 Chromium 144）缺失的补充 polyfill。
 *
 * 缺一即破坏 PDF 渲染：
 * - `Map.prototype.getOrInsert` / `getOrInsertComputed`（ES2025，Chromium 145+）
 *   缺失会抛 `this._requestsByChunk.getOrInsertComputed is not a function`，所有 PDF 加载失败。
 * - `Math.sumPrecise`（TC39 ULP 求和提案，Chromium 145+）缺失会被 pdf.js 的字节流读取
 *   路径吞成 Warning，导致缓冲长度算错、非内嵌字体（如微软雅黑）渲染成 `!"#$%` 乱码
 *   （页面图像正常、canvas 文字乱码，但文本层抽取的 Unicode/复制/搜索仍正确）。
 *
 * 这些方法都是纯 JS 语义（无引擎内部依赖），可以安全 polyfill。
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
  interface Math {
    /** TC39 ULP 求和（Chromium 145+/Node 25+；本库需 polyfill 以支撑 pdf.js v6）。 */
    sumPrecise(values: Iterable<number>): number;
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
  // `Math.sumPrecise`（见文件头注释）：pdf.js 读 PDF 字节流时用它求缓冲长度。
  // 简单累加即可满足求和语义（缓冲长度都是小整数）。
  if (typeof Math.sumPrecise !== 'function') {
    Math.sumPrecise = function sumPrecise(values: Iterable<number>): number {
      let sum = 0;
      for (const v of values) sum += Number(v);
      return sum;
    };
  }
}

// 副作用：导入即安装（幂等），保证先于任何 pdfjs-dist 代码执行
installMapPolyfills();
