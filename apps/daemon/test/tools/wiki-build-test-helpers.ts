import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const daemonRoot = resolve(import.meta.dirname, '..', '..', '..');
const cli = join(
  daemonRoot,
  'src',
  'tools',
  'skills',
  'wiki-build',
  'scripts',
  'wiki-build.mjs',
);

export function makeVault() {
  const path = mkdtempSync(join(tmpdir(), 'molio-wiki-build-'));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function runWikiBuildCli(vaultPath: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, '--vault', vaultPath], {
    cwd: vaultPath,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}
