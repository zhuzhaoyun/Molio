import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

const PUBLIC_ASSET = /^\/api\/public\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?revision=\d+$/i;

export function renderPublicMarkdown(markdown: string, revision: number, imageUnavailableLabel = 'Image unavailable'): string {
  const safeImageUnavailableLabel = imageUnavailableLabel.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
  const linked = markdown
    .replace(/\[\[molio-image-unavailable\]\]/g, safeImageUnavailableLabel)
    .replace(/\]\(molio-page:([0-9a-f-]{36})\)/gi, `](/public/wiki/$1?revision=${revision})`)
    .replace(/\]\(molio-asset:([0-9a-f-]{36})\)/gi, `](/api/public/assets/$1?revision=${revision})`)
    .replace(/\]\(molio-unavailable:\)/g, '](#unavailable)');
  const rendered = marked.parse(linked, { async: false, gfm: true }) as string;
  const fragment = DOMPurify.sanitize(rendered, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'video', 'audio', 'source', 'svg', 'math'],
    FORBID_ATTR: ['style', 'onerror', 'onclick'],
  }) as unknown as DocumentFragment;
  const container = fragment.ownerDocument.createElement('div');
  container.append(fragment);
  for (const image of container.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? '';
    if (!PUBLIC_ASSET.test(src)) image.remove();
  }
  return container.innerHTML;
}
