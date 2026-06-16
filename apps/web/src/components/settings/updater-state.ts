/**
 * Pure state-machine transitions for the auto-updater UI.
 *
 * Extracted so the rules can be unit-tested without React or Electron.
 */

export type CheckResult =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date'; currentVersion: string }
  | { status: 'available'; currentVersion: string; latestVersion: string; downloading: boolean; percent: number }
  | { status: 'downloaded'; currentVersion: string; latestVersion: string }
  | { status: 'installing'; currentVersion: string; latestVersion: string }
  | { status: 'error'; message: string };

// ── Event payloads ──────────────────────────────────────────────
export interface UpdateAvailableInfo { version: string }
export interface DownloadProgressInfo { percent: number }
export interface UpdateDownloadedInfo { version: string }
export interface UpdateErrorInfo { message: string }
export interface CheckResponse {
  ok: boolean;
  status?: string;
  currentVersion?: string;
  latestVersion?: string;
  available?: boolean;
  downloading?: boolean;
  downloaded?: boolean;
  percent?: number;
  message?: string | null;
  error?: string;
}

// ── Transitions ─────────────────────────────────────────────────

/** Handle `update-available` event from electron-updater. */
export function onUpdateAvailable(prev: CheckResult, info: UpdateAvailableInfo, currentVersion: string): CheckResult {
  // Don't leave 'downloaded' state — the update is already ready
  if (prev.status === 'downloaded') return prev;

  // If already downloading this version, keep current progress
  if (prev.status === 'available' && prev.downloading) {
    if (prev.latestVersion === info.version) return prev;
    // Newer version appeared mid-download — restart for it
    return { ...prev, latestVersion: info.version, percent: 0 };
  }

  // Transition from idle / checking / error into downloading
  if (prev.status === 'checking' || prev.status === 'idle' || prev.status === 'error') {
    return {
      status: 'available',
      currentVersion,
      latestVersion: info.version,
      downloading: true,
      percent: 0,
    };
  }

  return prev;
}

/** Handle `download-progress` event from electron-updater. */
export function onDownloadProgress(prev: CheckResult, info: DownloadProgressInfo): CheckResult {
  if (prev.status === 'available' && prev.downloading) {
    // Never decrease percent — progress should only go forward
    if (info.percent > prev.percent) {
      return { ...prev, percent: info.percent };
    }
  }
  return prev;
}

/** Handle `update-downloaded` event from electron-updater. */
export function onUpdateDownloaded(prev: CheckResult, info: UpdateDownloadedInfo, currentVersion: string): CheckResult {
  return {
    status: 'downloaded',
    currentVersion,
    latestVersion: info.version,
  };
}

/** Convert the main-process updater snapshot into UI state. */
export function fromUpdaterState(state: CheckResponse): CheckResult {
  if (!state.ok) {
    return { status: 'error', message: state.error ?? 'Unknown error' };
  }

  const currentVersion = state.currentVersion ?? 'dev';
  const latestVersion = state.latestVersion ?? currentVersion;

  switch (state.status) {
    case 'checking':
      return { status: 'checking' };
    case 'up-to-date':
      return { status: 'up-to-date', currentVersion };
    case 'available':
    case 'downloading':
      return {
        status: 'available',
        currentVersion,
        latestVersion,
        downloading: state.downloading ?? true,
        percent: state.percent ?? 0,
      };
    case 'downloaded':
      return { status: 'downloaded', currentVersion, latestVersion };
    case 'installing':
      return { status: 'installing', currentVersion, latestVersion };
    case 'error':
      return { status: 'error', message: state.message ?? state.error ?? 'Unknown error' };
    case 'idle':
    default:
      if (state.downloaded) {
        return { status: 'downloaded', currentVersion, latestVersion };
      }
      if (state.available) {
        return {
          status: 'available',
          currentVersion,
          latestVersion,
          downloading: state.downloading ?? false,
          percent: state.percent ?? 0,
        };
      }
      return { status: 'idle' };
  }
}

/** Handle `error` event from electron-updater. */
export function onUpdateError(_prev: CheckResult, info: UpdateErrorInfo): CheckResult {
  return { status: 'error', message: info.message };
}

/** Handle IPC response from `updater:check`. */
export function onCheckResult(prev: CheckResult, res: CheckResponse): CheckResult {
  if (res.status) {
    return fromUpdaterState(res);
  }
  if (!res.ok) {
    return { status: 'error', message: res.error ?? 'Unknown error' };
  }
  if (!res.available) {
    return { status: 'up-to-date', currentVersion: res.currentVersion ?? 'dev' };
  }
  if (res.downloaded) {
    return {
      status: 'downloaded',
      currentVersion: res.currentVersion ?? 'dev',
      latestVersion: res.latestVersion ?? res.currentVersion ?? 'dev',
    };
  }
  // Available but not yet downloaded — let background events update state
  return prev;
}
