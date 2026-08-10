/**
 * Tripwire: verifies the @arms/rum-electron promise-leak patch is ACTUALLY
 * applied to the installed node_modules.
 *
 * Why this test exists (error-driven): production monitoring on v0.3.41 showed
 * `TypeError: fetch failed` unhandledRejection exceptions with empty stacks.
 * Root cause: @arms/rum-electron 0.0.5 `electron-reporter.request()` did
 *
 *   return this.pendingRequests.add(U),
 *          U.finally(() => this.pendingRequests.delete(U)),  // ← dangling!
 *          U;
 *
 * `U.finally(...)` returns a SECOND promise that rejects with the same reason
 * as U. Nothing handled it, so every failed ARMS report fired a process-level
 * unhandledRejection — which the SDK's own exception collector re-reported as
 * an app exception (monitoring self-noise). Fix: patches/ directory +
 * pnpm `patchedDependencies` (applied automatically on install).
 *
 * If this test FAILS after upgrading @arms/rum-electron:
 * 1. Check whether the new version fixed request() upstream (look for the
 *    `.finally(...)` in electron-reporter.request — a dangling mirror promise
 *    is the bug; `.catch(...)` on it is the fix).
 * 2. Fixed upstream → delete the stale patch (pnpm-workspace.yaml
 *    patchedDependencies + patches/ file) and update/relax this tripwire.
 * 3. Still broken upstream → re-run `pnpm patch @arms/rum-electron@<new>` and
 *    re-apply the same fix, then update the version references here.
 *
 * Reads dist sources as TEXT only — deliberately does NOT import the SDK
 * (its load chain fails outside the Electron runtime).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve('@arms/rum-electron');
const distDir = path.dirname(sdkEntry);

// Whitespace-tolerant matchers: the mjs build keeps spaces, the cjs build is
// fully minified — both must pass the same assertions.
const FIXED_RE = /\.finally\(\s*\(\)\s*=>\s*this\.pendingRequests\.delete\(U\)\s*\)\s*\.catch\(/;
const LEAKY_RE = /\.finally\(\s*\(\)\s*=>\s*this\.pendingRequests\.delete\(U\)\s*\)\s*,\s*U/;

describe('ARMS SDK promise-leak patch', () => {
  it('dist/index.mjs: dangling finally-promise is caught', () => {
    const src = readFileSync(path.join(distDir, 'index.mjs'), 'utf8');
    assert.ok(FIXED_RE.test(src), 'patched expression missing from dist/index.mjs — was the pnpm patch applied?');
    assert.ok(!LEAKY_RE.test(src), 'leaky expression still present in dist/index.mjs');
  });

  it('dist/index.cjs: dangling finally-promise is caught', () => {
    const src = readFileSync(path.join(distDir, 'index.cjs'), 'utf8');
    assert.ok(FIXED_RE.test(src), 'patched expression missing from dist/index.cjs — was the pnpm patch applied?');
    assert.ok(!LEAKY_RE.test(src), 'leaky expression still present in dist/index.cjs');
  });

  it('patch file + pnpm-workspace.yaml wiring exist in the repo', () => {
    // Without this wiring a fresh `pnpm install` (e.g. CI) would silently
    // install the unpatched SDK and the node_modules checks above would fail.
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const patchFile = path.join(repoRoot, 'patches', '@arms__rum-electron@0.0.5.patch');
    assert.ok(existsSync(patchFile), `missing patch file: ${patchFile}`);

    const workspaceYaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    assert.ok(workspaceYaml.includes('patchedDependencies'), 'pnpm-workspace.yaml lost patchedDependencies');
    assert.ok(workspaceYaml.includes('@arms__rum-electron@0.0.5.patch'), 'patchedDependencies no longer references the ARMS patch');
  });
});
