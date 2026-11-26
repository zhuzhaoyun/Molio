export interface SessionResources {
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly closed: boolean;
  track(dispose: () => void): () => void;
  close(): void;
}

export function createSessionResources(epoch: number): SessionResources {
  const abort = new AbortController(); const producers = new Set<() => void>();
  let closed = false;
  return {
    epoch, signal: abort.signal, get closed() { return closed; },
    track(dispose) {
      if (closed) { dispose(); return () => {}; }
      producers.add(dispose); return () => { producers.delete(dispose); };
    },
    close() {
      if (closed) return;
      closed = true; abort.abort();
      for (const dispose of producers) { try { dispose(); } catch { /* clean remaining producers */ } }
      producers.clear();
    },
  };
}
