import os from 'node:os';
import path from 'node:path';

/** Application-owned data; an explicit directory also isolates test instances. */
export function molioDataDir(): string {
  const override = process.env['MOLIO_DATA_DIR']?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.molio');
}

/** Provider settings overrides are separate from application data. */
export function runtimeHome(runtime: 'claude' | 'codex'): string {
  const override = process.env[`MOLIO_${runtime.toUpperCase()}_HOME`]?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), `.${runtime}`);
}
