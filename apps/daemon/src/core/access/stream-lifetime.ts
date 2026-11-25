import type { AdminSession, SessionStore } from './sessions.js';

/** Close a streaming response when its specific administrator session ends. */
export function wrapSessionStream(
  response: Response,
  session: AdminSession,
  store: SessionStore,
  isValid: () => boolean,
  signal?: AbortSignal,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  let output: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
    signal?.removeEventListener('abort', stop);
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    cleanup();
    try { output.close(); } catch { /* already cancelled */ }
    void reader.cancel().catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      unsubscribe = store.subscribeRevocation((digest) => { if (digest === session.digest) stop(); });
      signal?.addEventListener('abort', stop, { once: true });
      const remaining = session.expiresAt - Date.now();
      if (remaining <= 0 || signal?.aborted || !isValid()) { stop(); return; }
      timer = setTimeout(stop, remaining);
      timer.unref?.();
    },
    async pull(controller) {
      if (closed) return;
      try {
        const result = await reader.read();
        if (closed) return;
        if (result.done) { closed = true; cleanup(); controller.close(); }
        else controller.enqueue(result.value);
      } catch (error) {
        if (!closed) { closed = true; cleanup(); controller.error(error); }
      }
    },
    cancel() { stop(); },
  }, { highWaterMark: 0 });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
