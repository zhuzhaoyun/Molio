/** Consume daemon data frames without retaining a reader past its session. */
export async function consumeSseData(body: ReadableStream<Uint8Array>, signal: AbortSignal, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) { if (buffer.trim()) throw new Error('Incomplete SSE frame'); break; }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        signal.throwIfAborted();
        if (line.startsWith('data: ')) onData(line.slice(6).replace(/\r$/, ''));
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
