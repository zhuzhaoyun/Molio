import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTools } from './harness-tools.mjs';
import { applyBrand } from './harness-brand.mjs';
import { applyPackaging } from './harness-package.mjs';
import { applyDesktop } from './harness-desktop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = join(root, '.harness-build');
const host = join(stage, 'host');
const upstream = join(root, 'vendor/deepseek-harness');
const env = { ...process.env, VITE_MOLIO_HARNESS: '1', DSH_CLIENT_TITLE: 'Molio',
  DSH_DESKTOP_APP_ID: 'com.molio.harness' };

function run(binary, args, cwd = root, capture = false) {
  const result = spawnSync(binary, args, { cwd, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8',
    shell: binary === 'corepack' && process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} ${args.join(' ')} failed: ${result.stderr ?? result.status}`);
  return result.stdout?.trim();
}

function pnpm(args, cwd) {
  run('corepack', ['pnpm', ...args], cwd);
}

if (!process.env.npm_execpath) throw new Error('Run pnpm build:harness');
const pinned = run('git', ['rev-parse', ':vendor/deepseek-harness'], root, true);
if (run('git', ['rev-parse', 'HEAD'], upstream, true) !== pinned)
  throw new Error('Initialize the pinned host with git submodule update --init');
mkdirSync(stage, { recursive: true });
if (existsSync(host) && run('git', ['rev-parse', 'HEAD'], host, true) !== pinned)
  renameSync(host, join(stage, `host-before-${Date.now()}`));
if (!existsSync(host)) {
  run('git', ['clone', '--local', '--no-checkout', upstream, host]);
  run('git', ['checkout', '--detach', pinned], host);
}
pnpm(['--filter', '@molio/contracts', 'build:fresh'], root);
pnpm(['--filter', '@molio/daemon', 'build'], root);
pnpm(['--filter', '@molio/web', 'build'], root);
run(process.execPath, ['apps/desktop/scripts/prepare-resources.mjs', '--harness']);
await applyBrand(host);
applyDesktop(host);

await applyTools(host);
await applyPackaging(host);

pnpm(['install', '--frozen-lockfile'], host);
if (process.argv.includes('--app')) {
  pnpm(['run', 'build:artifacts'], host);
} else {
  const target = process.platform === 'win32' ? 'win-x64' : `mac-${process.arch}`;
  pnpm(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'package', target, '--unsigned'], host);
}
