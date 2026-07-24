import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuRawEvent } from './types.js';

/**
 * Thin wrapper around the Lark SDK's `WSClient`. We use the SDK's WebSocket
 * implementation (rather than rolling our own) because it handles the
 * long-connection handshake, ping/pong liveness, auto-reconnect, and the
 * pull-connect-config protocol — re-implementing that would needlessly
 * duplicate SDK work. REST calls still go through our raw-fetch `FeishuApi`
 * (see `client.ts`); only the WS transport uses the SDK.
 */
export interface FeishuWSClientDeps {
  appId: string;
  appSecret: string;
  /** Optional: domain override (`https://open.larksuite.com` for Lark int'l). */
  domain?: string;
  /** Called for each inbound `im.message.receive_v1` event. */
  onMessage: (event: FeishuRawEvent) => void;
  /** Fires once when the first WS handshake succeeds. */
  onReady?: () => void;
  /** Fires on a fatal connect failure (retries exhausted or no-retry mode). */
  onError?: (err: Error) => void;
  /** Fires when the SDK enters the reconnect loop. */
  onReconnecting?: () => void;
  /** Fires after a reconnect succeeds. */
  onReconnected?: () => void;
  /** Logger level — pass `info` for diagnostics in dev. */
  loggerLevel?: Lark.LoggerLevel;
}

export class FeishuWSClient {
  private client: Lark.WSClient | null = null;
  private readonly deps: FeishuWSClientDeps;

  constructor(deps: FeishuWSClientDeps) {
    this.deps = deps;
  }

  /** Whether a WSClient has been constructed and started. */
  isRunning(): boolean {
    return this.client !== null;
  }

  /**
   * Construct the SDK's `WSClient` and wait for the first handshake.
   * Resolves on `onReady`; rejects on `onError`. Safe to call multiple times —
   * a second `start()` after a prior one is a no-op (caller should `stop()`
   * first to re-init).
   */
  async start(): Promise<void> {
    if (this.client) return;

    // SDK's `IConstructorParams` isn't re-exported as a named type; derive it
    // from the WSClient constructor signature so we stay in sync with the SDK.
    type WSClientParams = ConstructorParameters<typeof Lark.WSClient>[0];
    const params: WSClientParams = {
      appId: this.deps.appId,
      appSecret: this.deps.appSecret,
      onReady: () => this.deps.onReady?.(),
      onError: (err) => this.deps.onError?.(err),
      onReconnecting: () => this.deps.onReconnecting?.(),
      onReconnected: () => this.deps.onReconnected?.(),
    };
    if (this.deps.domain) {
      params.domain = this.deps.domain as unknown as Lark.Domain;
    }
    if (this.deps.loggerLevel !== undefined) {
      params.loggerLevel = this.deps.loggerLevel;
    }

    this.client = new Lark.WSClient(params);
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        // SDK gives us a well-typed shape, but we keep the boundary loose and
        // parse defensively in `parseFeishuMessage` — the SDK occasionally
        // forwards extra fields between versions.
        try {
          await this.deps.onMessage(data as unknown as FeishuRawEvent);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[feishu-ws] onMessage handler threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    });
    try {
      await this.client.start({ eventDispatcher: dispatcher });
    } catch (err) {
      // Clear `this.client` so a subsequent start() can re-attempt — otherwise
      // the `if (this.client) return` guard at the top would no-op forever.
      this.client = null;
      throw err;
    }
  }

  /** Tear down the WS connection. Safe to call when not started. */
  async stop(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    try {
      // The SDK's close() may be async underneath; await so a follow-up
      // start() doesn't race against the old connection's teardown.
      await Promise.resolve(client.close({ force: true }));
    } catch {
      // Swallow — we're tearing down anyway; the SDK sometimes throws on
      // double-close during process shutdown.
    }
  }
}
