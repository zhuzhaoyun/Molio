/**
 * Shared Markdown rendering utilities.
 *
 * `renderMarkdown` — lightweight renderer for chat messages.
 * `renderKnowledgeMarkdown` — enhanced renderer for knowledge base pages
 *   with frontmatter parsing and wiki-link support.
 */

// ─── Frontmatter parsing ───

export interface Frontmatter {
  [key: string]: string | string[];
}

/**
 * Extract YAML frontmatter from a markdown string.
 * Returns { frontmatter, body } where body is the content after the frontmatter block.
 */
export function parseFrontmatter(text: string): { frontmatter: Frontmatter | null; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match || match[1] == null || match[2] == null) return { frontmatter: null, body: text };

  const yamlBlock: string = match[1];
  const body: string = match[2];

  const frontmatter: Frontmatter = {};
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: string | string[] = line.slice(colonIdx + 1).trim();

    // Parse simple YAML arrays: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/**
 * Render frontmatter as an HTML block.
 */
export function renderFrontmatterHtml(fm: Frontmatter): string {
  const lines = Object.entries(fm).map(([key, val]) => {
    const display = Array.isArray(val) ? val.join(', ') : val;
    return `<div class="kb-fm-line"><span class="kb-fm-key">${escapeHtml(key)}:</span><span class="kb-fm-val">${escapeHtml(display)}</span></div>`;
  });
  return `<div class="kb-frontmatter">${lines.join('')}</div>`;
}

/**
 * Render source tags from frontmatter sources field.
 */
export function renderSourcesHtml(sources: string | string[]): string {
  const list = Array.isArray(sources) ? sources : [sources];
  const tags = list
    .map((s) => `<a class="kb-source-tag" href="#">📄 ${escapeHtml(s)}</a>`)
    .join('');
  return `<div class="kb-sources"><h4>Sources</h4>${tags}</div>`;
}

// ─── Core markdown renderer ───

/**
 * Lightweight Markdown renderer — handles common patterns without a full library.
 * Renders: paragraphs, code blocks, inline code, bold, italic, links, lists,
 * headers, blockquotes, tables, horizontal rules, wiki-links.
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';

  // Escape HTML
  let html = escapeHtml(text);

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

/**
 * Enhanced markdown renderer for knowledge base pages.
 * Parses frontmatter, renders wiki-links, and appends sources.
 */
export function renderKnowledgeMarkdown(text: string): string {
  const { frontmatter, body } = parseFrontmatter(text);

  let html = '';

  // Render frontmatter block
  if (frontmatter) {
    html += renderFrontmatterHtml(frontmatter);
  }

  // Render body
  html += renderMarkdown(body);

  // Append sources if present in frontmatter
  if (frontmatter?.sources) {
    html += renderSourcesHtml(frontmatter.sources);
  }

  return html;
}

/**
 * Strip AskUserQuestion fallback text from content (used by chat).
 */
export function suppressAskUserQuestionFallback(text: string): string {
  return text.replace(/<ask-user-question[\s\S]*?<\/ask-user-question>/gi, '').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
