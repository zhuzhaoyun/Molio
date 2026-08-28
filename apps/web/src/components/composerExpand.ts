import type { TreeNode } from '@molio/contracts';

/**
 * Claude Code-style composer ref expansion — the send-time half of the
 * `@` / `/` interaction. The composer keeps RAW text in the input box
 * (`/docling 处理 @notes/a.md`, WYSIWYG); this module is the single place
 * where that text becomes the message an agent actually receives:
 *
 *   - a leading `/name` matching an enabled skill   → i18n'd invocation prefix
 *   - an `@path` matching a vault file / folder      → markdown link
 *
 * Everything unmatched stays literal, so emails (`t@example.com`) and stray
 * slashes pass through untouched. Runtime-agnostic by construction: no agent
 * CLI ever needs to understand `@` / `/` syntax — they receive ordinary text.
 */

export interface ExpandSkillEntry {
  id: string;
  name: string;
}

export interface ExpandOpts {
  /** Enabled skills available for leading `/name` matching. */
  skills?: ExpandSkillEntry[];
  /** i18n template for the invocation prefix, e.g. `用 {name} skill `. */
  skillPrefixTemplate?: string;
  /** Vault-relative paths considered valid `@` references (dirs keep trailing `/`). */
  knownPaths?: Iterable<string>;
}

/** Title hint telling the agent to enumerate a referenced folder. */
const FOLDER_TITLE = '文件夹，请读取其下所有相关文件';

/** Markdown link for a vault-relative file or folder path (agent-facing format). */
export function fileRefMarkdown(path: string, isDirectory: boolean): string {
  const name = path.replace(/\/$/, '').split('/').pop() ?? path;
  if (isDirectory) {
    const p = path.endsWith('/') ? path : `${path}/`;
    return `[📁 ${name}/](${p} "${FOLDER_TITLE}")`;
  }
  return `[📄 ${name}](${path})`;
}

interface TreeNodeBase {
  path: string;
  type: string;
  children?: TreeNodeBase[];
}

/**
 * Flatten a vault file tree into a Set of vault-relative paths; directories
 * carry a trailing `/` so `@folder/` references and file tokens never collide.
 */
export function flattenTreePaths(nodes: TreeNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: TreeNodeBase[]) => {
    for (const n of list) {
      out.add(n.type === 'directory' ? `${n.path}/` : n.path);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes as TreeNodeBase[]);
  return out;
}

/** Leading `/name` on the message (name = one non-space token). */
const LEADING_SKILL_RE = /^\/(\S+)([\s\S]*)$/;

export function expandComposerMessage(text: string, opts: ExpandOpts = {}): string {
  let out = text;

  // 1. Leading skill reference — exact name match first, then case-insensitive
  //    (Chinese names are exact either way; latin names get the lenient path).
  const m = out.match(LEADING_SKILL_RE);
  if (m && opts.skills?.length) {
    const name = m[1] ?? '';
    const rest = m[2] ?? '';
    const lower = name.toLowerCase();
    const skill =
      opts.skills.find((s) => s.name === name) ??
      opts.skills.find((s) => s.name.toLowerCase() === lower);
    if (skill) {
      const template = opts.skillPrefixTemplate ?? '用 {name} skill ';
      out = `${template.replace('{name}', skill.name)}${rest.startsWith(' ') ? rest.slice(1) : rest}`;
    }
  }

  // 2. `@path` references — only tokens that resolve against knownPaths are
  //    rewritten; the preceding whitespace is preserved as-is.
  if (opts.knownPaths) {
    const known = opts.knownPaths instanceof Set ? opts.knownPaths : new Set(opts.knownPaths);
    out = out.replace(/(^|\s)@([^\s@]+)/g, (whole, lead: string, token: string) => {
      if (!known.has(token)) return whole;
      const isDir = token.endsWith('/');
      return `${lead}${fileRefMarkdown(token, isDir)}`;
    });
  }

  return out;
}
