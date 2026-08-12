import { reconcileBundledSync, BUILTIN_SKILLS } from '../../src/core/skill-installer.js';

/**
 * Shared test helper — the "install everything" mode (the old
 * installBuiltinSkills behavior): every bundled skill is both effective
 * (installed) and managed, so all rules are active. Tests that need
 * per-vault enable/disable permutations call reconcileBundledSync directly.
 *
 * Lives outside any *.test.js glob so node --test never loads it as a suite.
 */
const ALL_BUNDLED = new Set<string>(BUILTIN_SKILLS);

export function installAll(vaultPath: string): void {
  reconcileBundledSync(ALL_BUNDLED, ALL_BUNDLED, vaultPath);
}
