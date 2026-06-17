/**
 * Lightweight Markdown renderer for chat messages.
 *
 * Handles: paragraphs, code blocks, inline code, bold, italic, links, lists,
 * headers, blockquotes, tables, horizontal rules, wiki-links.
 *
 * For rich Markdown rendering (KaTeX, Mermaid, code highlighting, etc.),
 * the Knowledge Base uses the full doocs/md pipeline via MdRenderer.
 */

/**
 * Render Markdown text to HTML.
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';

  // Escape HTML
  let html = escapeHtml(text);

  // Strikethrough (before bold/italic to avoid ** conflict)
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Wiki-links: [[Page Name]] or [[Page Name|display text]]
  html = html.replace(
    /\[\[([^\]|]+)\|([^\]]+)\]\]/g,
    '<a class="kb-wiki-link">$2</a>'
  );
  html = html.replace(
    /\[\[([^\]]+)\]\]/g,
    '<a class="kb-wiki-link">$1</a>'
  );

  // Standard links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Task lists (before standard unordered lists)
  html = html.replace(/^- \[x\] (.+)$/gm, '<li class="task-list-item"><input type="checkbox" class="md-task-checkbox" checked disabled>$1</li>');
  html = html.replace(/^- \[ \] (.+)$/gm, '<li class="task-list-item"><input type="checkbox" class="md-task-checkbox" disabled>$1</li>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Tables (basic)
  html = html.replace(
    /^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm,
    (_m, headerRow, _sepRow, bodyRows) => {
      const headers = headerRow
        .split('|')
        .filter(Boolean)
        .map((h: string) => `<th>${h.trim()}</th>`)
        .join('');
      const rows = bodyRows
        .trim()
        .split('\n')
        .map((row: string) => {
          const cells = row
            .split('|')
            .filter(Boolean)
            .map((c: string) => `<td>${c.trim()}</td>`)
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    }
  );

  // Paragraphs — wrap remaining text blocks
  html = html
    .split(/\n\n+/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (/^<[hupbolt]|^<hr|^<table|^<blockquote|^<div/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
