import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Global setup: locate the Electron executable.
 *
 * Resolution priority:
 *   1. MOLIO_EXE_PATH env var (explicit override for CI / installed app)
 *   2. apps/desktop/dist/win-unpacked/Molio.exe (local build)
 *   3. ~/AppData/Local/Programs/Molio/Molio.exe (NSIS installed)
 *
 * Stores the resolved path in process.env for all test workers.
 */
export default async function globalSetup() {
  if (platform() !== 'win32') {
    console.warn('[e2e] GUI E2E tests are currently only supported on Windows.');
    console.warn('[e2e] Skipping executable resolution.');
    return;
  }

  const candidates: string[] = [];

  // 1. Explicit env var
  if (process.env.MOLIO_EXE_PATH) {
    candidates.push(process.env.MOLIO_EXE_PATH);
  }

  // 2. Unpacked build (most common for local dev)
  const projectRoot = join(__dirname, '..');
  candidates.push(join(projectRoot, 'dist', 'win-unpacked', 'Molio.exe'));

  // 3. NSIS installed location
  candidates.push(join(homedir(), 'AppData', 'Local', 'Programs', 'Molio', 'Molio.exe'));

  let resolved: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      resolved = candidate;
      break;
    }
  }

  if (!resolved) {
    throw new Error(
      `[e2e] Could not find Molio.exe. Searched:\n` +
        candidates.map((c) => `  - ${c}`).join('\n') +
        `\n\nBuild it first:\n` +
        `  pnpm build\n` +
        `  cd apps/desktop && npx electron-builder --win --dir`,
    );
  }

  console.log(`[e2e] Using executable: ${resolved}`);
  process.env.MOLIO_EXE_PATH = resolved;
}
