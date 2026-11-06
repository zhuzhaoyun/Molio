/** 测试共享工具：fake daemon harness + stdout/stderr 捕获。 */
import { DaemonClient } from '../src/daemon-client.js';
import { FakeDaemon } from './fake-daemon.js';

export interface Harness {
  daemon: FakeDaemon;
  client: DaemonClient;
  baseUrl: string;
  /** after() 里调用：关 daemon + 清环境变量 */
  teardown: () => Promise<void>;
}

/**
 * 启动假 daemon 并把 MOLIO_DAEMON_URL 指向它 —— runCli 内部
 * `new DaemonClient()` 走 defaultBaseUrl()，靠环境变量注入测试地址。
 */
export async function startHarness(): Promise<Harness> {
  const daemon = new FakeDaemon();
  const baseUrl = await daemon.start();
  process.env['MOLIO_DAEMON_URL'] = baseUrl;
  return {
    daemon,
    client: new DaemonClient(baseUrl),
    baseUrl,
    teardown: async () => {
      delete process.env['MOLIO_DAEMON_URL'];
      await daemon.stop();
    },
  };
}

export interface CapturedRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 捕获 fn 执行期间的 stdout/stderr — 替换 output.ts 的 sinks（而非 patch
 * process.stdout.write：node:test 报告器也写 process.stdout，会把测试事件
 * 噪音灌进捕获内容，2026-10 实测踩坑）。
 */
export async function captureOutput(fn: () => Promise<number>): Promise<CapturedRun> {
  const { sinks } = await import('../src/output.js');
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origOut = sinks.stdout;
  const origErr = sinks.stderr;
  const sink = (chunks: string[]) => ({
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  });
  sinks.stdout = sink(stdoutChunks);
  sinks.stderr = sink(stderrChunks);
  try {
    const code = await fn();
    return { code, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
  } finally {
    sinks.stdout = origOut;
    sinks.stderr = origErr;
  }
}

/** runCli + 输出捕获的便捷组合。 */
export async function runCliCaptured(argv: string[]): Promise<CapturedRun> {
  const { runCli } = await import('../src/index.js');
  return captureOutput(() => runCli(argv));
}

/** 断言辅助：期望 fn 抛出带指定退出码的 CliError，返回其 message。 */
export async function expectCliError(
  fn: () => Promise<unknown>,
  exitCode: number,
): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && err.name === 'CliError') {
      const code = (err as { exitCode?: number }).exitCode;
      if (code !== exitCode) {
        throw new Error(`期望 CliError 退出码 ${exitCode}，实际 ${code}（${err.message}）`);
      }
      return err.message;
    }
    throw new Error(`期望 CliError，实际抛出 ${err instanceof Error ? err.name : typeof err}: ${String(err)}`);
  }
  throw new Error(`期望抛出 CliError(${exitCode})，但 fn 正常返回`);
}
