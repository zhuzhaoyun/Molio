/**
 * 导出文件名公共片段。
 *
 * 图谱出图与文档出图共用一个 slug 规则：Windows 禁止字符（`<>:"/\|?*` 与
 * 控制字符）一律替换、空白折成单个 `-`、首尾 `-.` 去掉、限长 40 —— 保证下载
 * 目录里既能一眼认出是哪份内容，又不会因为库名/文件名带符号而写不出文件。
 */
export function slugifyTitle(title: string | undefined): string {
  if (!title) return '';
  return title
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
    .replace(/[-.]+$/, '');
}
