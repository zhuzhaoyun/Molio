/**
 * Prepare resources for electron-builder packaging.
 *
 * 1. Bundle the daemon into a single JS file using esbuild
 *    (better-sqlite3 is external — it's a native module)
 * 2. Copy better-sqlite3 + its deps to resources/daemon/node_modules/
 * 3. Download Electron prebuilt binary for better-sqlite3 (no C++ build tools needed)
 * 4. Copy the web build to resources/web/
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, '..');
const resourcesDir = join(desktopDir, 'resources');
const monorepoRoot = resolve(desktopDir, '..', '..');

// Paths
const daemonDir = resolve(desktopDir, '..', 'daemon');
const webDir = resolve(desktopDir, '..', 'web');

/** Find a package's actual directory in pnpm's node_modules */
function findPackageDir(pkgName) {
  // Check pnpm store (.pnpm directory)
  const pnpmDir = join(monorepoRoot, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    const entries = readdirSync(pnpmDir);
    for (const entry of entries) {
      const candidate = join(pnpmDir, entry, 'node_modules', pkgName);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Fallback: check hoisted node_modules
  const hoisted = join(monorepoRoot, 'node_modules', pkgName);
  if (existsSync(hoisted)) return hoisted;
  return null;
}

async function bundleDaemon() {
  console.log('Bundling daemon...');

  const entryPoint = join(daemonDir, 'dist', 'src', 'index.js');
  // Use .mjs extension so Node.js (via ELECTRON_RUN_AS_NODE) parses it as ESM.
  // A plain .js file without a package.json { "type": "module" } is treated as CJS,
  // causing SyntaxError on `import` statements.
  const outfile = join(resourcesDir, 'daemon', 'daemon.mjs');

  mkdirSync(dirname(outfile), { recursive: true });

  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outfile,
    external: ['better-sqlite3'],
    // No banner needed — Node 24+ supports import.meta.dirname/filename natively
    logLevel: 'info',
  });

  console.log('Daemon bundled.');
}

function copyNativeDependencies() {
  console.log('Copying native dependencies...');

  const destNodeModules = join(resourcesDir, 'daemon', 'node_modules');
  mkdirSync(destNodeModules, { recursive: true });

  // Copy better-sqlite3 — only runtime files (lib + package.json).
  // The native .node binary will be downloaded separately via prebuild-install
  // targeting Electron's ABI (no Visual Studio needed).
  const sqliteSrc = findPackageDir('better-sqlite3');
  if (sqliteSrc) {
    const sqliteDest = join(destNodeModules, 'better-sqlite3');
    mkdirSync(sqliteDest, { recursive: true });
    cpSync(join(sqliteSrc, 'package.json'), join(sqliteDest, 'package.json'));
    cpSync(join(sqliteSrc, 'lib'), join(sqliteDest, 'lib'), { recursive: true, dereference: true });
    console.log('  Copied better-sqlite3 (runtime files)');
  } else {
    console.warn('  WARNING: better-sqlite3 not found');
  }

  // Copy bindings + file-uri-to-path (dependencies of better-sqlite3)
  for (const pkg of ['bindings', 'file-uri-to-path']) {
    const src = findPackageDir(pkg);
    if (!src) {
      console.warn(`  WARNING: ${pkg} not found, skipping`);
      continue;
    }
    const dest = join(destNodeModules, pkg);
    cpSync(src, dest, { recursive: true, dereference: true });
    console.log(`  Copied ${pkg}`);
  }
}

function downloadElectronPrebuilds() {
  console.log('Downloading Electron prebuilt native modules...');

  const require = createRequire(import.meta.url);
  const electronPkg = require('electron/package.json');
  const electronVersion = electronPkg.version;
  const sqliteSrc = findPackageDir('better-sqlite3');
  if (!sqliteSrc) {
    throw new Error('better-sqlite3 not found in node_modules');
  }

  const sqliteDest = join(resourcesDir, 'daemon', 'node_modules', 'better-sqlite3');

  // Download Electron prebuild to a TEMP directory to avoid overwriting the
  // Node.js .node binary in the shared pnpm store. Previously, running
  // prebuild-install in the pnpm store directory replaced the Node.js ABI
  // binary with the Electron ABI binary, breaking daemon dev mode.
  const tempDir = mkdtempSync(join(tmpdir(), 'molio-electron-prebuild-'));
  const tempBuildRelease = join(tempDir, 'build', 'Release');
  mkdirSync(tempBuildRelease, { recursive: true });

  // Copy package.json so prebuild-install can determine the module version
  cpSync(join(sqliteSrc, 'package.json'), join(tempDir, 'package.json'));

  try {
    execSync('npx prebuild-install --runtime electron --target ' + electronVersion + ' --arch ' + process.arch, {
      cwd: tempDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(
      `Failed to download Electron prebuild for better-sqlite3: ${err.stderr || err.message}\n` +
      `Ensure prebuild-install is available (npx prebuild-install).`
    );
  }

  // Copy the downloaded .node binary to the daemon resources
  const srcNode = join(tempBuildRelease, 'better_sqlite3.node');
  const destNode = join(sqliteDest, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(srcNode)) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`prebuild-install did not produce better_sqlite3.node at ${srcNode}`);
  }
  mkdirSync(dirname(destNode), { recursive: true });
  cpSync(srcNode, destNode);

  // Clean up temp directory
  rmSync(tempDir, { recursive: true, force: true });

  const stat = require('fs').statSync(destNode);
  console.log(`  ✅ Downloaded Electron prebuild for better-sqlite3 (Electron v${electronVersion}, ${(stat.size / 1024).toFixed(0)}KB)`);
}

function copyWebBuild() {
  console.log('Copying web build...');
  const webDist = join(webDir, 'dist');
  if (!existsSync(webDist)) {
    throw new Error(`Web build not found at ${webDist}. Run 'pnpm --filter @molio/web build' first.`);
  }
  const webResourcesDir = join(resourcesDir, 'web');
  cpSync(webDist, webResourcesDir, { recursive: true, dereference: true });

  // Asset paths in index.html use absolute paths (/assets/...) which the daemon
  // serves correctly from root, so no path rewriting is needed.

  console.log('Web build copied.');
}

// ─── Main ───

// Graceful skip: if daemon/web haven't been built yet (e.g. during `pnpm install`
// before `pnpm build`), exit cleanly. The build script will call this again.
const daemonDist = join(daemonDir, 'dist', 'src', 'index.js');
const webDistCheck = join(webDir, 'dist');
if (!existsSync(daemonDist) || !existsSync(webDistCheck)) {
  console.log('Skipping prepare: daemon or web not yet built. Will run during build step.');
  process.exit(0);
}

if (existsSync(resourcesDir)) {
  rmSync(resourcesDir, { recursive: true });
}
mkdirSync(resourcesDir, { recursive: true });

await bundleDaemon();
copyNativeDependencies();
downloadElectronPrebuilds();
copyWebBuild();

console.log('\nResources prepared successfully!');
