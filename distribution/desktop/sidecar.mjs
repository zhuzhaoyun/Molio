import { fork } from 'node:child_process';
import { join } from 'node:path';

export async function startSidecar(root, environment, onExit) {
  const child = fork(join(root, 'daemon', 'daemon.mjs'), [], {
    execPath: join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    execArgv: [],
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      ...environment,
      MOLIO_PORT: '0',
      MOLIO_HARNESS_SIDECAR: '1',
      MOLIO_STATIC_DIR: join(root, 'web'),
      MOLIO_AUTH_URL: process.env.MOLIO_AUTH_URL?.trim() || 'https://auth.molio.cn',
    },
  });
  const stop = () => {
    if (child.connected) child.disconnect();
  };
  process.once('exit', stop);
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Molio daemon startup timed out')), 60_000);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        process.removeListener('exit', stop);
        onExit();
        reject(new Error(`Molio daemon exited (${signal ?? code})`));
      });
      child.on('message', msg => {
        if (msg?.type !== 'molio-ready' || !Number.isInteger(msg.port) || msg.port < 1 || msg.port > 65535) return;
        clearTimeout(timer);
        resolve(msg.port);
      });
    });
    return { port, stop };
  } catch (error) {
    child.kill();
    process.removeListener('exit', stop);
    throw error;
  }
}
