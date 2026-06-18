// Zero-dependency HTML → Markdown converter for WeChat articles.
// Handles: tables, code blocks, headings, images, lists, links, bold/italic, blockquotes.
'use strict';

const { decodeHtmlEntities } = require('./parser');

/**
 * Convert WeChat article HTML to clean Markdown.
 * @param {string} html - inner HTML of #js_content
 * @returns {string} Markdown text
 */
function htmlToMarkdown(html) {
  if (!html) return '';

  let md = html;

  // ── Pre-process: normalize whitespace and self-closing tags ──
  md = md.replace(/\r\n/g, '\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');

  // ── Code blocks (must be before other tag processing) ──
  md = md.replace(/<pre[^>]*>\s*<code[^>]*(?:class=["'](?:language-)?(\w+)["'])?[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_match, lang, code) => {
      const decoded = decodeHtmlEntities(stripTags(code));
      return `\n\`\`\`${lang || ''}\n${decoded}\n\`\`\`\n`;
    });

  // Inline code
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, code) => {
    return '`' + decodeHtmlEntities(stripTags(code)) + '`';
  });

  // ── Tables ──
  md = convertTables(md);

  // ── Headings ──
  for (let i = 6; i >= 1; i--) {
    const hashes = '#'.repeat(i);
    md = md.replace(new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi'), (_match, content) => {
      return `\n${hashes} ${inlineConvert(content).trim()}\n`;
    });
  }

  // ── Images ──
  md = md.replace(/<img[^>]+src=["']([^"']*)["'][^>]*\/?>/gi, (_match, src) => {
    const alt = _match.match(/alt=["']([^"']*)["']/i);
    return `![${alt ? alt[1] : ''}](${src})`;
  });

  // Also handle data-src (WeChat lazy loading)
  md = md.replace(/<img[^>]+data-src=["']([^"']*)["'][^>]*\/?>/gi, (_match, src) => {
    if (md.includes(`![](${src})`) || md.includes(`](${src})`)) return '';
    const alt = _match.match(/alt=["']([^"']*)["']/i);
    return `![${alt ? alt[1] : ''}](${src})`;
  });

  // ── Blockquotes ──
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, content) => {
    const lines = inlineConvert(content).trim().split('\n');
    return '\n' + lines.map(l => `> ${l}`).join('\n') + '\n';
  });

  // ── Lists ──
  // Unordered
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_match, content) => {
    return '\n' + convertListItems(content, 'ul') + '\n';
  });
  // Ordered
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_match, content) => {
    return '\n' + convertListItems(content, 'ol') + '\n';
  });

  // ── Links ──
  md = md.replace(/<a[^>]+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, text) => {
    const cleanText = inlineConvert(text).trim();
    if (!cleanText) return '';
    return `[${cleanText}](${href})`;
  });

  // ── Bold / Italic ──
  md = md.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, c) => `**${inlineConvert(c)}**`);
  md = md.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_m, c) => `*${inlineConvert(c)}*`);

  // ── Paragraphs / Divs / Sections ──
  md = md.replace(/<\/p>/gi, '\n\n');
  md = md.replace(/<\/div>/gi, '\n');
  md = md.replace(/<\/section>/gi, '\n');

  // ── Strip remaining tags ──
  md = stripTags(md);

  // ── Decode entities ──
  md = decodeHtmlEntities(md);

  // ── Clean up whitespace ──
  md = md.replace(/[ \t]+/g, ' ');          // collapse horizontal whitespace
  md = md.replace(/\n{3,}/g, '\n\n');        // max 2 consecutive newlines
  md = md.replace(/^\n+/g, '');              // trim leading newlines
  md = md.replace(/\n+$/g, '\n');            // single trailing newline

  return md.trim() + '\n';
}

// ─── Table conversion ───

function convertTables(html) {
  // Match <table>...</table> blocks
  return html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_match, tableContent) => {
    const rows = [];
    const trMatches = tableContent.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);

    for (const trMatch of trMatches) {
      const cells = [];
      const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
        cells.push(inlineConvert(cellMatch[1]).trim().replace(/\|/g, '\\|').replace(/\n/g, ' '));
      }
      if (cells.length > 0) rows.push(cells);
    }

    if (rows.length === 0) return '';

    // Normalize column count
    const maxCols = Math.max(...rows.map(r => r.length));
    for (const row of rows) {
      while (row.length < maxCols) row.push('');
    }

    // Build GFM table
    const header = '| ' + rows[0].join(' | ') + ' |';
    const separator = '| ' + rows[0].map(() => '---').join(' | ') + ' |';
    const body = rows.slice(1).map(row => '| ' + row.join(' | ') + ' |');

    return '\n' + [header, separator, ...body].join('\n') + '\n';
  });
}

// ─── List item conversion ───

function convertListItems(html, type) {
  const items = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  let index = 1;

  while ((match = liRegex.exec(html)) !== null) {
    const content = inlineConvert(match[1]).trim();
    if (type === 'ol') {
      items.push(`${index}. ${content}`);
      index++;
    } else {
      items.push(`- ${content}`);
    }
  }

  return items.join('\n');
}

// ─── Inline element conversion ───

function inlineConvert(html) {
  let result = html;

  // Bold
  result = result.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  // Italic
  result = result.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');
  // Inline code
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // Links
  result = result.replace(/<a[^>]+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Images
  result = result.replace(/<img[^>]+(?:src|data-src)=["']([^"']*)["'][^>]*/gi, '![]($1)');
  // Line breaks
  result = result.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags
  result = stripTags(result);
  result = decodeHtmlEntities(result);

  return result;
}

// ─── Tag stripping ───

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

module.exports = { htmlToMarkdown };
