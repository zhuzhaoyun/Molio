/**
 * Prepare resources for electron-builder packaging.
 *
 * 1. Bundle the daemon into a single JS file using esbuild
 *    (better-sqlite3 is external — it's a native module)
 * 2. Copy better-sqlite3 + its deps to resources/daemon/node_modules/
 * 3. Copy the web build to resources/web/
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const outfile = join(resourcesDir, 'daemon', 'daemon.js');

  mkdirSync(dirname(outfile), { recursive: true });

  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile,
    external: ['better-sqlite3'],
    banner: {
      js: [
        "import { fileURLToPath as __fts } from 'node:url';",
        "import { dirname as __dn } from 'node:path';",
        'const __filename = __fts(import.meta.url);',
        'const __dirname = __dn(__filename);',
      ].join('\n'),
    },
    logLevel: 'info',
  });

  console.log('Daemon bundled.');
}

function copyNativeDependencies() {
  console.log('Copying native dependencies...');

  const destNodeModules = join(resourcesDir, 'daemon', 'node_modules');
  mkdirSync(destNodeModules, { recursive: true });

  // Copy better-sqlite3 — only essential files (lib + native binary + package.json)
  const sqliteSrc = findPackageDir('better-sqlite3');
  if (sqliteSrc) {
    const sqliteDest = join(destNodeModules, 'better-sqlite3');
    mkdirSync(sqliteDest, { recursive: true });
    cpSync(join(sqliteSrc, 'package.json'), join(sqliteDest, 'package.json'));
    cpSync(join(sqliteSrc, 'lib'), join(sqliteDest, 'lib'), { recursive: true, dereference: true });
    // Copy build/Release (contains the .node binary)
    const buildRelease = join(sqliteSrc, 'build', 'Release');
    if (existsSync(buildRelease)) {
      mkdirSync(join(sqliteDest, 'build', 'Release'), { recursive: true });
      cpSync(buildRelease, join(sqliteDest, 'build', 'Release'), { recursive: true, dereference: true });
    }
    console.log('  Copied better-sqlite3 (essential files only)');
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

function copyWebBuild() {
  console.log('Copying web build...');
  const webDist = join(webDir, 'dist');
  if (!existsSync(webDist)) {
    throw new Error(`Web build not found at ${webDist}. Run 'pnpm --filter @molio/web build' first.`);
  }
  const webResourcesDir = join(resourcesDir, 'web');
  cpSync(webDist, webResourcesDir, { recursive: true, dereference: true });

  // Fix asset paths in index.html for local file serving (remove leading slashes)
  const indexPath = join(webResourcesDir, 'index.html');
  if (existsSync(indexPath)) {
    let html = readFileSync(indexPath, 'utf-8');
    html = html.replace(/src="\/assets\//g, 'src="assets/');
    html = html.replace(/href="\/assets\//g, 'href="assets/');
    writeFileSync(indexPath, html, 'utf-8');
    console.log('  Fixed asset paths in index.html');
  }

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
copyWebBuild();

console.log('\nResources prepared successfully!');
