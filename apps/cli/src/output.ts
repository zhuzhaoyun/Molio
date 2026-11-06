/**
 * 输出约定（面向外部 agent 的硬约定，见 apps/cli/CLAUDE.md）：
 * - stdout 只输出业务数据（--json 时为单个 JSON 值）
 * - 日志 / 进度 / 错误一律 stderr
 *
 * ⚠️ 所有命令层输出必须走本模块（不得直写 process.stdout）：
 * node:test 的报告器也写 process.stdout，测试通过替换 `sinks` 捕获输出，
 * 直写会把报告器噪音混进断言（2026-10 实测踩坑）。
 */

interface WriteSink {
  write(chunk: string): boolean;
}

const stdoutSink: WriteSink = process.stdout;
const stderrSink: WriteSink = process.stderr;

/** 输出汇 — 测试可整体替换以捕获输出，生产环境即 process.stdout/stderr。 */
export const sinks: { stdout: WriteSink; stderr: WriteSink } = {
  stdout: stdoutSink,
  stderr: stderrSink,
};

/** stdout 打印一行文本。 */
export function out(line = ''): void {
  sinks.stdout.write(`${line}\n`);
}

/** stdout 打印 JSON（单个值，紧凑一行 + 换行）。 */
export function outJson(value: unknown): void {
  sinks.stdout.write(`${JSON.stringify(value)}\n`);
}

/** stdout 原样写（流式增量等，不加换行）。 */
export function outRaw(chunk: string): void {
  sinks.stdout.write(chunk);
}

/** stderr 打印错误行（带「错误: 」前缀）。 */
export function errLine(message: string): void {
  sinks.stderr.write(`错误: ${message}\n`);
}

/** stderr 打印提示行（非错误）。 */
export function errLog(message: string): void {
  sinks.stderr.write(`${message}\n`);
}

/**
 * 简单文本表格：按列宽对齐（中文按 2 宽度估算），超长值截断。
 * 仅用于人类可读输出；--json 路径不走这里。
 */
export function formatTable(
  headers: string[],
  rows: string[][],
  opts: { maxWidth?: number } = {},
): string {
  const maxWidth = opts.maxWidth ?? 60;
  const widths = headers.map((h, i) =>
    Math.max(
      displayWidth(h),
      ...rows.map((r) => Math.min(displayWidth(r[i] ?? ''), maxWidth)),
    ),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => pad(cell, Math.min(widths[i] ?? 0, maxWidth)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** 字符串显示宽度（CJK 全角按 2 计）。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += ch.codePointAt(0)! > 0xff ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number): string {
  const truncated = truncateToWidth(s, width);
  return truncated + ' '.repeat(Math.max(0, width - displayWidth(truncated)));
}

function truncateToWidth(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = ch.codePointAt(0)! > 0xff ? 2 : 1;
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/**
 * 文件树的人类可读渲染（缩进 + 目录尾缀 /）。
 * 大树做深度/条数截断，提示用 --json 拿完整结构。
 */
export interface RenderableNode {
  name: string;
  type: 'file' | 'directory';
  children?: RenderableNode[];
  pruned?: boolean;
}

export function renderTree(
  nodes: RenderableNode[],
  opts: { maxLines?: number } = {},
): string {
  const maxLines = opts.maxLines ?? 500;
  const lines: string[] = [];
  let truncated = false;
  const walk = (list: RenderableNode[], prefix: string): void => {
    for (const node of list) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      const suffix = node.type === 'directory' ? '/' : '';
      const prunedHint = node.pruned ? '  (文件过多，已截断)' : '';
      lines.push(`${prefix}${node.name}${suffix}${prunedHint}`);
      if (node.children?.length) walk(node.children, `${prefix}  `);
    }
  };
  walk(nodes, '');
  if (truncated) lines.push(`…（超过 ${maxLines} 行已截断，用 --json 获取完整树）`);
  return lines.join('\n');
}
