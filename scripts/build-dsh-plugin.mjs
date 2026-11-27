import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = join(root, 'packages/dsh-plugin-molio');
const dist = join(pkg, 'dist');
const daemon = join(root, 'apps/daemon');
const web = join(root, 'apps/web');
const requireWeb = createRequire(join(web, 'package.json'));
await mkdir(dist, { recursive: true });
const vite = join(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
const result = spawnSync(process.execPath, [vite, 'build', '--outDir', join(dist, 'web'), '--emptyOutDir'], {
  cwd: web, stdio: 'inherit', env: { ...process.env, VITE_MOLIO_HARNESS: '1' },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await build({
  entryPoints: { daemon: join(daemon, 'src/harness-sidecar.ts'), 'vault-worker-entry': join(daemon, 'src/core/vault-worker-entry.ts') },
  bundle: true, platform: 'node', target: 'node24', format: 'esm', outdir: join(dist, 'service'),
  inject: [join(root, 'scripts/harness-node-globals.mjs')],
  alias: { 'better-sqlite3': join(pkg, 'runtime/sqlite.mjs') }, external: ['trash'], outExtension: { '.js': '.mjs' },
  banner: { js: "import { createRequire as makeMolioRequire } from 'node:module'; const require = makeMolioRequire(import.meta.url);" },
});
for (const name of ['skills', 'sample-vault']) {
  await cp(join(daemon, 'src/tools', name), join(dist, 'service', name), { recursive: true });
}
// Bundle the pinned SDK's schema helpers. Installing a second DSH tools service
// in the user's profile would override the tools service supplied by their host.
const requirePlugin = createRequire(join(pkg, 'package.json'));
function sdkFile(name, path) {
  return join(dirname(requirePlugin.resolve(name + '/package.json')), path);
}
await build({
  entryPoints: [join(pkg, 'src/index.ts')], outfile: join(dist, 'host/index.mjs'),
  platform: 'node', format: 'esm', bundle: true, target: 'node24',
  alias: {
    '@deepseek-ai/dsh-tools': sdkFile('@deepseek-ai/dsh-tools', 'lib/types/schema.js'),
    '@deepseek-ai/dsh-llm': sdkFile('@deepseek-ai/dsh-llm', 'lib/types/error.js'),
  },
});
// DSH loads browser faces using its module loader and supplies its own React instance.
await build({
  entryPoints: [join(pkg, 'client/index.jsx')], outfile: join(dist, 'client.js'), bundle: true,
  platform: 'browser', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: { js: "window.__ModuleLoader__.load({id:'dsh-plugin-molio',factory:require=>{const module={exports:{}};const exports=module.exports;" },
  footer: { js: 'return module.exports;}});' },
});
