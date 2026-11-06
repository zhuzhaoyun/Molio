import type { FileRef } from './ChatComposer';
// 显式 .ts 后缀：本模块被 node:test 直接加载（package "type": "module"）
import { fileRefMarkdown } from './composerExpand.ts';

/**
 * 输入框下方「文档引用 chip」的纯逻辑。
 *
 * 引用是**显式对象**（可一键摘除），不是输入框里的文本——这正是它与旧实现
 * （挂载时把 `@路径` 种进 textarea）的区别。
 *
 * 发送时直接生成 agent 侧那份 markdown 链接（与 `@path` 展开的产物同一函数），
 * **不绕回 `@token` 再查文件树**：chip 的路径由 UI 给出、天然可信，没必要为了
 * 展开再等一次 `/tree` 请求（大库上那会把「点发送 → 真的发出」拖慢几百毫秒，
 * 且树未就绪时 chip 会退化成裸 `@path`）。用户自己手打的 `@` 仍走原展开管线。
 */

/** chip 上显示的短名：取路径基名（悬停再用 title 给完整路径）。 */
export function fileRefChipLabel(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '');
  return trimmed.split('/').pop() ?? trimmed;
}

/** 引用的 agent 侧表示（markdown 链接，空格分隔）；无引用时为空串。 */
export function buildFileRefPrefix(refs: FileRef[]): string {
  return refs.map((r) => fileRefMarkdown(r.filePath, !!r.isDirectory)).join(' ');
}
