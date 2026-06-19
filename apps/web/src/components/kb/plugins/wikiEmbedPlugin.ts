/**
 * Milkdown remark plugin — converts ![[file.png|WxH]] wiki embed syntax
 */
import { $remark } from '@milkdown/kit/utils';

export interface WikiEmbedOptions {
  vaultId?: string;
}

function buildRawUrl(file: string, vaultId: string): string {
  const encoded = encodeURIComponent(file.trim());
  return `${window.location.origin}/api/knowledge/vaults/${vaultId}/raw/${encoded}`;
}

const WIKI_EMBED_RE = /^!\[\[([^\]|]+)(?:\|(\d+)(?:x(\d+))?)?\]\]$/;

export function wikiEmbedPlugin(opts: WikiEmbedOptions = {}) {
  const { vaultId } = opts;

  return $remark('molio-wiki-embed', () => (tree: { children: Array<{ type: string; value?: string; children?: unknown[] }> }) => {
    // Walk the MDAST tree and transform text nodes matching ![[...]]
    function walk(nodes: Array<{ type: string; value?: string; children?: unknown[]; [k: string]: unknown }>) {
      for (const node of nodes) {
        if (node.type === 'text' && typeof node.value === 'string') {
          const match = WIKI_EMBED_RE.exec(node.value);
          if (match && vaultId) {
            const [, file, width, height] = match;
            const src = buildRawUrl(file, vaultId);
            const alt = file;
            // Replace text node with image node
            Object.assign(node, {
              type: 'image',
              url: src,
              alt,
              title: `![[${file}${width ? (height ? `|${width}x${height}` : `|${width}`) : ''}]]`,
            } as Record<string, unknown>);
            delete node.value;
          }
        }
        if (node.children && Array.isArray(node.children)) {
          walk(node.children as Array<{ type: string; value?: string; children?: unknown[]; [k: string]: unknown }>);
        }
      }
    }
    walk(tree.children as Array<{ type: string; value?: string; children?: unknown[]; [k: string]: unknown }>);
  });
}
