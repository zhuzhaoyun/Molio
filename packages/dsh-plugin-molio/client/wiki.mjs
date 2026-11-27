const token = /(?<!!)\[\[([^[\]|\r\n]+)(?:\|([^[\]\r\n]+))?\]\]/gu;

export function wikiParts(text) {
  const parts = [];
  let start = 0;
  for (const match of text.matchAll(token)) {
    const target = match[1].trim();
    const page = target.split('#')[0].trim();
    if (!page) continue;
    parts.push(text.slice(start, match.index), { page, label: match[2]?.trim() || target });
    start = match.index + match[0].length;
  }
  return [...parts, text.slice(start)];
}

export function fileAddress(session, path) {
  const normalized = path.replace(/^\/([a-z]:[\\/])/i, '$1').replaceAll('\\', '/');
  const segments = normalized.split('/').map(segment => encodeURIComponent(segment).replace(/%3A/gi, ':'));
  return 'dsh-resource://file/session/' + encodeURIComponent(session) + '/' + segments.join('/');
}

// DSH exposes a document renderer and session slots, but no inline Markdown token hook.
// Keep React's original text nodes attached. Only decorate settled text and undo on disposal.
export function decorateWiki(root, selector, open, allowCode = false) {
  const decorations = new Map();
  function scan(element) {
    if (!element?.isConnected || (!element.closest(selector) && !element.querySelector(selector))) return;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!node.data.includes('[[') || !parent.closest(selector) ||
          parent.closest('a,pre,textarea,button,[contenteditable=true],[data-molio-wiki],[data-streaming=true]')) continue;
      if (parent.closest('code') && !(allowCode && /^ *\[\[[^[\]]+\]\] *$/u.test(node.data))) continue;
      const parts = wikiParts(node.data);
      if (parts.length === 1) continue;
      const span = document.createElement('span');
      span.dataset.molioWiki = '';
      for (const part of parts) {
        if (typeof part === 'string') { span.append(part); continue; }
        const link = document.createElement('a');
        link.href = '#' + encodeURIComponent(part.page);
        link.textContent = part.label;
        link.onclick = event => { event.preventDefault(); void open(part.page).catch(error => window.alert(error.message)); };
        span.append(link);
      }
      decorations.set(node, { span, text: node.data });
      node.data = '';
      node.after(span);
    }
  }
  const observer = new MutationObserver(records => {
    for (const [node, { span }] of decorations) {
      if (!root.contains(node) || node.data) { span.remove(); decorations.delete(node); }
    }
    for (const record of records) {
      if (record.type === 'characterData') scan(record.target.parentElement);
      else if (record.type === 'attributes') scan(record.target);
      else for (const node of record.addedNodes) scan(node.nodeType === 1 ? node : node.parentElement);
    }
  });
  scan(root);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-streaming'] });
  return () => {
    observer.disconnect();
    for (const [node, { span, text }] of decorations) { if (!node.data) node.data = text; span.remove(); }
    decorations.clear();
  };
}
