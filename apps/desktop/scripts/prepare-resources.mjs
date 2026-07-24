/**
 * Prepare resources for electron-builder packaging.
 *
 * 1. Bundle the daemon into a single JS file using esbuild
 *    (better-sqlite3 is external — it's a native module)
 * 2. Copy runtime dependencies to resources/daemon/node_modules/
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
    external: ['better-sqlite3', 'qrcode'],
    // Provide shims so that CJS modules bundled into the ESM output can call
    // require() (for Node.js built-ins) and reference __dirname/__filename.
    // Without __dirname, the Lark SDK's getSdkVersion() throws
    // "ReferenceError: __dirname is not defined in ES module scope" at import
    // time, crashing daemon startup. The SDK is fault-tolerant: when the
    // resolved paths don't point at its own package.json, it falls back to
    // 'unknown' — so pointing __dirname at daemon.mjs's directory is fine.
    banner: {
      js: `import { createRequire as __molioCreateRequire } from 'module'; import { fileURLToPath as __molioFileURLToPath } from 'url'; import { dirname as __molioDirname } from 'path'; const require = __molioCreateRequire(import.meta.url); const __filename = __molioFileURLToPath(import.meta.url); const __dirname = __molioDirname(__filename);`,
    },
    logLevel: 'info',
  });

  console.log('Daemon bundled.');
}

/**
 * Bundle monitoring.js (and its @arms/rum-electron dependency tree) into a
 * single ESM file under src/.
 *
 * Why: electron-builder does not reliably traverse pnpm's .pnpm symlink tree
 * to collect transitive deps like @babel/runtime — at runtime, the SDK's
 * require('@babel/runtime/helpers/interopRequireDefault') fails inside app.asar.
 * Bundling inlines all transitive deps into one file, sidestepping the issue.
 *
 * WASM (minidump processor) is Base64-embedded in the SDK JS, so no separate
 * .wasm files need to be shipped.
 */
async function bundleMonitoring() {
  console.log('Bundling monitoring...');

  const entryPoint = join(desktopDir, 'src', 'monitoring.js');
  const outfile = join(desktopDir, 'src', 'monitoring-bundle.mjs');

  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outfile,
    // Inline @arms/rum-electron and all its transitive deps (@arms/rum-core,
    // @babel/runtime, etc.). Only `electron` stays external — it's provided
    // by the Electron runtime.
    external: ['electron'],
    banner: {
      js: `import { createRequire as __molioCreateRequire } from 'module'; import { fileURLToPath as __molioFileURLToPath } from 'url'; import { dirname as __molioDirname } from 'path'; const require = __molioCreateRequire(import.meta.url); const __filename = __molioFileURLToPath(import.meta.url); const __dirname = __molioDirname(__filename);`,
    },
    logLevel: 'info',
  });

  console.log('Monitoring bundled.');
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

  // qrcode is CommonJS and calls require('fs') inside its PNG renderer.
  // Keep it external so Electron's embedded Node.js loads it as normal CJS
  // instead of letting esbuild inline it into the ESM daemon bundle.
  for (const pkg of ['qrcode', 'dijkstrajs', 'pngjs']) {
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

/**
 * Copy platform-specific binaries used by the `trash` package.
 *
 * esbuild inlines the `trash` JS source into daemon.mjs, but `trash` spawns
 * platform binaries located via `new URL('windows-trash.exe', import.meta.url)`
 * and `new URL('macos-trash', import.meta.url)`. After bundling, `import.meta.url`
 * points at `resources/daemon/daemon.mjs`, so the binaries must sit next to
 * daemon.mjs — otherwise deleting files/folders fails with ENOENT at spawn
 * time and the user sees "删除失败" with no error in the UI.
 *
 * Regression test: apps/desktop/test/trash-binaries.test.js
 * See: https://github.com/zhuzhaoyun/Molio/issues/80
 */
function copyTrashBinaries() {
  console.log('Copying trash platform binaries...');
  const trashSrc = findPackageDir('trash');
  if (!trashSrc) {
    console.warn('  WARNING: trash package not found, deletion will be broken in packaged app');
    return;
  }
  const trashLib = join(trashSrc, 'lib');
  const destDir = join(resourcesDir, 'daemon'); // daemon.mjs lives here; import.meta.url resolves here
  mkdirSync(destDir, { recursive: true });
  for (const bin of ['windows-trash.exe', 'macos-trash']) {
    const src = join(trashLib, bin);
    if (!existsSync(src)) {
      console.warn(`  WARNING: ${bin} not found in trash/lib, skipping`);
      continue;
    }
    cpSync(src, join(destDir, bin), { dereference: true });
    console.log(`  Copied ${bin}`);
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

  // Retry up to 3 times with exponential backoff
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execSync('npx prebuild-install --runtime electron --target ' + electronVersion + ' --arch ' + process.arch, {
        cwd: tempDir,
        stdio: 'pipe',
        encoding: 'utf-8',
        env: {
          ...process.env,
          // Support npm registry mirror via environment variable
          ...(process.env.NPM_REGISTRY ? { npm_config_registry: process.env.NPM_REGISTRY } : {}),
        },
      });
      lastError = null;
      break; // Success
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = attempt * 3000; // 3s, 6s
        console.warn(`  Attempt ${attempt}/${maxRetries} failed, retrying in ${delay/1000}s...`);
        sleepSync(delay);
      }
    }
  }

  if (lastError) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(
      `Failed to download Electron prebuild for better-sqlite3 (after ${maxRetries} retries): ${lastError.stderr || lastError.message}\n` +
      `Tips:\n` +
      `  1. 设置代理再重试: export https_proxy=http://127.0.0.1:7890 && export http_proxy=http://127.0.0.1:7890\n` +
      `  2. 设置 npm 镜像源: export NPM_REGISTRY=https://registry.npmmirror.com\n` +
      `  3. 手动确认 prebuild-install 可用: npx prebuild-install`
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

/**
 * Copy built-in skill source files to resources/daemon/skills/.
 * The daemon's skill-installer reads these at runtime to install skills
 * into each vault's .claude/skills/ directory.
 */
function copySkillSources() {
  console.log('Copying skill sources...');
  const skillsSrc = join(daemonDir, 'src', 'tools', 'skills');
  if (!existsSync(skillsSrc)) {
    console.warn('  WARNING: skills source directory not found, skipping');
    return;
  }
  const skillsDest = join(resourcesDir, 'daemon', 'skills');
  cpSync(skillsSrc, skillsDest, { recursive: true, dereference: true });
  console.log('  Skill sources copied.');
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
await bundleMonitoring();
copyNativeDependencies();
copyTrashBinaries();
downloadElectronPrebuilds();
copyWebBuild();
copySkillSources();

console.log('\nResources prepared successfully!');
