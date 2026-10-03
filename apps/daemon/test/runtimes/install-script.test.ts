/**
 * Integration tests for the `script` install strategy (installFromScript).
 *
 * Per the project's integration-test rules, these mock the BEHAVIOR of every
 * side effect (network, filesystem, child processes) via the ScriptInstallDeps
 * seam and drive the full state machine — success path, network failures,
 * timeout, abort, validation failure, env passthrough — without real
 * downloads or installer processes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstallEvent, RuntimeAgentDef, ScriptInstallSource } from '@molio/contracts';
import {
  installFromScript,
  runScriptProcess,
  applyPypiMirrorEnv,
  type ScriptInstallDeps,
  type RunScriptArgs,
  type RunScriptResult,
} from '../../src/core/runtimes/install.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const isWindows = process.platform === 'win32';

function makeDef(overrides: Partial<RuntimeAgentDef> = {}): RuntimeAgentDef {
  return {
    id: 'hermes',
    name: 'Hermes Agent',
    bin: 'hermes-acp',
    versionArgs: ['--version'],
    buildArgs: () => [],
    fallbackModels: [],
    installUrl: 'https://github.com/NousResearch/hermes-agent',
    ...overrides,
  };
}

/** Platform keys cover both host machines used in CI (windows + macos). */
function makeSource(overrides: Partial<ScriptInstallSource> = {}): ScriptInstallSource {
  return {
    type: 'script',
    scripts: {
      'win32-x64': 'https://hermes-agent.nousresearch.com/install.ps1',
      'win32-arm64': 'https://hermes-agent.nousresearch.com/install.ps1',
      'darwin-x64': 'https://hermes-agent.nousresearch.com/install.sh',
      'darwin-arm64': 'https://hermes-agent.nousresearch.com/install.sh',
      'linux-x64': 'https://hermes-agent.nousresearch.com/install.sh',
      'linux-arm64': 'https://hermes-agent.nousresearch.com/install.sh',
    },
    platformArgs: { win32: ['-SkipBrowser'], posix: ['--skip-browser'] },
    timeoutMs: 60_000,
    verifyArgs: [['--check'], ['--version']],
    ...overrides,
  };
}

const OK_RESULT: RunScriptResult = { code: 0, stderrTail: '', timedOut: false, aborted: false };

function makeDeps(overrides: Partial<ScriptInstallDeps> = {}): ScriptInstallDeps {
  return {
    downloadScript: async () => Buffer.from('#!/bin/bash\necho installing\n'),
    writeTempScript: () => isWindows ? 'C:\\tmp\\molio-test.ps1' : '/tmp/molio-test.sh',
    cleanupTempScript: () => {},
    probeNetwork: async () => true,
    findShell: () => (isWindows ? 'powershell' : 'bash'),
    runScript: async () => OK_RESULT,
    resolveBinary: () => isWindows ? 'C:\\fake\\venv\\Scripts\\hermes-acp.exe' : '/fake/venv/bin/hermes-acp',
    runVerify: async (_binary, args) => ({
      ok: true,
      stdout: args.includes('--version') ? 'hermes-agent v2026.9.24\n' : '',
      stderr: '',
    }),
    ...overrides,
  };
}

async function run(
  deps: ScriptInstallDeps,
  opts: {
    def?: RuntimeAgentDef;
    source?: ScriptInstallSource;
    signal?: AbortSignal;
  } = {},
): Promise<InstallEvent[]> {
  const events: InstallEvent[] = [];
  await installFromScript(
    opts.def ?? makeDef(),
    opts.source ?? makeSource(),
    (e) => events.push(e),
    opts.signal,
    deps,
  );
  return events;
}

function phasesOf(events: InstallEvent[]): string[] {
  return events.filter((e) => e.type === 'phase').map((e) => (e as any).phase);
}

function errorOf(events: InstallEvent[]): Extract<InstallEvent, { type: 'error' }> | undefined {
  return events.find((e) => e.type === 'error') as any;
}

function doneOf(events: InstallEvent[]): Extract<InstallEvent, { type: 'done' }> | undefined {
  return events.find((e) => e.type === 'done') as any;
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

describe('installFromScript — success path', () => {
  it('should emit the full phase sequence and a done event with binary + version', async () => {
    const cleanedUp: string[] = [];
    const deps = makeDeps({
      cleanupTempScript: (p) => { cleanedUp.push(p); },
    });

    const events = await run(deps);

    assert.deepEqual(phasesOf(events), ['preflight', 'download', 'install', 'validate', 'path']);
    const done = doneOf(events);
    assert.ok(done, 'must emit done');
    assert.equal(done.binaryPath, deps.resolveBinary!(makeDef()));
    assert.equal(done.version, 'hermes-agent v2026.9.24');
    assert.equal(errorOf(events), undefined, 'no error events on success');
    assert.deepEqual(cleanedUp, [isWindows ? 'C:\\tmp\\molio-test.ps1' : '/tmp/molio-test.sh'],
      'temp script must be cleaned up');
  });

  it('should invoke the shell with non-interactive flag + per-platform args', async () => {
    const captured: RunScriptArgs[] = [];
    const deps = makeDeps({
      runScript: async (args) => { captured.push(args); return OK_RESULT; },
    });

    await run(deps);

    assert.equal(captured.length, 1, 'runScript must be invoked exactly once');
    const invocation = captured[0]!;
    if (isWindows) {
      assert.equal(invocation.cmd, 'powershell');
      assert.ok(invocation.args.includes('-ExecutionPolicy'));
      assert.ok(invocation.args.includes('-File'));
      assert.ok(invocation.args.includes('-NonInteractive'), 'engine must add -NonInteractive');
      assert.ok(invocation.args.includes('-SkipBrowser'), 'platformArgs must be appended');
    } else {
      assert.equal(invocation.cmd, 'bash');
      assert.ok(invocation.args.includes('--non-interactive'), 'engine must add --non-interactive');
      assert.ok(invocation.args.includes('--skip-browser'), 'posix platformArgs must be appended');
    }
    assert.equal(invocation.timeoutMs, 60_000, 'source.timeoutMs must be honored');
  });

  it('should stream installer output lines as log events', async () => {
    const deps = makeDeps({
      runScript: async ({ onLine }) => {
        onLine('Cloning hermes-agent...');
        onLine('Installing uv...');
        return OK_RESULT;
      },
    });

    const events = await run(deps);
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as any).message);
    assert.ok(logs.includes('Cloning hermes-agent...'));
    assert.ok(logs.includes('Installing uv...'));
  });
});

describe('installFromScript — network failures', () => {
  it('download failure → network error, retryable, script never executed', async () => {
    let ranScript = false;
    const deps = makeDeps({
      downloadScript: async () => { throw new Error('HTTP 502'); },
      runScript: async () => { ranScript = true; return OK_RESULT; },
    });

    const events = await run(deps);

    const err = errorOf(events);
    assert.ok(err, 'must emit error');
    assert.equal(err.category, 'network');
    assert.equal(err.retryable, true);
    assert.match(err.message, /HTTP 502/);
    assert.equal(ranScript, false, 'must not execute anything on download failure');
  });

  it('HTML error page (captive portal) → network error, script never executed', async () => {
    let ranScript = false;
    const deps = makeDeps({
      downloadScript: async () => Buffer.from('<!DOCTYPE html>\n<html><body>Proxy login required</body></html>'),
      runScript: async () => { ranScript = true; return OK_RESULT; },
    });

    const events = await run(deps);

    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'network');
    assert.match(err.message, /HTML page/i);
    assert.match(err.hint ?? '', /proxy|captive/i);
    assert.equal(ranScript, false);
  });

  it('oversized download → network error, script never executed', async () => {
    let ranScript = false;
    const deps = makeDeps({
      downloadScript: async () => Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
      runScript: async () => { ranScript = true; return OK_RESULT; },
    });

    const events = await run(deps);

    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'network');
    assert.equal(ranScript, false);
  });

  it('git clone DNS failure (Could not resolve host) → network + mirror hint', async () => {
    const deps = makeDeps({
      runScript: async () => ({
        code: 128,
        stderrTail: "fatal: unable to access 'https://github.com/NousResearch/hermes-agent/': Could not resolve host: github.com",
        timedOut: false,
        aborted: false,
      }),
    });

    const events = await run(deps);

    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'network');
    assert.equal(err.retryable, true);
    assert.match(err.hint ?? '', /MOLIO_HERMES_REPO_URL/);
    assert.match(err.hint ?? '', /github\.com/);
    assert.equal(doneOf(events), undefined);
  });

  it('github unreachable in preflight → warning log only, install proceeds', async () => {
    const deps = makeDeps({ probeNetwork: async () => false });

    const events = await run(deps);

    const warn = events.find((e) => e.type === 'log' && /not reachable/i.test((e as any).message));
    assert.ok(warn, 'must warn about github.com being unreachable');
    assert.ok(doneOf(events), 'unreachable probe must NOT block the install');
  });
});

describe('installFromScript — exit code classification', () => {
  it('Permission denied → permission error, non-retryable', async () => {
    const deps = makeDeps({
      runScript: async () => ({
        code: 1,
        stderrTail: "mkdir: cannot create directory '/opt/hermes': Permission denied",
        timedOut: false,
        aborted: false,
      }),
    });

    const events = await run(deps);
    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'permission');
    assert.equal(err.retryable, false);
  });

  it('unknown failure → runtime error, retryable', async () => {
    const deps = makeDeps({
      runScript: async () => ({
        code: 101,
        stderrTail: 'uv panicked: internal compiler error',
        timedOut: false,
        aborted: false,
      }),
    });

    const events = await run(deps);
    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'runtime');
    assert.equal(err.retryable, true);
    assert.match(err.message, /code 101/);
  });

  it('temp script is cleaned up even when the installer fails', async () => {
    let cleaned = false;
    const deps = makeDeps({
      runScript: async () => ({ code: 1, stderrTail: 'boom', timedOut: false, aborted: false }),
      cleanupTempScript: () => { cleaned = true; },
    });

    await run(deps);
    assert.equal(cleaned, true);
  });
});

describe('installFromScript — timeout and abort', () => {
  it('installer timeout → runtime error mentioning timeout', async () => {
    const deps = makeDeps({
      runScript: async () => ({ code: null, stderrTail: '', timedOut: true, aborted: false }),
    });

    const events = await run(deps);
    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'runtime');
    assert.match(err.message, /timed out/i);
    assert.equal(doneOf(events), undefined);
  });

  it('mid-run abort → cancelled error, unknown category, retryable', async () => {
    const deps = makeDeps({
      runScript: async () => ({ code: null, stderrTail: '', timedOut: false, aborted: true }),
    });

    const events = await run(deps);
    const err = errorOf(events);
    assert.ok(err);
    assert.match(err.message, /cancelled/i);
    assert.equal(err.retryable, true);
  });

  it('pre-aborted signal → cancelled before download', async () => {
    const ac = new AbortController();
    ac.abort();
    let downloaded = false;
    const deps = makeDeps({
      downloadScript: async () => { downloaded = true; return Buffer.from('echo hi'); },
    });

    const events = await run(deps, { signal: ac.signal });
    const err = errorOf(events);
    assert.ok(err);
    assert.match(err.message, /cancelled/i);
    assert.equal(downloaded, false, 'must not download when already aborted');
  });
});

describe('installFromScript — validation', () => {
  it('--check failure → validation error, no done event', async () => {
    const verifyCalls: string[][] = [];
    const deps = makeDeps({
      runVerify: async (_bin, args) => {
        verifyCalls.push(args);
        if (args.includes('--check')) {
          return { ok: false, stdout: '', stderr: 'ModuleNotFoundError: No module named \'acp\'' };
        }
        return { ok: true, stdout: 'v1', stderr: '' };
      },
    });

    const events = await run(deps);
    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'validation');
    assert.match(err.message, /--check/);
    assert.match(err.message, /ModuleNotFoundError/);
    assert.equal(doneOf(events), undefined);
    assert.deepEqual(verifyCalls, [['--check']], 'must fail fast — later verify args not run');
  });

  it('binary not found after install → validation error with restart hint', async () => {
    const deps = makeDeps({ resolveBinary: () => null });

    const events = await run(deps);
    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'validation');
    assert.match(err.message, /not found after install/);
    assert.match(err.hint ?? '', /restart|manually/i);
  });

  it('empty --version output → done with undefined version (degraded, not failed)', async () => {
    const deps = makeDeps({
      runVerify: async () => ({ ok: true, stdout: '', stderr: '' }),
    });

    const events = await run(deps);
    const done = doneOf(events);
    assert.ok(done, 'empty version must not block done');
    assert.equal(done.version, undefined);
    assert.ok(done.binaryPath);
  });
});

describe('installFromScript — preflight', () => {
  it('unsupported platform → platform error listing supported keys', async () => {
    const source = makeSource({ scripts: { 'freebsd-x64': 'https://example.com/install.sh' } });
    const events = await run(makeDeps(), { source });

    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'platform');
    assert.equal(err.retryable, false);
    assert.match(err.hint ?? '', /freebsd-x64/);
  });

  it('missing shell → platform error', async () => {
    const deps = makeDeps({ findShell: () => null });
    const events = await run(deps);

    const err = errorOf(events);
    assert.ok(err);
    assert.equal(err.category, 'platform');
    assert.match(err.message, /PowerShell|bash/);
  });
});

describe('installFromScript — env passthrough', () => {
  it('MOLIO_HERMES_REPO_URL → HERMES_REPO_URL in the installer env', async () => {
    const mirror = 'https://gitee.example.com/mirror/hermes-agent';
    const saved = process.env['MOLIO_HERMES_REPO_URL'];
    process.env['MOLIO_HERMES_REPO_URL'] = mirror;
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    try {
      const deps = makeDeps({
        runScript: async (args) => { capturedEnvs.push(args.env); return OK_RESULT; },
      });
      await run(deps);
    } finally {
      if (saved === undefined) delete process.env['MOLIO_HERMES_REPO_URL'];
      else process.env['MOLIO_HERMES_REPO_URL'] = saved;
    }

    assert.equal(capturedEnvs.length, 1);
    assert.equal(capturedEnvs[0]!['HERMES_REPO_URL'], mirror);
  });

  it('no MOLIO_HERMES_REPO_URL → HERMES_REPO_URL not injected', async () => {
    const saved = process.env['MOLIO_HERMES_REPO_URL'];
    delete process.env['MOLIO_HERMES_REPO_URL'];
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    try {
      const deps = makeDeps({
        runScript: async (args) => { capturedEnvs.push(args.env); return OK_RESULT; },
      });
      await run(deps);
    } finally {
      if (saved !== undefined) process.env['MOLIO_HERMES_REPO_URL'] = saved;
    }

    assert.equal(capturedEnvs.length, 1);
    assert.equal(capturedEnvs[0]!['HERMES_REPO_URL'], undefined);
  });
});

// ─── Real subprocess tree-kill (regression: orphaned installer) ─────────────
//
// The tests above stub `runScript` entirely, so the real killTree / settle path
// in runScriptProcess never runs. That is exactly why CI stayed green while a
// real abort/timeout orphaned the installer: the script forks a subshell that
// inherits the stdio pipes, survives a direct-child-only kill, keeps
// downloading, and keeps 'close' from ever firing (so the promise never
// settles and no cancelled/error event reaches the UI).
//
// These cases spawn a REAL tree-forking subprocess, abort mid-run, and assert
// (a) the promise settles promptly and (b) the grandchild is dead, not
// reparented. Both fail on the pre-fix implementation.

/** Poll until `pid` no longer exists (or timeout). Returns true if it died. */
async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH (or EPERM on a zombie) — treat as gone
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

describe('runScriptProcess — real tree kill (orphaned-installer regression)', () => {
  it('abort kills the forked grandchild and settles promptly (POSIX)', {
    skip: isWindows ? 'POSIX-only reproduction (bash process group)' : false,
  }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-killtree-'));
    const gpPidFile = path.join(dir, 'gp.pid');
    const scriptPath = path.join(dir, 'install.sh');
    try {
      // Stand-in for the real installer: fork a long-lived grandchild that
      // inherits stdout/stderr (the fd that kept the pipe open + orphaned the
      // installer), record its pid, then keep the parent alive too.
      writeFileSync(
        scriptPath,
        `#!/usr/bin/env bash\nsleep 300 &\necho $! > "${gpPidFile}"\necho started\nsleep 300\n`,
        { mode: 0o755 },
      );

      const ac = new AbortController();
      let sawStarted = false;
      const t0 = Date.now();
      const result = await runScriptProcess({
        cmd: 'bash',
        args: [scriptPath],
        env: { ...process.env },
        timeoutMs: 60_000,
        signal: ac.signal,
        onLine: (line) => {
          if (!sawStarted && line.includes('started')) {
            sawStarted = true;
            setTimeout(() => ac.abort(), 150);
          }
        },
      });
      const elapsed = Date.now() - t0;

      assert.equal(sawStarted, true, 'grandchild must have started before abort');
      assert.equal(result.aborted, true, 'result must be flagged aborted');
      assert.ok(elapsed < 10_000, `must settle promptly, took ${elapsed}ms (orphaned pipe would hang)`);

      const gpPid = parseInt(readFileSync(gpPidFile, 'utf8').trim(), 10);
      assert.ok(Number.isFinite(gpPid) && gpPid > 0, 'grandchild pid recorded');
      assert.equal(await waitForDeath(gpPid), true, `grandchild ${gpPid} must be killed, not orphaned`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('abort kills the child tree and settles promptly (win32)', {
    skip: !isWindows ? 'win32-only reproduction (taskkill /T)' : false,
  }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-killtree-'));
    const gpPidFile = path.join(dir, 'gp.pid');
    const scriptPath = path.join(dir, 'install.ps1');
    try {
      // Launch a long-lived grandchild (ping -t), record its pid, then idle.
      writeFileSync(
        scriptPath,
        [
          '$ErrorActionPreference = "Stop"',
          `$p = Start-Process -FilePath "ping.exe" -ArgumentList "-t","127.0.0.1" -PassThru -WindowStyle Hidden`,
          `$p.Id | Out-File -FilePath "${gpPidFile}" -Encoding ascii`,
          'Write-Output "started"',
          'Start-Sleep -Seconds 300',
        ].join('\r\n'),
      );

      const ac = new AbortController();
      let sawStarted = false;
      const t0 = Date.now();
      const result = await runScriptProcess({
        cmd: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', scriptPath],
        env: { ...process.env },
        timeoutMs: 60_000,
        signal: ac.signal,
        onLine: (line) => {
          if (!sawStarted && line.includes('started')) {
            sawStarted = true;
            setTimeout(() => ac.abort(), 300);
          }
        },
      });
      const elapsed = Date.now() - t0;

      assert.equal(sawStarted, true, 'grandchild must have started before abort');
      assert.equal(result.aborted, true, 'result must be flagged aborted');
      assert.ok(elapsed < 10_000, `must settle promptly, took ${elapsed}ms`);

      const gpPid = parseInt(readFileSync(gpPidFile, 'utf8').trim(), 10);
      assert.ok(Number.isFinite(gpPid) && gpPid > 0, 'grandchild pid recorded');
      assert.equal(await waitForDeath(gpPid), true, `grandchild ${gpPid} must be killed, not orphaned`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── PyPI / uv mirror injection (信创/内网 dependency sync) ──────────────────
//
// The official hermes installer syncs Python deps with its own pinned uv under
// `UV_NO_CONFIG=1`. On 内网/信创 machines pypi.org is blocked, so that step
// hangs until the install timeout. The engine must redirect uv/pip to a
// reachable mirror via index env vars (which uv/pip honor even with
// UV_NO_CONFIG). Precedence: explicit MOLIO_PYPI_MIRROR > user-set index >
// probe pypi.org and fall back to aliyun only when unreachable.

const PYPI_KEYS = ['UV_DEFAULT_INDEX', 'UV_INDEX_URL', 'PIP_INDEX_URL'] as const;

describe('applyPypiMirrorEnv — precedence', () => {
  it('explicit MOLIO_PYPI_MIRROR wins and sets uv+pip index vars', async () => {
    const env: NodeJS.ProcessEnv = { MOLIO_PYPI_MIRROR: 'https://my.mirror/simple/' };
    let probed = false;
    await applyPypiMirrorEnv(env, async () => { probed = true; return true; }, () => {});
    for (const k of PYPI_KEYS) assert.equal(env[k], 'https://my.mirror/simple/');
    assert.equal(probed, false, 'explicit mirror must short-circuit the probe');
  });

  it('a pre-existing user index is never clobbered', async () => {
    const env: NodeJS.ProcessEnv = { UV_INDEX_URL: 'https://corp.index/simple/' };
    // Even with pypi.org unreachable, the user's explicit index must survive.
    await applyPypiMirrorEnv(env, async () => false, () => {});
    assert.equal(env['UV_INDEX_URL'], 'https://corp.index/simple/');
    assert.equal(env['PIP_INDEX_URL'], undefined, 'must not inject other keys over a user index');
  });

  it('pypi.org unreachable → falls back to the aliyun mirror', async () => {
    const env: NodeJS.ProcessEnv = {};
    const logs: string[] = [];
    await applyPypiMirrorEnv(
      env,
      async (url) => !url.includes('pypi.org'), // github ok, pypi blocked
      (e) => { if (e.type === 'log') logs.push(e.message); },
    );
    for (const k of PYPI_KEYS) assert.equal(env[k], 'https://mirrors.aliyun.com/pypi/simple/');
    assert.ok(logs.some((m) => /pypi\.org is not reachable/i.test(m)), 'must log the fallback');
  });

  it('pypi.org reachable + no override → injects nothing (stock behavior)', async () => {
    const env: NodeJS.ProcessEnv = {};
    await applyPypiMirrorEnv(env, async () => true, () => {});
    for (const k of PYPI_KEYS) assert.equal(env[k], undefined);
  });
});

describe('installFromScript — PyPI mirror wiring', () => {
  it('injects the mirror into the installer env when pypi.org is unreachable', async () => {
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    const deps = makeDeps({
      probeNetwork: async (url) => !url.includes('pypi.org'),
      runScript: async (args) => { capturedEnvs.push(args.env); return OK_RESULT; },
    });
    await run(deps);
    assert.equal(capturedEnvs.length, 1);
    assert.equal(capturedEnvs[0]!['PIP_INDEX_URL'], 'https://mirrors.aliyun.com/pypi/simple/');
    assert.equal(capturedEnvs[0]!['UV_DEFAULT_INDEX'], 'https://mirrors.aliyun.com/pypi/simple/');
  });

  it('MOLIO_PYPI_MIRROR is passed through to the installer env', async () => {
    const mirror = 'https://internal.pypi/simple/';
    const saved = process.env['MOLIO_PYPI_MIRROR'];
    process.env['MOLIO_PYPI_MIRROR'] = mirror;
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    try {
      const deps = makeDeps({
        runScript: async (args) => { capturedEnvs.push(args.env); return OK_RESULT; },
      });
      await run(deps);
    } finally {
      if (saved === undefined) delete process.env['MOLIO_PYPI_MIRROR'];
      else process.env['MOLIO_PYPI_MIRROR'] = saved;
    }
    assert.equal(capturedEnvs.length, 1);
    assert.equal(capturedEnvs[0]!['PIP_INDEX_URL'], mirror);
    assert.equal(capturedEnvs[0]!['UV_INDEX_URL'], mirror);
  });
});
