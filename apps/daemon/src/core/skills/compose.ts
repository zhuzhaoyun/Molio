/**
 * Overlay composition — the single source of the "synced view" for every skill.
 *
 * A skill's custom-instruction overlay (自定义指令, `skills.custom_instructions`)
 * is stored SEPARATELY from its base content and only meets it at sync time:
 * the composed SKILL.md is the upstream file with the user's block appended
 * inside a sentinel wrapper. Because composition is derived, the overlay
 * survives app updates (bundled sources swap) and hub refreshes (library
 * sources swap) untouched.
 *
 * Two invariants, both load-bearing:
 *  - EMPTY OVERLAY = BYTE IDENTITY. `composeSkillMd(raw, '')` returns `raw`
 *    itself, so the dirsync hash short-circuit keeps working for the (vast)
 *    no-overlay population — zero behavior change for them.
 *  - APPEND-ONLY. The raw file's bytes (frontmatter INCLUDING extra fields
 *    like allowed-tools) are preserved verbatim; only the sentinel block is
 *    added after them. Never regenerate frontmatter here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyDirSync } from './dirsync.js';

export const USER_CUSTOM_BEGIN = '<!-- molio:user-custom -->';
export const USER_CUSTOM_END = '<!-- /molio:user-custom -->';

/** True when `custom` carries a real overlay (null/undefined/blank all mean none). */
export function hasOverlay(custom: string | null | undefined): boolean {
  return typeof custom === 'string' && custom.trim() !== '';
}

/**
 * Compose a SKILL.md body: `raw` unchanged when there is no overlay; otherwise
 * the sentinel-wrapped user block appended after the raw content.
 */
export function composeSkillMd(raw: string, custom: string): string {
  if (!hasOverlay(custom)) return raw;
  return `${raw}\n\n${USER_CUSTOM_BEGIN}\n${custom}\n${USER_CUSTOM_END}\n`;
}

export interface ComposedSource {
  /** The dir to mirror from — `srcDir` itself when there is no overlay. */
  dir: string;
  /** Removes the temp tree (noop for the no-overlay passthrough). */
  dispose: () => void;
}

/**
 * Materialize the composed view of a skill source dir. No overlay → the source
 * dir itself with a noop dispose (zero copies). With an overlay → a fresh
 * temp dir (mkdtemp under os.tmpdir, OS-cleaned) holding the whole tree with
 * SKILL.md replaced by its composed version. Callers MUST `dispose()` in a
 * finally — this is the "唯一出口" the sync layers mirror from and prove
 * ownership against (design anti-goal #3: one comparison basis, never two).
 */
export function materializeComposedSource(
  srcDir: string,
  custom: string | null | undefined,
): ComposedSource {
  if (!hasOverlay(custom)) return { dir: srcDir, dispose: () => {} };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-composed-'));
  let disposed = false;
  copyDirSync(srcDir, dir);
  const md = path.join(dir, 'SKILL.md');
  fs.writeFileSync(md, composeSkillMd(fs.readFileSync(md, 'utf8'), custom as string), 'utf8');
  return {
    dir,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a leftover temp dir under os.tmpdir is harmless.
      }
    },
  };
}
