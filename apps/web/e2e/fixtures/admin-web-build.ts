import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// One fresh build per Playwright invocation, before browser workers exist.
// Only this invocation's environment carries its output path; no stale dist reuse.
export default async function setup() {
  const root = resolve(import.meta.dirname, '../../../..');
  const require = createRequire(join(root, 'apps/web/package.json'));
  const cli = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const dir = mkdtempSync(join(tmpdir(), 'molio-admin-build-'));
  try {
    console.log('Building current administrator Web assets before browser workers');
    await promisify(execFile)(process.execPath, [cli, 'build', '--outDir', join(dir, 'web'), '--emptyOutDir'], {
      cwd: join(root, 'apps/web'), timeout: 300000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=768` },
    });
    process.env.MOLIO_ADMIN_WEB_BUILD = join(dir, 'web');
    return () => rmSync(dir, { recursive: true, force: true });
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}
