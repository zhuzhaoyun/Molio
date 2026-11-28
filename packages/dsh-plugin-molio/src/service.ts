import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultBaseUrl } from './daemon-client.js';

/** One owned service per plugin instance, started on first use and stopped at disposal. */
export function createService() {
  let child: ChildProcess | undefined;
  let pending: Promise<string> | undefined;
  let disposed = false;
  function endpoint(): Promise<string> {
    if (disposed) return Promise.reject(new Error('Molio 插件已停用'));
    if (process.env.MOLIO_DAEMON_URL || process.env.MOLIO_PORT) return Promise.resolve(defaultBaseUrl());
    if (pending) return pending;
    const web = fileURLToPath(new URL('../web/', import.meta.url));
    const proc = fork(fileURLToPath(new URL('../service/daemon.mjs', import.meta.url)), [], {
      execArgv: [], env: { ...process.env, MOLIO_STATIC_DIR: web, MOLIO_HARNESS_SIDECAR: '1' },
    });
    child = proc;
    pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Molio 服务启动超时')); proc.kill(); }, 60000);
      proc.once('error', error => { clearTimeout(timer); reject(error); });
      proc.once('close', () => {
        clearTimeout(timer);
        if (child === proc) { child = undefined; pending = undefined; }
        reject(new Error('Molio 服务已退出'));
      });
      proc.on('message', message => {
        const msg = message as { type?: string; port?: number };
        if (msg?.type === 'molio-ready' && Number.isInteger(msg.port) && msg.port! > 0 && msg.port! <= 65535) {
          clearTimeout(timer);
          resolve('http://127.0.0.1:' + msg.port);
        }
      });
    });
    return pending;
  }
  return { endpoint, stop() { disposed = true; if (child?.connected) child.disconnect(); } };
}
