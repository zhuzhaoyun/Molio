/**
 * Decide whether a process holding Molio's daemon port is safe to auto-kill
 * on startup.
 *
 * The daemon itself is spawned in one of these forms:
 *   - `node` / `tsx` (dev mode, `pnpm dev:daemon`)
 *   - the packaged Electron binary `Molio.exe` (production) or `electron.exe`
 *     (dev desktop), run with `ELECTRON_RUN_AS_NODE=1`
 *
 * A stale instance of any of these on port 3100 is almost certainly a previous
 * daemon that did not exit cleanly, so we kill it. Any other process name is
 * left alone — the user must resolve it manually to avoid killing unrelated
 * software.
 *
 * Extracted as a shared helper so `index.ts` and the port-check test reference
 * the exact same rule (prevents logic drift).
 *
 * @param processName — raw `tasklist` / `ps` output line for the occupying PID
 */
export function isKillablePortOccupant(processName: string): boolean {
  const n = processName.toLowerCase();
  return (
    n.includes('node') ||
    n.includes('tsx') ||
    n.includes('molio') || // packaged daemon: Molio.exe
    n.includes('electron') // dev desktop / unpacked: electron.exe
  );
}
