/**
 * Custom HTML → Markdown converter.
 *
 * Walks a live DOM tree (must be called inside a renderer / browser context)
 * and emits a Markdown string. Pure DOM APIs only — no Node globals — so the
 * function source can be `.toString()`'d and inlined into
 * `webContents.executeJavaScript` from the Electron main process.
 *
 * Deliberately avoids backticks in its own source so the surrounding template
 * literal that inlines it stays intact.
 *
 * Coverage aims for the docx/wiki DOM shape Feishu uses: headings, paragraphs,
 * inline emphasis, inline + block code, links, images, lists, blockquotes,
 * tables (GFM simplified). Callout containers fall through to their child
 * nodes. Anything unknown falls through to its children — never silent loss.
 */

export function htmlToMarkdown(root) {
  if (!root) return '';
  var out = [];
  var MAX_LEN = 200000;

  function push(s) {
    if (s == null) return;
    out.push(String(s));
  }

  function textOf(el) {
    return (el && el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isLinkTarget(href) {
    return typeof href === 'string' && href.length > 0 && href.indexOf('javascript:') !== 0;
  }

  function walkList(list) {
    var items = [];
    var ordered = list.tagName.toLowerCase() === 'ol';
    var i = 0;
    var children = list.children;
    for (var k = 0; k < children.length; k++) {
      var li = children[k];
      if (!li || li.tagName.toLowerCase() !== 'li') continue;
      i++;
      var prefix = ordered ? (i + '. ') : '- ';
      // Render the item's CONTENTS only. Calling htmlToMarkdown(li) here would
      // walk(li) → case 'li' → recurse on the same node forever.
      var inner = renderChildrenToString(li).replace(/\s+$/, '');
      items.push(prefix + inner);
    }
    return items.join('\n');
  }

  function walkTable(table) {
    var rows = table.rows;
    if (!rows || rows.length === 0) return '';
    var lines = [];
    var colCount = 0;
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].cells;
      if (!cells) continue;
      var line = [];
      for (var c = 0; c < cells.length; c++) {
        var cellText = textOf(cells[c]);
        // Escape pipes in cell content to keep GFM table intact.
        if (cellText.indexOf('|') >= 0) cellText = cellText.replace(/\|/g, '\\|');
        line.push(cellText || ' ');
      }
      if (line.length > colCount) colCount = line.length;
      lines.push('| ' + line.join(' | ') + ' |');
      if (r === 0) {
        var sep = [];
        for (var s = 0; s < colCount; s++) sep.push('---');
        lines.push('| ' + sep.join(' | ') + ' |');
      }
    }
    return lines.join('\n');
  }

  function walkCodeBlock(pre) {
    var codeEl = pre.querySelector('code');
    var raw = codeEl ? codeEl.textContent : pre.textContent;
    var lang = '';
    if (codeEl && codeEl.className) {
      var m = codeEl.className.match(/language-([\w-]+)/);
      if (m) lang = m[1];
    }
    return '```' + lang + '\n' + (raw || '').replace(/^\n+|\n+$/g, '') + '\n```';
  }

  function walk(node) {
    if (!node) return;
    var nodeType = node.nodeType;
    if (nodeType === 3) {
      var t = (node.nodeValue || '').replace(/\s+/g, ' ');
      if (t.trim()) push(t);
      return;
    }
    if (nodeType !== 1) return;
    var tag = (node.tagName || '').toLowerCase();
    switch (tag) {
      case 'script':
      case 'style':
      case 'noscript':
      case 'template':
        return;
      case 'h1': push('\n\n# ' + textOf(node) + '\n\n'); return;
      case 'h2': push('\n\n## ' + textOf(node) + '\n\n'); return;
      case 'h3': push('\n\n### ' + textOf(node) + '\n\n'); return;
      case 'h4': push('\n\n#### ' + textOf(node) + '\n\n'); return;
      case 'h5': push('\n\n##### ' + textOf(node) + '\n\n'); return;
      case 'h6': push('\n\n###### ' + textOf(node) + '\n\n'); return;
      case 'br': push('  \n'); return;
      case 'hr': push('\n\n---\n\n'); return;
      case 'p': push('\n\n'); walkChildren(node); push('\n\n'); return;
      case 'strong':
      case 'b':
        push('**'); walkChildren(node); push('**'); return;
      case 'em':
      case 'i':
        push('*'); walkChildren(node); push('*'); return;
      case 'del':
      case 's':
        push('~~'); walkChildren(node); push('~~'); return;
      case 'code': {
        var parentTag = node.parentElement && node.parentElement.tagName.toLowerCase();
        if (parentTag === 'pre') return; // handled by <pre> walker
        push('`' + textOf(node) + '`');
        return;
      }
      case 'pre':
        push('\n\n' + walkCodeBlock(node) + '\n\n');
        return;
      case 'blockquote': {
        // Render the quote's children into an isolated string. Calling
        // htmlToMarkdown(node) would re-enter this very case → infinite
        // recursion (RangeError) on every blockquote.
        var inner = renderChildrenToString(node).replace(/^\s+|\s+$/g, '');
        if (!inner) return;
        var quoted = inner.split('\n').map(function (l) { return '> ' + l; }).join('\n');
        push('\n\n' + quoted + '\n\n');
        return;
      }
      case 'ul':
      case 'ol':
        push('\n\n' + walkList(node) + '\n\n');
        return;
      case 'li':
        // Only reached for a bare <li> outside a ul/ol (malformed HTML); list
        // items inside ul/ol are rendered by walkList via renderChildrenToString,
        // which never re-enters this case. Render contents (NOT htmlToMarkdown
        // on this node — that would recurse on itself forever).
        push('- ' + renderChildrenToString(node).replace(/\s+$/g, ''));
        return;
      case 'a': {
        var href = node.getAttribute('href') || '';
        var label = textOf(node) || href;
        if (isLinkTarget(href)) push('[' + label + '](' + href + ')');
        else push(label);
        return;
      }
      case 'img': {
        var src = node.getAttribute('src') || node.getAttribute('data-src') || '';
        var alt = node.getAttribute('alt') || '';
        if (src) push('![' + alt + '](' + src + ')');
        return;
      }
      case 'table':
        push('\n\n' + walkTable(node) + '\n\n');
        return;
      case 'input': {
        var type = (node.getAttribute('type') || '').toLowerCase();
        if (type === 'checkbox') {
          push(node.checked ? '[x] ' : '[ ] ');
        }
        return;
      }
      default:
        walkChildren(node);
        return;
    }
  }

  function walkChildren(parent) {
    var children = parent.childNodes;
    for (var i = 0; i < children.length; i++) walk(children[i]);
  }

  // Render `parent`'s CHILDREN into an isolated string, without re-walking
  // `parent` itself. blockquote/li/walkList need the inner content as a string;
  // calling htmlToMarkdown(parent) for that would walk(parent) → re-enter the
  // same case → infinite recursion (RangeError) on any list or blockquote.
  // Swapping `out` (which push() reads by reference) keeps nested calls correct.
  function renderChildrenToString(parent) {
    var saved = out;
    out = [];
    walkChildren(parent);
    var s = out.join('');
    out = saved;
    return s;
  }

  walk(root);
  var md = out.join('');
  md = md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  if (md.length > MAX_LEN) md = md.slice(0, MAX_LEN);
  return md;
}
