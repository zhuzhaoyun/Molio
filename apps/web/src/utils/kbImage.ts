/**
 * KB image path resolution — the rules that decide which file an image
 * reference in a wiki page actually points at.
 *
 * Kept dependency-free (no React, no stores, no window at module scope) so it
 * can be unit-tested with plain `node --test`, the same way
 * `historyFilterQuery.ts` is. These rules are subtle enough that a
 * well-meaning future edit WILL break them, and the failure mode is silent:
 * the image just does not render.
 *
 * Obsidian's rules, which this mirrors:
 *   - `![[file.png]]`   → vault-wide: filename lookup, or a vault-root-relative path
 *   - `![alt](path)`    → path relative to THE NOTE's own folder
 * Both forms are documented as equivalent. Molio historically only handled the
 * first, and only when the path was fully qualified relative to the vault root.
 */

/** Image extensions the raw route can serve (mirrors the daemon's IMAGE_EXTS). */
export const LOCAL_IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;

/** Anything that is already a URL, an inline payload, or a same-page anchor. */
const NON_LOCAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Join a note-relative image path against the note's own directory, the way
 * Obsidian resolves a standard markdown image.
 *
 * `..` that escapes the vault root is PRESERVED rather than clamped: the
 * daemon rejects vault escapes, and clamping would silently turn a broken path
 * into a DIFFERENT path that might accidentally exist — i.e. render the wrong
 * image instead of nothing.
 *
 * The "do not pop a `..`" check is what preserves that. Without it,
 * `../../etc/passwd.png` from a root-level note pops twice against an empty
 * stack and collapses to `etc/passwd.png` — back inside the vault, pointing at
 * a file that may well exist.
 */
export function resolveNoteRelative(notePath: string, src: string): string {
  const dir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
  const out: string[] = [];
  for (const part of `${dir}/${src}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      const last = out[out.length - 1];
      if (out.length && last !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/**
 * Normalize a wikilink embed target before it is percent-encoded into a raw
 * URL. Obsidian's own docs show root-relative paths WITHOUT a leading slash,
 * but hand-written notes (and exports from other tools) routinely write
 * `/图.png` or `./图.png`. A leading slash in particular is dangerous to pass
 * through: the daemon's resolver treats it as an absolute FILESYSTEM path, so
 * on a POSIX host it escapes the vault and is rejected outright.
 */
export function normalizeEmbedTarget(file: string): string {
  return file.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
}

/**
 * Rewrite standard markdown images `![alt](path)` to raw URLs the KB viewer
 * can actually load.
 *
 * Without this they are emitted verbatim as browser-relative URLs against the
 * SPA origin — which serves no vault files — so every one of them 404s. That
 * is why an Obsidian-authored vault, or one built by a tool that emitted
 * `![](path)`, renders as a wall of broken images.
 *
 * @param origin Override for tests; defaults to the current page origin.
 */
export function preprocessLocalImages(
  markdown: string,
  vaultId: string,
  notePath?: string,
  origin?: string,
): string {
  const baseUrl = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  // Consume code before images so examples remain literal. Image destinations
  // allow angle brackets, one balanced parenthesis pair, and optional titles.
  return markdown.replace(
    /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[ \t]*(?=\r?$)|(?![\s\S]))|(`+)[^\n]*?\3(?!`))|!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\n]+>|(?:\\.|[^()\n\\]|\((?:\\.|[^()\\])*\))+?)(\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?\s*\)/gm,
    (whole: string, code: string | undefined, _fence: string, _ticks: string, alt: string, rawSrc: string, title?: string) => {
      if (code) return whole;
      let src = rawSrc.startsWith('<') ? rawSrc.slice(1, -1) : rawSrc;
      if (!src) return whole;
      // External URL, data: URI, protocol-relative //host, or #anchor.
      if (NON_LOCAL_RE.test(src)) return whole;
      // Markdown URLs are encoded already; the raw endpoint decodes its URL
      // once, so decode here before encoding the complete vault-relative path.
      try { src = decodeURIComponent(src); } catch { /* literal percent filename */ }
      src = src.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
      if (!LOCAL_IMAGE_RE.test(src)) return whole;
      const cleaned = src.replace(/\\/g, '/');
      // A leading slash means "from the vault root" — the same meaning a
      // note-relative path has once normalized, so just strip it.
      const resolved = cleaned.startsWith('/')
        ? cleaned.replace(/^\/+/, '')
        : notePath
          ? resolveNoteRelative(notePath, cleaned)
          : cleaned.replace(/^\.\//, '');
      return `![${alt}](${baseUrl}/api/knowledge/vaults/${vaultId}/raw/${encodeURIComponent(resolved)}${title ?? ''})`;
    },
  );
}
