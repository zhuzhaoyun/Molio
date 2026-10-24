/**
 * Idle-fallback error copy — split by what the SSE connection tells us.
 *
 * The 10-min idle fallback (useChatCore FALLBACK_IDLE_MS) used to always say
 * 「响应超时，请重试或检查 daemon 是否运行」. The 2026-10-22 wiki-ingest incident
 * showed why that misleads: the daemon was perfectly healthy (its 15s keepalive
 * pings kept flowing) — the AGENT CHILD was hung on a dead provider request,
 * producing zero events. Telling the user to "check the daemon" sends them
 * debugging the wrong process.
 *
 * Discriminator: keepalive ping recency. The daemon pings every 15s while a
 * client is subscribed, so a ping within the last 3 intervals proves the
 * daemon side is alive and the silence is upstream of it (model/provider).
 */

/** 3× the daemon's 15s SSE keepalive interval — same budget as the watchdog. */
export const DAEMON_PING_LIVENESS_MS = 45_000;

/**
 * Build the idle-fallback error message.
 * @param lastKeepaliveAt timestamp of the most recent SSE ping frame on the
 *   CURRENT connection (null = none received since subscribe).
 * @param now injectable clock for tests.
 */
export function buildIdleFallbackMessage(
  lastKeepaliveAt: number | null,
  now: number = Date.now(),
): string {
  const daemonAlive =
    lastKeepaliveAt !== null && now - lastKeepaliveAt < DAEMON_PING_LIVENESS_MS;
  return daemonAlive
    ? '模型长时间无响应（daemon 连接正常，run 可能已挂起）——请取消后重试，或更换模型'
    : '响应超时，请重试或检查 daemon 是否运行';
}
