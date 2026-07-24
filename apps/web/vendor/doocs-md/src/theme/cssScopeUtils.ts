/**
 * CSS scope utility — prefixes unscoped CSS rules with a container selector.
 *
 * Used in two places:
 * 1. copyToClipboard (useKnowledge.ts) — bundles theme CSS with rendered HTML
 * 2. bridge-page.ts — inline JS (duplicated as raw string because the bridge
 *    page is a daemon-generated HTML string, not a bundler output)
 *
 * Both implementations must stay in sync.
 */

const CSS_RULE_REGEX = /([^{}]+)\{([^}]*)\}/g;

/**
 * Scope unscoped CSS rules to a container selector.
 *
 * Rules that already contain the scope selector, :root rules, and @-rules
 * are left unchanged. All other selectors are prefixed with `scope `.
 *
 * @param css - Raw CSS string
 * @param scope - Container selector (default `#output`)
 * @returns CSS with unscoped rules prefixed
 */
export function scopeCSS(css: string, scope: string = '#output'): string {
  // Remove CSS comments to avoid regex false matches
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  return cssWithoutComments.replace(
    CSS_RULE_REGEX,
    (match, selectors: string, properties: string) => {
      const trimmed = selectors.trim();

      // Skip @-rules, :root, and already-scoped rules
      if (
        trimmed.startsWith('@') ||
        trimmed.startsWith(':root') ||
        trimmed.includes(scope)
      ) {
        return match;
      }

      // Prefix each comma-separated selector with the scope
      const wrapped = selectors
        .split(',')
        .map((s) => {
          s = s.trim();
          if (!s || s.includes(scope)) return s;
          return `${scope} ${s}`;
        })
        .filter(Boolean)
        .join(',\n');

      return `${wrapped} {${properties}}`;
    },
  );
}
