import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared channel-status polling + action wrapper. Replaces the duplicated
 * status/busy/error useEffect boilerplate that FeishuChannelPanel and
 * WeixinChannelPanel each carried (~50 lines each).
 *
 * Caller passes a `fetchStatus` closure (e.g. `() => api.getFeishuStatus()`).
 * The hook polls every `intervalMs` (default 2s) and surfaces a `runAction`
 * that flips `busy`, runs the action, sets status from the action's return
 * value, and surfaces errors via `error`.
 */
export function useChannelStatus<Status>(
  fetchStatus: () => Promise<Status>,
  intervalMs = 2_000,
): {
  status: Status | null;
  busy: boolean;
  error: string | null;
  runAction: (fn: () => Promise<Status>) => Promise<void>;
} {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hold the latest fetchStatus in a ref so the polling effect doesn't
  // re-subscribe on every render (the closure identity changes each render
  // but the underlying api method is stable).
  const fetchStatusRef = useRef(fetchStatus);
  fetchStatusRef.current = fetchStatus;

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const next = await fetchStatusRef.current();
        if (!stopped) setStatus(next);
      } catch {
        // keep previous status visible
      }
    };
    void tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  const runAction = useCallback(async (fn: () => Promise<Status>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, runAction };
}
