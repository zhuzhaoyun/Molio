/**
 * Split a long text into chunks no larger than `limit` chars, preferring to
 * cut at paragraph breaks (\n\n), then line breaks (\n), then a hard cut when
 * neither is available. Used by weixin (limit 4000) and feishu (limit 3000)
 * for chunked IM replies — each channel has its own per-message size cap.
 *
 * Pure function of (text, limit) — no protocol-specific code.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }
    // Try to cut at the last paragraph break within the limit, then last
    // line break, then a hard cut. `lastIndexOf('\n\n', limit)` finds the
    // last index <= limit where '\n\n' starts.
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  return chunks;
}
