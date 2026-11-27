/**
 * Regression test for: `pnpm dev:desktop` fails with
 *   [desktop] [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @molio/desktop dev: `electron .`
 *   Electron failed to install correctly, please delete node_modules/electron ...
 *
 * Root cause: Node.js 24.16.0~24.17.x ships a streams regression
 * (https://github.com/nodejs/node/issues/63487). electron's postinstall
 * unzips the artifact via extract-zip@2 -> yauzl@2 -> fd-slicer@1, whose
 * legacy end-of-stream idiom (`self.destroyed = true; self.push(null)`)
 * deadlocks the new backpressure-resume path on large zip entries.
 * install.js then "succeeds" mid-extraction (silent exit 0) and leaves a
 * truncated dist/ without electron.exe; pnpm's store build cache replays
 * the poisoned result on every later install, skipping install.js entirely.
 *
 * Fix: override yauzl to >=3.3.1 in pnpm-workspace.yaml (3.3.1 rewrote the
 * stream handling), workaround per https://github.com/electron/forge/issues/4277.
 * Upstream Node fix landed in 24.18.0 (revert PR nodejs/node#63834).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(pkgRoot, '../..');
const electronDir = path.join(pkgRoot, 'node_modules', 'electron');

describe('electron binary install guard (Node 24.16~24.17 zip deadlock)', () => {
  it('pnpm-workspace.yaml must override yauzl to >=3.3.1', () => {
    const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf-8');
    const m = yaml.match(/yauzl:\s*['"]?[~^]?(\d+)\.(\d+)\.(\d+)/);
    assert.ok(
      m,
      'overrides.yauzl missing in pnpm-workspace.yaml — electron postinstall ' +
        'deadlocks on Node 24.16.0~24.17.x (nodejs/node#63487)'
    );
    const major = Number(m[1]);
    const minor = Number(m[2]);
    assert.ok(
      major > 3 || (major === 3 && minor >= 3),
      `yauzl override must be >=3.3.1 (found "${m[0]}") — older yauzl ` +
        'deadlocks while extracting the electron zip on Node 24.16~24.17'
    );
  });

  it('electron dist binary exists and is not truncated', () => {
    const pathTxt = path.join(electronDir, 'path.txt');
    if (!existsSync(pathTxt)) {
      // ELECTRON_SKIP_BINARY_DOWNLOAD intentionally skips the download.
      assert.ok(
        process.env.ELECTRON_SKIP_BINARY_DOWNLOAD,
        'node_modules/electron/path.txt missing — electron postinstall never ' +
          'completed. Delete node_modules and re-run `pnpm install`; if on ' +
          'Node 24.16.0~24.17.x upgrade to >=24.18.0 (nodejs/node#63487).'
      );
      return;
    }
    const binaryRel = readFileSync(pathTxt, 'utf-8').trim();
    // electron/index.js resolves the binary as <pkg>/dist/<path.txt>.
    const binaryPath = path.join(electronDir, 'dist', binaryRel);
    assert.ok(
      existsSync(binaryPath),
      `electron binary missing: ${binaryRel}.\n` +
        '  electron postinstall silently extracted a truncated zip (Node ' +
        '24.16~24.17 streams deadlock, nodejs/node#63487) and pnpm cached ' +
        'the broken result.\n' +
        '  Fix: delete all node_modules and re-run `pnpm install` ' +
        '(the yauzl override in pnpm-workspace.yaml repairs extraction);\n' +
        '  long term: upgrade Node.js to >=24.18.0.'
    );
    // Truncation check must target the heavy payload, which differs by
    // platform: on Windows/Linux the path.txt entry IS the monolithic
    // binary (>100MB); on macOS it is a small launcher stub (~30KB) and
    // the engine lives in Electron Framework.framework.
    const heavyRel =
      process.platform === 'darwin'
        ? path.join(
            'Electron.app',
            'Contents',
            'Frameworks',
            'Electron Framework.framework',
            'Versions',
            'A',
            'Electron Framework'
          )
        : binaryRel;
    const heavyPath = path.join(electronDir, 'dist', heavyRel);
    assert.ok(
      existsSync(heavyPath),
      `electron payload missing: ${heavyRel} — truncated extraction, ` +
        'delete node_modules and reinstall (nodejs/node#63487)'
    );
    const size = statSync(heavyPath).size;
    assert.ok(
      size > 1024 * 1024,
      `electron payload ${heavyRel} is only ${size} bytes — truncated ` +
        'extraction, delete node_modules and reinstall (nodejs/node#63487)'
    );
  });
});
