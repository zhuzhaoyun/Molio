/**
 * Regression tripwire: verifies the installed @arms/rum-electron still carries
 * the UPSTREAM fix (0.0.7+) for the "TypeError: fetch failed" self-report
 * noise, and that the obsolete local pnpm patch wiring stays removed.
 *
 * History (error-driven): v0.3.41 production monitoring showed `TypeError:
 * fetch failed` unhandledRejection exceptions with empty stacks. Root cause:
 * 0.0.5 `electron-reporter.request()` rethrew inside the fetch chain's
 * `.catch(...)` and left the mirror promise of `U.finally(...)` dangling, so
 * every failed ARMS report fired a process-level unhandledRejection that the
 * SDK's own exception collector re-reported (monitoring self-noise loop).
 *
 * Fix timeline:
 * - PR #206 first patched 0.0.5 locally (patches/@arms__rum-electron@0.0.5.patch,
 *   added `.catch(() => {})` on the dangling mirror promise).
 * - Upstream fixed it DIFFERENTLY in 0.0.7: the fetch chain's `.catch` now
 *   SWALLOWS the error (enqueue into the offline queue + "enqueued for retry"
 *   warn) instead of rethrowing, so the promise chain never rejects and the
 *   dangling mirror can never become an unhandledRejection. We upgraded to
 *   0.0.7 and deleted the local patch; this test replaced arms-sdk-patch.test.js.
 *
 * What is asserted (TEXT scan of dist — the SDK cannot be imported outside
 * the Electron runtime):
 * 1. request()'s fetch-chain catch swallows failures into the offline queue
 *    in both index.mjs and index.cjs;
 * 2. no rethrowing catch remains in the reporter (the 0.0.5/0.0.6 pattern);
 * 3. installed SDK version is >= 0.0.7 and the old patch wiring is gone.
 *
 * If this test FAILS after upgrading @arms/rum-electron:
 * 1. Check the new version's electron-reporter.request(): does the fetch
 *    chain's `.catch` still swallow (search "enqueued for retry"), or did
 *    upstream regress to rethrowing?
 * 2. Upstream regression → pin back to 0.0.7 or re-introduce a pnpm patch
 *    (see git history: patches/@arms__rum-electron@0.0.5.patch, commit
 *    cf0ec08). dropFetchFailedNoise in monitoring-sanitize.js remains the
 *    runtime backstop either way.
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
//
// 0.0.7 fix shape (variable names minify away, so match structurally):
//   .catch((x) => { ...enqueue(...), warn("reporter", "...enqueued for retry...", x); })
const ARG = String.raw`(?:\([A-Za-z_$][\w$]*\)|[A-Za-z_$][\w$]*)`;
const SWALLOW_RE = new RegExp(
  String.raw`\.catch\(` + ARG + String.raw`\s*=>\s*\{[^}]*enqueue\([^}]*enqueued for retry[^}]*\}`,
);
// 0.0.5/0.0.6 regression shape: the catch handler RETHROWS after enqueuing,
// which lets the promise chain (and its dangling finally-mirror) reject.
const RETHROW_RE = new RegExp(
  String.raw`\.catch\(` + ARG + String.raw`\s*=>\s*\{[^}]*throw[^}]*enqueue[^}]*\}`,
);

describe('ARMS SDK fetch-leak upstream fix (>= 0.0.7)', () => {
  it('dist/index.mjs: failed reports are swallowed into the offline queue', () => {
    const src = readFileSync(path.join(distDir, 'index.mjs'), 'utf8');
    assert.ok(SWALLOW_RE.test(src),
      'swallowing catch (enqueue + "enqueued for retry") missing from dist/index.mjs — did upstream regress?');
    assert.ok(!RETHROW_RE.test(src),
      'rethrowing catch is back in dist/index.mjs — unhandledRejection self-noise will return');
  });

  it('dist/index.cjs: failed reports are swallowed into the offline queue', () => {
    const src = readFileSync(path.join(distDir, 'index.cjs'), 'utf8');
    assert.ok(SWALLOW_RE.test(src),
      'swallowing catch (enqueue + "enqueued for retry") missing from dist/index.cjs — did upstream regress?');
    assert.ok(!RETHROW_RE.test(src),
      'rethrowing catch is back in dist/index.cjs — unhandledRejection self-noise will return');
  });

  it('installed SDK is >= 0.0.7 and the obsolete local patch is gone', () => {
    const pkg = JSON.parse(readFileSync(path.join(distDir, '..', 'package.json'), 'utf8'));
    const [maj = 0, min = 0, pat = 0] = String(pkg.version).split('-')[0].split('.').map(Number);
    assert.ok(maj > 0 || min > 0 || pat >= 7,
      `@arms/rum-electron ${pkg.version} < 0.0.7 — the fetch-leak fix is not in this version`);

    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const stalePatch = path.join(repoRoot, 'patches', '@arms__rum-electron@0.0.5.patch');
    assert.ok(!existsSync(stalePatch),
      'stale local patch file is back — upstream >= 0.0.7 fixes the leak; re-patching needs a review');

    const workspaceYaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    assert.ok(!workspaceYaml.includes('@arms__rum-electron'),
      'pnpm-workspace.yaml references an @arms/rum-electron patch again');
  });
});
