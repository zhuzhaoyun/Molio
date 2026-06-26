/**
 * Regression test for issue #80: 文件夹、文件删除失败 (file/folder deletion fails in packaged app)
 *
 * Root cause: esbuild bundles the `trash` JS source into daemon.mjs, but `trash`
 * spawns platform binaries (windows-trash.exe, macos-trash) via
 * `new URL('<bin>', import.meta.url)`. After bundling, `import.meta.url` points
 * at resources/daemon/daemon.mjs, so the binaries must sit next to daemon.mjs.
 * Without them, deletion silently fails with ENOENT at spawn time, and the
 * user sees the file/folder still listed (no error toast, because the web
 * client didn't check res.ok either).
 *
 * Fix: prepare-resources.mjs copies both binaries to resources/daemon/.
 * Web client also now throws on non-2xx response.
 *
 * See: https://github.com/zhuzhaoyun/Molio/issues/80
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prepareResourcesPath = path.resolve(__dirname, '../scripts/prepare-resources.mjs');
const prepareResourcesJs = readFileSync(prepareResourcesPath, 'utf-8');
const resourcesDaemonDir = path.resolve(__dirname, '../resources/daemon');

describe('prepare-resources.mjs: copy trash platform binaries (issue #80)', () => {
  it('should define a copyTrashBinaries function', () => {
    assert.ok(
      prepareResourcesJs.includes('function copyTrashBinaries'),
      'prepare-resources.mjs must define copyTrashBinaries() to copy trash platform binaries'
    );
  });

  it('should copy both windows-trash.exe and macos-trash', () => {
    assert.ok(
      prepareResourcesJs.includes("'windows-trash.exe'") || prepareResourcesJs.includes('"windows-trash.exe"'),
      'must copy windows-trash.exe (Windows recycle bin binary used by trash)'
    );
    assert.ok(
      prepareResourcesJs.includes("'macos-trash'") || prepareResourcesJs.includes('"macos-trash"'),
      'must copy macos-trash (macOS Trash binary used by trash)'
    );
  });

  it('should copy binaries into resources/daemon/ (next to daemon.mjs)', () => {
    // import.meta.url in the bundled daemon.mjs resolves to resources/daemon/daemon.mjs,
    // so the binaries must live in resources/daemon/ — not resources/, not resources/daemon/lib/
    assert.ok(
      prepareResourcesJs.includes("join(resourcesDir, 'daemon')"),
      'binaries must be copied to resources/daemon/ so import.meta.url in daemon.mjs can resolve them'
    );
  });

  it('should call copyTrashBinaries in the main prepare flow', () => {
    assert.ok(
      prepareResourcesJs.includes('copyTrashBinaries()'),
      'prepare-resources.mjs must invoke copyTrashBinaries() in the main flow'
    );
  });

  it('should reference the issue #80 regression context', () => {
    // Make sure future contributors find the bug context if they touch this code.
    assert.ok(
      prepareResourcesJs.includes('issues/80'),
      'prepare-resources.mjs should reference issue #80 in the comment so future edits know the constraint'
    );
  });
});

// Integration check: if prepare-resources has actually been run (resources/daemon/daemon.mjs
// exists), the binaries must be present next to it. Skip when prepare hasn't run yet
// (e.g. fresh checkout before `pnpm build`).
describe('resources/daemon: trash binaries present after prepare (integration)', () => {
  const daemonBundle = path.join(resourcesDaemonDir, 'daemon.mjs');
  const hasBundle = existsSync(daemonBundle);

  it('windows-trash.exe exists next to daemon.mjs', { skip: !hasBundle }, () => {
    assert.ok(
      existsSync(path.join(resourcesDaemonDir, 'windows-trash.exe')),
      'windows-trash.exe must exist in resources/daemon/ after prepare-resources runs'
    );
  });

  it('macos-trash exists next to daemon.mjs', { skip: !hasBundle }, () => {
    assert.ok(
      existsSync(path.join(resourcesDaemonDir, 'macos-trash')),
      'macos-trash must exist in resources/daemon/ after prepare-resources runs (cross-platform packaging)'
    );
  });
});

/**
 * Generic scan: every `new URL('<literal>', import.meta.url)` reference in the
 * bundled daemon.mjs must have its target file present in resources/daemon/.
 *
 * Why: esbuild inlines JS source into daemon.mjs but cannot inline binary
 * files. Any npm dep that locates a sibling file via `import.meta.url` (trash,
 * sharp, esbuild's own binary, etc.) will break in the packaged app unless
 * that file is copied next to daemon.mjs. The trash-specific tests above
 * cover today's known case; this scan catches future regressions for any
 * new dep that slips in.
 *
 * Skips:
 *   - literals with `/` or `\` (URLs / relative paths to subdirs — those need
 *     different handling and would show up as a copy step in prepare-resources)
 *   - literals ending in `.js`/`.mjs`/`.cjs`/`.ts` (inlined source, not a binary)
 *   - literals starting with `node:` (Node.js built-in module specifiers)
 */
describe('bundled daemon.mjs: every import.meta.url binary is packaged', () => {
  const daemonBundle = path.join(resourcesDaemonDir, 'daemon.mjs');
  const hasBundle = existsSync(daemonBundle);

  function findUrlLiterals(src) {
    const out = [];
    const re = /new URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      out.push(m[2]);
    }
    return out;
  }

  function isSkipped(literal) {
    if (literal.startsWith('node:')) return true;
    if (/[\\/]/.test(literal)) return true; // path separator → not a sibling file
    if (/\.(js|mjs|cjs|ts)$/i.test(literal)) return true; // inlined source
    return false;
  }

  it('should have daemon.mjs built (or skip)', { skip: !hasBundle }, () => {
    assert.ok(hasBundle, 'daemon.mjs should exist after prepare-resources');
  });

  it('every non-JS import.meta.url literal has its file in resources/daemon/', { skip: !hasBundle }, () => {
    const src = readFileSync(daemonBundle, 'utf-8');
    const literals = findUrlLiterals(src);
    const binaries = literals.filter((l) => !isSkipped(l));

    assert.ok(binaries.length > 0,
      'expected at least one import.meta.url binary reference (trash uses this pattern); ' +
      'if zero matches, the regex may need updating or trash was refactored');

    const missing = binaries.filter((b) => !existsSync(path.join(resourcesDaemonDir, b)));
    assert.deepEqual(missing, [],
      `daemon.mjs references these sibling files via import.meta.url but they are missing from ${resourcesDaemonDir}:\n` +
      missing.map((b) => `  - ${b}`).join('\n') +
      '\nAdd them to copyTrashBinaries() or a similar copy step in prepare-resources.mjs.');
  });
});
