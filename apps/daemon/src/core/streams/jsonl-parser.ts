import type { StreamHandler } from '@kge/contracts';

export function createJsonlParser(
  handleLine: (line: string) => void,
): StreamHandler {
  let buffer = '';

  function feed(chunk: string | Buffer): void {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      handleLine(line);
    }
  }

  function flush(): void {
    const rem = buffer.trim();
    buffer = '';
    if (rem) handleLine(rem);
  }

  return { feed, flush };
}
