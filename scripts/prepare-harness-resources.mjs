import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = join(root, '.harness-build/host/apps/desktop');
const daemon = join(root, 'apps/daemon');
const require = createRequire(join(daemon, 'package.json'));
const sql = require.resolve('better-sqlite3/package.json');
new (require('better-sqlite3'))(':memory:').close(); // Check the ABI of the actual bundled interpreter.
await mkdir(desktop, { recursive: true });
const stage = await mkdtemp(join(desktop, 'molio-stage-'));
const service = join(stage, 'daemon');
const banner = "import { createRequire as makeMolioRequire } from 'node:module'; const require = makeMolioRequire(import.meta.url);";
const copy = (src, dest) => cp(src, dest, { recursive: true, dereference: true });
try {
  await build({
    entryPoints: { daemon: join(daemon, 'src/harness-sidecar.ts'), 'vault-worker-entry': join(daemon, 'src/core/vault-worker-entry.ts') },
    bundle: true, platform: 'node', target: 'node24', format: 'esm', outdir: service,
    inject: [join(root, 'scripts/harness-node-globals.mjs')],
    define: { 'process.env.MOLIO_HARNESS_SIDECAR': JSON.stringify('1') },
    outExtension: { '.js': '.mjs' }, external: ['better-sqlite3'], banner: { js: banner },
  });
  const modules = join(service, 'node_modules');
  for (const file of ['lib', 'package.json', 'build/Release/better_sqlite3.node']) {
    await copy(join(dirname(sql), file), join(modules, 'better-sqlite3', file));
  }
  const bindings = createRequire(sql).resolve('bindings/package.json');
  for (const manifest of [bindings, createRequire(bindings).resolve('file-uri-to-path/package.json')]) {
    await copy(dirname(manifest), join(modules, require(manifest).name));
  }
  const trash = dirname(require.resolve('trash'));
  const binary = process.platform === 'win32' ? 'windows-trash.exe' : 'macos-trash';
  if (process.platform !== 'linux') await copy(join(trash, 'lib', binary), join(service, binary));
  for (const name of ['skills', 'sample-vault']) await copy(join(daemon, 'src/tools', name), join(service, name));
  await copy(join(root, 'apps/web/dist'), join(stage, 'web'));
  await copy(process.execPath, join(stage, process.platform === 'win32' ? 'node.exe' : 'node'));
  const output = join(desktop, 'molio-plugin-resources');
  const previous = stage + '-previous';
  try { await rename(output, previous); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(stage, output); }
  catch (error) {
    await rename(previous, output).catch(restore => { if (restore.code !== 'ENOENT') throw restore; });
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
} finally {
  await rm(stage, { recursive: true, force: true });
}
