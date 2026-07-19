import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '..', '..', '..');
const daemonSrcSkills = path.join(monorepoRoot, 'apps/daemon/src/tools/skills');
const resourcesDaemonDir = path.resolve(__dirname, '../resources/daemon');

describe('prepare-resources.mjs: copy wiki-build scripts', () => {
  it('should recursively copy skill sources via cpSync', () => {
    const prepareResourcesPath = path.resolve(__dirname, '../scripts/prepare-resources.mjs');
    const prepareResourcesJs = readFileSync(prepareResourcesPath, 'utf-8');
    // Verify cpSync is used with recursive: true for skills directory
    assert.ok(
      prepareResourcesJs.includes('cpSync(skillsSrc, skillsDest, { recursive: true'),
      'prepare-resources.mjs must use cpSync with recursive: true to copy all skill files including nested lib/ directories'
    );
  });

  it('all wiki-build scripts and lib modules exist in daemon source', () => {
    const wikiBuildScripts = path.join(daemonSrcSkills, 'wiki-build/scripts');
    const requiredFiles = [
      'wiki-build.mjs',
      'lib/contracts.mjs',
      'lib/workspace.mjs',
      'lib/inventory.mjs',
      'lib/plan.mjs',
      'lib/preprocess.mjs',
      'lib/state.mjs',
      'lib/indexes.mjs',
    ];
    for (const file of requiredFiles) {
      assert.ok(
        existsSync(path.join(wikiBuildScripts, file)),
        `wiki-build script ${file} must exist in daemon source`
      );
    }
  });

  it('skill-installer uses recursive copyDirSync for skills', () => {
    const skillInstallerPath = path.join(monorepoRoot, 'apps/daemon/src/core/skill-installer.ts');
    const skillInstallerJs = readFileSync(skillInstallerPath, 'utf-8');
    // copyDirSync must do recursive copy (mkdirSync + readdirSync loop)
    assert.ok(
      skillInstallerJs.includes('function copyDirSync') &&
      skillInstallerJs.includes('readdirSync') &&
      skillInstallerJs.includes('isDirectory()'),
      'skill-installer.ts copyDirSync must recursively copy directories'
    );
  });
});

// Integration check: if prepare-resources has actually been run, wiki-build scripts must be present
describe('resources/daemon: wiki-build scripts present after prepare (integration)', () => {
  const daemonBundle = path.join(resourcesDaemonDir, 'daemon.mjs');
  const hasBundle = existsSync(daemonBundle);

  it('wiki-build.mjs exists in resources/daemon/skills/', { skip: !hasBundle }, () => {
    assert.ok(
      existsSync(path.join(resourcesDaemonDir, 'skills/wiki-build/scripts/wiki-build.mjs')),
      'wiki-build.mjs must exist in resources/daemon/skills/ after prepare-resources runs'
    );
  });

  it('all lib modules exist in resources/daemon/skills/wiki-build/', { skip: !hasBundle }, () => {
    const libDir = path.join(resourcesDaemonDir, 'skills/wiki-build/scripts/lib');
    const requiredModules = [
      'contracts.mjs', 'workspace.mjs', 'inventory.mjs', 'plan.mjs',
      'preprocess.mjs', 'state.mjs', 'indexes.mjs'
    ];
    for (const mod of requiredModules) {
      assert.ok(
        existsSync(path.join(libDir, mod)),
        `${mod} must exist in resources/daemon/skills/wiki-build/scripts/lib/`
      );
    }
  });
});
