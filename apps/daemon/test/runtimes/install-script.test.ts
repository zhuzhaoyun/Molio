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
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstallEvent, RuntimeAgentDef, ScriptInstallSource } from '@molio/contracts';
import {
  installFromScript,
  runScriptProcess,
  applyPypiMirrorEnv,
  applyPythonInstallMirrorEnv,
  resolveLockMirror,
  rewriteLockfileMirrors,
  applyLockfileMirror,
  rewriteGitConfigValue,
  applyGitConfigRepair,
  collectDescendants,
  type ProcPidPair,
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
      // 20s ceiling, not 10s: under full-suite parallel load on Windows,
      // powershell spawn + taskkill /T settle has been observed at 12-14s
      // (a cold powershell.exe start alone can eat several seconds). The
      // regression this guards against — an orphaned grandchild holding the
      // stdio pipe open — never settles at all (the child sleeps 300s), so a
      // 20s ceiling still discriminates cleanly while tolerating a loaded box.
      assert.ok(elapsed < 20_000, `must settle promptly, took ${elapsed}ms`);

      const gpPid = parseInt(readFileSync(gpPidFile, 'utf8').trim(), 10);
      assert.ok(Number.isFinite(gpPid) && gpPid > 0, 'grandchild pid recorded');
      assert.equal(await waitForDeath(gpPid), true, `grandchild ${gpPid} must be killed, not orphaned`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The 2-level case above launches its grandchild with Start-Process, i.e. a
  // DIRECT child of the shell — which `taskkill /T` always reaps. The real
  // installer chain is one level deeper: powershell → python (the bootstrap
  // interpreter) → `git fetch`. A products-stage timeout on a CN network killed
  // the shell and python but left `git fetch` running: it kept writing a 104MB
  // pack into the checkout for another 9.5 minutes (observed 2026-10-05:
  // FETCH_HEAD + pack-*.pack landed at 17:32:30, ~9min after the 1800s stage
  // budget expired at ~17:23), racing any retry the user started from the UI.
  // Reproduce with a 3-level chain: powershell → cmd (batch) → powershell, the
  // innermost recording its own pid before it sleeps.
  it('abort kills a THREE-level tree (shell → cmd → grandchild) on win32', {
    skip: !isWindows ? 'win32-only reproduction (taskkill /T)' : false,
  }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-killtree3-'));
    const deepPidFile = path.join(dir, 'deep.pid');
    const batPath = path.join(dir, 'deep.bat');
    const scriptPath = path.join(dir, 'install.ps1');
    try {
      writeFileSync(
        batPath,
        [
          '@echo off',
          // Innermost process: record our own pid, then idle like a long fetch.
          `powershell -NoProfile -Command "$PID | Out-File -FilePath '${deepPidFile}' -Encoding ascii; Start-Sleep -Seconds 300"`,
        ].join('\r\n'),
      );
      writeFileSync(
        scriptPath,
        ['$ErrorActionPreference = "Stop"', `& cmd /c "${batPath}"`].join('\r\n'),
      );

      const ac = new AbortController();
      const t0 = Date.now();
      const promise = runScriptProcess({
        cmd: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', scriptPath],
        env: { ...process.env },
        timeoutMs: 60_000,
        signal: ac.signal,
        onLine: () => {},
      });

      // Wait for the 3rd-level process to exist, then abort mid-run.
      const deadline = Date.now() + 30_000;
      while (!existsSync(deepPidFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.equal(existsSync(deepPidFile), true, 'deep grandchild must have started before abort');
      const deepPid = parseInt(readFileSync(deepPidFile, 'utf8').trim(), 10);
      assert.ok(Number.isFinite(deepPid) && deepPid > 0, 'deep grandchild pid recorded');

      ac.abort();
      const result = await promise;
      const elapsed = Date.now() - t0;

      assert.equal(result.aborted, true, 'result must be flagged aborted');
      assert.ok(elapsed < 20_000, `must settle promptly, took ${elapsed}ms`);
      assert.equal(
        await waitForDeath(deepPid, 10_000),
        true,
        `3rd-level process ${deepPid} must be killed, not orphaned`,
      );
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

describe('collectDescendants — pid-tree BFS (Windows killTree sweep)', () => {
  it('walks a linear alive chain and returns it deepest-first (root excluded)', () => {
    const procs: ProcPidPair[] = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 3 },
    ];
    assert.deepEqual(collectDescendants(1, procs), [4, 3, 2]);
  });

  it('reaches descendants when the ROOT is already dead (the taskkill /T gap)', () => {
    // Root pid 1 is gone from the table, but its child (2) and grandchild (3)
    // live on, their ppid chain still pointing at dead parents. A fresh
    // `taskkill /pid 1 /T` errors "process not found" and reaps nothing; the
    // snapshot BFS still connects 1 → 2 → 3 and returns them for force-kill.
    const procs: ProcPidPair[] = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
    ];
    assert.deepEqual(collectDescendants(1, procs), [3, 2]);
  });

  it('collects a branching tree deepest-first', () => {
    const procs: ProcPidPair[] = [
      { pid: 2, ppid: 1 }, // child A
      { pid: 3, ppid: 1 }, // child B
      { pid: 4, ppid: 2 }, // grandchild under A
    ];
    const out = collectDescendants(1, procs);
    assert.equal(out[0], 4, 'the depth-2 grandchild must be killed before its parents');
    assert.deepEqual([...out].sort((a, b) => a - b), [2, 3, 4]);
    assert.equal(out.length, 3);
  });

  it('does not hang on a pid-reuse cycle', () => {
    const procs: ProcPidPair[] = [
      { pid: 2, ppid: 3 },
      { pid: 3, ppid: 2 },
    ];
    assert.deepEqual(collectDescendants(2, procs), [3]);
  });

  it('skips self-parented rows (System / System Idle)', () => {
    const procs: ProcPidPair[] = [
      { pid: 1, ppid: 1 },
      { pid: 2, ppid: 1 },
    ];
    assert.deepEqual(collectDescendants(1, procs), [2]);
  });

  it('returns [] for an empty table or a root with no reachable descendants', () => {
    assert.deepEqual(collectDescendants(1, []), []);
    // Orphan whose parent is neither the root nor alive (case A: a middle
    // process died first, reparenting nothing on Windows). No pid-tree method
    // can reach it — this is the documented limit the primary git-config fix
    // (never letting the stage hang) exists to avoid ever hitting.
    assert.deepEqual(collectDescendants(1, [{ pid: 5, ppid: 3 }]), []);
  });
});

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

// ─── uv managed-Python (python-build-standalone) mirror injection ───────────
//
// The hermes installer's uv downloads a managed CPython from GitHub's release
// CDN (objects.githubusercontent.com). On CN networks that CDN stalls even when
// github.com itself is reachable — observed in the field: a 161MB PBS `.part`
// preallocated but 0 bytes transferred (`.ranges` empty), install killed at the
// 600s wall-clock timeout with no hermes-acp produced. It's the same PBS source
// docling's python-provision.ts mirrors via npmmirror (aliyun). The engine must
// set UV_PYTHON_INSTALL_MIRROR so uv pulls the interpreter from npmmirror.
// Precedence: explicit MOLIO_PYTHON_MIRROR > user-set UV_PYTHON_INSTALL_MIRROR >
// probe npmmirror and use it when reachable (else stock GitHub for overseas).

const PBS_NPMMIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone';

describe('applyPythonInstallMirrorEnv — precedence', () => {
  it('explicit MOLIO_PYTHON_MIRROR wins and sets UV_PYTHON_INSTALL_MIRROR', async () => {
    const env: NodeJS.ProcessEnv = { MOLIO_PYTHON_MIRROR: 'https://my.mirror/pbs/' };
    let probed = false;
    await applyPythonInstallMirrorEnv(env, async () => { probed = true; return true; }, () => {});
    assert.equal(env['UV_PYTHON_INSTALL_MIRROR'], 'https://my.mirror/pbs'); // trailing slash stripped
    assert.equal(probed, false, 'explicit mirror must short-circuit the probe');
  });

  it('a pre-existing UV_PYTHON_INSTALL_MIRROR is never clobbered', async () => {
    const env: NodeJS.ProcessEnv = { UV_PYTHON_INSTALL_MIRROR: 'https://corp/pbs' };
    await applyPythonInstallMirrorEnv(env, async () => true, () => {});
    assert.equal(env['UV_PYTHON_INSTALL_MIRROR'], 'https://corp/pbs');
  });

  it('npmmirror reachable → routes the PBS download through it', async () => {
    const env: NodeJS.ProcessEnv = {};
    const logs: string[] = [];
    await applyPythonInstallMirrorEnv(
      env,
      async () => true,
      (e) => { if (e.type === 'log') logs.push(e.message); },
    );
    assert.equal(env['UV_PYTHON_INSTALL_MIRROR'], PBS_NPMMIRROR);
    assert.ok(logs.some((m) => /npmmirror|python-build-standalone/i.test(m)), 'must log the redirect');
  });

  it('npmmirror unreachable → injects nothing (stock GitHub download)', async () => {
    const env: NodeJS.ProcessEnv = {};
    await applyPythonInstallMirrorEnv(env, async () => false, () => {});
    assert.equal(env['UV_PYTHON_INSTALL_MIRROR'], undefined);
  });
});

describe('installFromScript — uv Python mirror wiring', () => {
  it('injects the npmmirror PBS mirror into the installer env when reachable', async () => {
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    const deps = makeDeps({
      probeNetwork: async () => true, // npmmirror reachable
      runScript: async (args) => { capturedEnvs.push(args.env); return OK_RESULT; },
    });
    await run(deps);
    assert.equal(capturedEnvs.length, 1);
    assert.equal(capturedEnvs[0]!['UV_PYTHON_INSTALL_MIRROR'], PBS_NPMMIRROR);
  });

  it('MOLIO_PYTHON_MIRROR is passed through to UV_PYTHON_INSTALL_MIRROR', async () => {
    const mirror = 'https://internal/pbs';
    const saved = process.env['MOLIO_PYTHON_MIRROR'];
    process.env['MOLIO_PYTHON_MIRROR'] = mirror;
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    try {
      const deps = makeDeps({
        runScript: async (args) => { capturedEnvs.push(args.env); return OK_RESULT; },
      });
      await run(deps);
    } finally {
      if (saved === undefined) delete process.env['MOLIO_PYTHON_MIRROR'];
      else process.env['MOLIO_PYTHON_MIRROR'] = saved;
    }
    assert.equal(capturedEnvs.length, 1);
    assert.equal(capturedEnvs[0]!['UV_PYTHON_INSTALL_MIRROR'], mirror);
  });
});

// ─── Staged install protocol + lockfile CN-mirror hook ──────────────────────
//
// Root cause of the real-world 600s install timeout: pm's ffmpeg artifact
// (~169MB, GitHub Releases CDN) trickle-throttles on CN lines — the CDN
// connects fine, so pm's own pinned-source fallback never triggers, and the
// download never finishes. The fix: drive the installer through its official
// `-Stage NAME` / `--stage NAME` protocol and, after the clone stage lands the
// repo but BEFORE python-deps starts pulling artifacts, rewrite pm/lock.json's
// GitHub/nodejs URLs to a probed CN-reachable mirror. Integrity stays anchored
// by the lockfile's sha256 pins (the installer verifies every downloaded byte).

const STAGE_FLAG = isWindows ? '-Stage' : '--stage';

/** Extract the stage name from a captured invocation (last arg after the flag). */
function stageOf(invocation: RunScriptArgs): string | undefined {
  const args = invocation.args;
  return args[args.length - 2] === STAGE_FLAG ? args[args.length - 1] : undefined;
}

/** A lock.json shaped like the real pm lockfile: object AND list artifacts,
 *  github/nodejs/npm/raw/docker URLs, every http entry sha256-pinned. */
function lockFixture() {
  return {
    schema: 1,
    packages: {
      ffmpeg: {
        version: '9.0.1',
        artifacts: {
          'win32-x64': {
            url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild/ffmpeg.zip',
            sha256: 'a'.repeat(64),
          },
        },
      },
      node: {
        version: '26.7.0',
        artifacts: {
          'win32-x64': {
            url: 'https://nodejs.org/dist/v26.7.0/node-v26.7.0-win-x64.zip',
            sha256: 'b'.repeat(64),
          },
        },
      },
      'agent-browser': {
        version: '0.26.0',
        artifacts: {
          any: {
            url: 'https://registry.npmjs.org/agent-browser/-/agent-browser-0.26.0.tgz',
            sha256: 'c'.repeat(64),
          },
        },
      },
      'iron-proxy': {
        version: '1.0',
        artifacts: {
          'win32-x64': [
            { url: 'https://raw.githubusercontent.com/paradigmxyz/iron-proxy/main/public-key.asc', sha256: 'd'.repeat(64) },
            { url: 'https://github.com/paradigmxyz/iron-proxy/releases/download/v1/ip.zip', sha256: 'e'.repeat(64) },
          ],
        },
      },
      'termux-docker': {
        artifacts: {
          docker: { url: `docker://termux/termux-docker@sha256:${'f'.repeat(64)}`, sha256: null },
        },
      },
    },
  };
}

function writeLockFixture(dir: string, rel = path.join('pm', 'lock.json')): string {
  const lockPath = path.join(dir, rel);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(lockFixture(), null, 2), 'utf8');
  return lockPath;
}

describe('installFromScript — staged stage protocol', () => {
  it('runs one invocation per stage, in order, with the stage flag appended', async () => {
    const captured: RunScriptArgs[] = [];
    const deps = makeDeps({
      runScript: async (args) => { captured.push(args); return OK_RESULT; },
    });
    const stages = ['prerequisites', 'repository', 'complete'];
    const events = await run(deps, { source: makeSource({ stages }) });

    assert.equal(captured.length, stages.length, 'one process per stage');
    assert.deepEqual(captured.map(stageOf), stages);
    for (const invocation of captured) {
      assert.equal(invocation.timeoutMs, 60_000, 'timeoutMs is a PER-STAGE budget');
      assert.ok(
        invocation.args.includes(isWindows ? '-SkipBrowser' : '--skip-browser'),
        'platformArgs must be present in every stage invocation',
      );
    }
    assert.ok(doneOf(events), 'staged success must reach the done event');
    assert.equal(errorOf(events), undefined);
  });

  it('stage failure stops the ladder and the error names the stage', async () => {
    const ran: string[] = [];
    const deps = makeDeps({
      runScript: async (args) => {
        const stage = stageOf(args)!;
        ran.push(stage);
        if (stage === 'repository') {
          return {
            code: 128,
            stderrTail: "fatal: unable to access 'https://github.com/NousResearch/hermes-agent/': Could not resolve host: github.com",
            timedOut: false,
            aborted: false,
          };
        }
        return OK_RESULT;
      },
    });

    const events = await run(deps, {
      source: makeSource({ stages: ['prerequisites', 'repository', 'python-deps', 'complete'] }),
    });

    assert.deepEqual(ran, ['prerequisites', 'repository'], 'later stages must not run');
    const err = errorOf(events);
    assert.ok(err);
    assert.match(err.message, /stage 'repository'/);
    assert.equal(err.category, 'network');
    assert.equal(doneOf(events), undefined);
  });

  it('stage timeout reports the stage name and stays retryable', async () => {
    const deps = makeDeps({
      runScript: async (args) =>
        stageOf(args) === 'python-deps'
          ? { code: null, stderrTail: '', timedOut: true, aborted: false }
          : OK_RESULT,
    });

    const events = await run(deps, {
      source: makeSource({ stages: ['repository', 'python-deps', 'complete'] }),
    });

    const err = errorOf(events);
    assert.ok(err);
    assert.match(err.message, /timed out after 60s \(stage: python-deps\)/);
    assert.equal(err.category, 'runtime');
    assert.equal(err.retryable, true);
    assert.equal(doneOf(events), undefined);
  });

  it('abort between stages cancels without running later stages', async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const deps = makeDeps({
      runScript: async (args) => {
        const stage = stageOf(args)!;
        ran.push(stage);
        if (stage === 'repository') ac.abort(); // user hits cancel mid-ladder
        return OK_RESULT;
      },
    });

    const events = await run(deps, {
      source: makeSource({ stages: ['prerequisites', 'repository', 'python-deps', 'complete'] }),
      signal: ac.signal,
    });

    assert.deepEqual(ran, ['prerequisites', 'repository']);
    const err = errorOf(events);
    assert.ok(err);
    assert.match(err.message, /cancelled/i);
    assert.equal(err.retryable, true);
  });

  it('temp script is cleaned up when a stage fails', async () => {
    let cleaned = false;
    const deps = makeDeps({
      runScript: async () => ({ code: 1, stderrTail: 'boom', timedOut: false, aborted: false }),
      cleanupTempScript: () => { cleaned = true; },
    });
    await run(deps, { source: makeSource({ stages: ['prerequisites', 'complete'] }) });
    assert.equal(cleaned, true);
  });
});

describe('installFromScript — mirrorLockfile hook wiring', () => {
  const HOME_ENV = 'MOLIO_TEST_HERMES_HOME';

  function stagedSourceWithMirror(overrides: Partial<ScriptInstallSource> = {}): ScriptInstallSource {
    return makeSource({
      stages: ['repository', 'python-deps', 'complete'],
      mirrorLockfile: {
        afterStage: 'repository',
        relPath: path.join('pm', 'lock.json'),
        homeEnv: HOME_ENV,
        defaultHome: { win32: '%MOLIO_TEST_NOWHERE%', posix: '%MOLIO_TEST_NOWHERE%' },
      },
      ...overrides,
    });
  }

  function withHomeEnv<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env[HOME_ENV];
    process.env[HOME_ENV] = dir;
    return fn().finally(() => {
      if (saved === undefined) delete process.env[HOME_ENV];
      else process.env[HOME_ENV] = saved;
    });
  }

  it('rewrites the lockfile AFTER the clone stage and BEFORE the next stage runs', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-lockmirror-'));
    const lockPath = writeLockFixture(dir);
    try {
      await withHomeEnv(dir, async () => {
        let lockSeenByDepsStage = '';
        const deps = makeDeps({
          runScript: async (args) => {
            // python-deps must observe the ALREADY-rewritten lockfile — that's
            // the whole point of the hook placement.
            if (stageOf(args) === 'python-deps') lockSeenByDepsStage = readFileSync(lockPath, 'utf8');
            return OK_RESULT;
          },
        });

        const events = await run(deps, { source: stagedSourceWithMirror() });
        assert.ok(doneOf(events), 'mirror rewrite must not break the install');
        assert.match(lockSeenByDepsStage, /ghfast\.top/, 'rewrite must land before python-deps runs');

        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        assert.equal(
          lock.packages.ffmpeg.artifacts['win32-x64'].url,
          'https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild/ffmpeg.zip',
        );
        // sha256 pins are the integrity anchor — never touched.
        assert.equal(lock.packages.ffmpeg.artifacts['win32-x64'].sha256, 'a'.repeat(64));

        const rewriteLogs = events.filter(
          (e) => e.type === 'log' && /Rewrote \d+ lockfile download URL/.test((e as any).message),
        );
        assert.equal(rewriteLogs.length, 1, 'hook must fire exactly once');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing lockfile → warning log, install proceeds (best-effort hook)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-lockmirror-'));
    try {
      await withHomeEnv(dir, async () => {
        const events = await run(makeDeps(), { source: stagedSourceWithMirror() });
        const warn = events.find((e) => e.type === 'log' && /lockfile not found/i.test((e as any).message));
        assert.ok(warn, 'must log a warning naming the missing lockfile');
        assert.ok(doneOf(events), 'a missing lockfile must never fail the install');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no reachable mirror → lockfile untouched, install proceeds on upstream URLs', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-lockmirror-'));
    const lockPath = writeLockFixture(dir);
    const before = readFileSync(lockPath, 'utf8');
    try {
      await withHomeEnv(dir, async () => {
        const deps = makeDeps({ probeNetwork: async () => false });
        const events = await run(deps, { source: stagedSourceWithMirror() });
        assert.equal(readFileSync(lockPath, 'utf8'), before, 'file must be byte-identical');
        assert.ok(events.some((e) => e.type === 'log' && /keeping upstream download URLs/i.test((e as any).message)));
        assert.ok(doneOf(events));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mirrorLockfile WITHOUT stages never fires (hook requires the stage protocol)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-lockmirror-'));
    const lockPath = writeLockFixture(dir);
    const before = readFileSync(lockPath, 'utf8');
    try {
      await withHomeEnv(dir, async () => {
        const source = makeSource({
          mirrorLockfile: {
            afterStage: 'repository',
            relPath: path.join('pm', 'lock.json'),
            homeEnv: HOME_ENV,
            defaultHome: { win32: '%MOLIO_TEST_NOWHERE%', posix: '%MOLIO_TEST_NOWHERE%' },
          },
        });
        const captured: RunScriptArgs[] = [];
        const deps = makeDeps({ runScript: async (a) => { captured.push(a); return OK_RESULT; } });
        const events = await run(deps, { source });
        assert.equal(captured.length, 1, 'single full-ladder invocation');
        assert.equal(stageOf(captured[0]!), undefined, 'no stage flag in single-run mode');
        assert.equal(readFileSync(lockPath, 'utf8'), before, 'hook must not fire without stages');
        assert.ok(doneOf(events));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── repairGitConfig hook (legacy treeless-checkout backfill skip) ──────────
//
// Real incident (2026-10-05): a hermes checkout cloned with the legacy
// `--filter=tree:0` made the `products` stage run hermes's own
// convert_treeless_checkout, which re-fetches ~100MB of history via
// `git fetch --refetch` (two python subprocess caps of 900s = our exact 1800s
// per-stage budget). On a ~60KB/s CN line the stage timed out while the second
// refetch was still writing a 104MB pack — and because the migration only
// stamps the new filter on success, every retry re-paid the full backfill.
// The fix stamps `blob:none` over `tree:0` right after the clone so the
// migration gate short-circuits. These tests cover the pure rewrite, the
// best-effort filesystem hook, and the stage-loop wiring.

/** A `.git/config` exactly as a legacy treeless clone leaves it (TAB-indented). */
const TREELESS_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = false',
  '\tbare = false',
  '[remote "origin"]',
  '\turl = https://github.com/NousResearch/hermes-agent',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '\tpromisor = true',
  '\tpartialclonefilter = tree:0',
  '[branch "main"]',
  '\tremote = origin',
  '\tmerge = refs/heads/main',
  '',
].join('\n');

function writeGitConfigFixture(home: string, repoRel: string, content: string): string {
  const gitDir = path.join(home, repoRel, '.git');
  mkdirSync(gitDir, { recursive: true });
  const configPath = path.join(gitDir, 'config');
  writeFileSync(configPath, content, 'utf8');
  return configPath;
}

describe('rewriteGitConfigValue — pure surgical rewrite', () => {
  const KEY = 'remote.origin.partialclonefilter';

  it('rewrites tree:0 → blob:none inside [remote "origin"], leaving all other lines byte-identical', () => {
    const { text, changed } = rewriteGitConfigValue(TREELESS_CONFIG, KEY, 'tree:0', 'blob:none');
    assert.equal(changed, true);
    assert.match(text, /partialclonefilter = blob:none/);
    assert.doesNotMatch(text, /tree:0/);
    // Every other line is untouched — the edit is surgical, not a reformat.
    const before = TREELESS_CONFIG.split('\n');
    const after = text.split('\n');
    assert.equal(after.length, before.length, 'line count must be preserved');
    const diffs = before.filter((l, i) => l !== after[i]);
    assert.deepEqual(diffs, ['\tpartialclonefilter = tree:0'], 'exactly one line changed');
  });

  it('matches fromValue case-insensitively (TREE:0 still triggers the repair)', () => {
    const cfg = TREELESS_CONFIG.replace('tree:0', 'TREE:0');
    const { text, changed } = rewriteGitConfigValue(cfg, KEY, 'tree:0', 'blob:none');
    assert.equal(changed, true);
    assert.match(text, /partialclonefilter = blob:none/);
  });

  it('preserves a quoted value style: "tree:0" → "blob:none"', () => {
    const cfg = TREELESS_CONFIG.replace('partialclonefilter = tree:0', 'partialclonefilter = "tree:0"');
    const { text, changed } = rewriteGitConfigValue(cfg, KEY, 'tree:0', 'blob:none');
    assert.equal(changed, true);
    assert.match(text, /partialclonefilter = "blob:none"/, 'quotes must be preserved');
  });

  it('is idempotent: an already-blob:none checkout reports changed=false and returns the original text', () => {
    const cfg = TREELESS_CONFIG.replace('tree:0', 'blob:none');
    const { text, changed } = rewriteGitConfigValue(cfg, KEY, 'tree:0', 'blob:none');
    assert.equal(changed, false);
    assert.equal(text, cfg, 'must return the identical string, not a reformat');
  });

  it('does nothing when the value differs from fromValue (e.g. a different legacy filter)', () => {
    const cfg = TREELESS_CONFIG.replace('tree:0', 'blob:limit=1m');
    const { changed } = rewriteGitConfigValue(cfg, KEY, 'tree:0', 'blob:none');
    assert.equal(changed, false);
  });

  it('does nothing when the [remote "origin"] section is absent', () => {
    const cfg = '[core]\n\tbare = false\n[remote "upstream"]\n\tpartialclonefilter = tree:0\n';
    const { changed } = rewriteGitConfigValue(cfg, KEY, 'tree:0', 'blob:none');
    assert.equal(changed, false);
  });

  it('only touches [remote "origin"] — a tree:0 in [remote "upstream"] is left alone', () => {
    const cfg = [
      '[remote "upstream"]',
      '\tpartialclonefilter = tree:0',
      '[remote "origin"]',
      '\tpartialclonefilter = tree:0',
      '',
    ].join('\n');
    const { text, changed } = rewriteGitConfigValue(cfg, KEY, 'tree:0', 'blob:none');
    assert.equal(changed, true);
    // upstream keeps tree:0, origin becomes blob:none.
    assert.match(text, /\[remote "upstream"\]\n\tpartialclonefilter = tree:0/);
    assert.match(text, /\[remote "origin"\]\n\tpartialclonefilter = blob:none/);
  });

  it('handles a 2-part key with no subsection (core.bare)', () => {
    const cfg = '[core]\n\tbare = false\n';
    const { text, changed } = rewriteGitConfigValue(cfg, 'core.bare', 'false', 'true');
    assert.equal(changed, true);
    assert.match(text, /bare = true/);
  });

  it('preserves CRLF line endings', () => {
    const cfg = TREELESS_CONFIG.replace(/\n/g, '\r\n');
    const { text, changed } = rewriteGitConfigValue(cfg, KEY, 'tree:0', 'blob:none');
    assert.equal(changed, true);
    assert.ok(text.includes('\r\n'), 'CRLF must survive');
    assert.doesNotMatch(text, /partialclonefilter = blob:none\r?\n.*\r?tree:0/);
    assert.match(text, /partialclonefilter = blob:none/);
  });

  it('never throws / never changes on malformed or empty input', () => {
    for (const cfg of ['', '   ', 'not a config at all', '[remote "origin"\npartialclonefilter', '[]']) {
      const { text, changed } = rewriteGitConfigValue(cfg, KEY, 'tree:0', 'blob:none');
      assert.equal(changed, false);
      assert.equal(text, cfg);
    }
  });

  it('ignores a malformed key (fewer than 2 dotted parts)', () => {
    const { changed } = rewriteGitConfigValue(TREELESS_CONFIG, 'partialclonefilter', 'tree:0', 'blob:none');
    assert.equal(changed, false, 'a bare key with no section is not a valid git config path');
  });

  it('skips commented-out keys (# / ; prefix)', () => {
    const cfg = '[remote "origin"]\n;\tpartialclonefilter = tree:0\n#\tpartialclonefilter = tree:0\n';
    const { changed } = rewriteGitConfigValue(cfg, KEY, 'tree:0', 'blob:none');
    assert.equal(changed, false, 'commented lines are not live keys');
  });
});

describe('applyGitConfigRepair — home resolution (best-effort, never throws)', () => {
  const HOME_ENV = 'MOLIO_TEST_GIT_HOME';
  const cfgFor = (over: Partial<NonNullable<ScriptInstallSource['repairGitConfig']>> = {}) =>
    ({
      afterStage: 'repository',
      repoRelPath: 'hermes-agent',
      homeEnv: HOME_ENV,
      defaultHome: { win32: '%MOLIO_TEST_NOWHERE%', posix: '%MOLIO_TEST_NOWHERE%' },
      key: 'remote.origin.partialclonefilter',
      fromValue: 'tree:0',
      toValue: 'blob:none',
      ...over,
    }) as NonNullable<ScriptInstallSource['repairGitConfig']>;

  const logs: string[] = [];
  const onEvent = (e: InstallEvent) => { if (e.type === 'log') logs.push((e as any).message); };

  it('rewrites the on-disk config when homeEnv points at the repo, leaving no tmp file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-gitrepair-'));
    const configPath = writeGitConfigFixture(dir, 'hermes-agent', TREELESS_CONFIG);
    try {
      logs.length = 0;
      applyGitConfigRepair({ [HOME_ENV]: dir } as NodeJS.ProcessEnv, cfgFor(), onEvent);
      assert.match(readFileSync(configPath, 'utf8'), /partialclonefilter = blob:none/);
      assert.equal(existsSync(`${configPath}.molio-repair.tmp`), false, 'atomic rename must clean the tmp');
      assert.ok(logs.some((m) => /set remote\.origin\.partialclonefilter = blob:none/.test(m)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a %VAR% default home when homeEnv is unset', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-gitrepair-'));
    const configPath = writeGitConfigFixture(dir, 'hermes-agent', TREELESS_CONFIG);
    try {
      logs.length = 0;
      const cfg = cfgFor({ homeEnv: undefined, defaultHome: { win32: '%MOLIO_TEST_GIT_HOME%', posix: '%MOLIO_TEST_GIT_HOME%' } });
      applyGitConfigRepair({ MOLIO_TEST_GIT_HOME: dir } as NodeJS.ProcessEnv, cfg, onEvent);
      assert.match(readFileSync(configPath, 'utf8'), /partialclonefilter = blob:none/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing config → logs a skip, does not throw, creates nothing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-gitrepair-'));
    try {
      logs.length = 0;
      applyGitConfigRepair({ [HOME_ENV]: dir } as NodeJS.ProcessEnv, cfgFor(), onEvent);
      assert.ok(logs.some((m) => /not found .* — skipping/i.test(m)));
      assert.equal(existsSync(path.join(dir, 'hermes-agent', '.git', 'config')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-treeless checkout → "nothing to do", file byte-identical', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-gitrepair-'));
    const blobless = TREELESS_CONFIG.replace('tree:0', 'blob:none');
    const configPath = writeGitConfigFixture(dir, 'hermes-agent', blobless);
    try {
      logs.length = 0;
      applyGitConfigRepair({ [HOME_ENV]: dir } as NodeJS.ProcessEnv, cfgFor(), onEvent);
      assert.equal(readFileSync(configPath, 'utf8'), blobless, 'fresh blob:none clones are untouched');
      assert.ok(logs.some((m) => /nothing to do/i.test(m)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installFromScript — repairGitConfig hook wiring', () => {
  const HOME_ENV = 'MOLIO_TEST_GIT_HOME';

  function stagedSourceWithRepair(overrides: Partial<ScriptInstallSource> = {}): ScriptInstallSource {
    return makeSource({
      stages: ['repository', 'products', 'complete'],
      repairGitConfig: {
        afterStage: 'repository',
        repoRelPath: 'hermes-agent',
        homeEnv: HOME_ENV,
        defaultHome: { win32: '%MOLIO_TEST_NOWHERE%', posix: '%MOLIO_TEST_NOWHERE%' },
        key: 'remote.origin.partialclonefilter',
        fromValue: 'tree:0',
        toValue: 'blob:none',
      },
      ...overrides,
    });
  }

  function withHomeEnv<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env[HOME_ENV];
    process.env[HOME_ENV] = dir;
    return fn().finally(() => {
      if (saved === undefined) delete process.env[HOME_ENV];
      else process.env[HOME_ENV] = saved;
    });
  }

  it('stamps blob:none AFTER the clone stage and BEFORE the products stage runs', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-gitrepair-'));
    const configPath = path.join(dir, 'hermes-agent', '.git', 'config');
    try {
      await withHomeEnv(dir, async () => {
        let seenByProducts = '';
        const deps = makeDeps({
          runScript: async (args) => {
            const stage = stageOf(args);
            if (stage === 'repository') {
              // Simulate the clone landing a legacy treeless checkout.
              writeGitConfigFixture(dir, 'hermes-agent', TREELESS_CONFIG);
            }
            // products is where hermes's convert_treeless_checkout would run —
            // it must observe the ALREADY-repaired filter.
            if (stage === 'products') seenByProducts = readFileSync(configPath, 'utf8');
            return OK_RESULT;
          },
        });

        const events = await run(deps, { source: stagedSourceWithRepair() });
        assert.ok(doneOf(events), 'git-config repair must not break the install');
        assert.match(seenByProducts, /partialclonefilter = blob:none/, 'repair must land before products runs');
        assert.doesNotMatch(seenByProducts, /tree:0/);
        assert.match(readFileSync(configPath, 'utf8'), /partialclonefilter = blob:none/);

        const repairLogs = events.filter(
          (e) => e.type === 'log' && /Git-config repair: set remote\.origin\.partialclonefilter/.test((e as any).message),
        );
        assert.equal(repairLogs.length, 1, 'hook must fire exactly once');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing config → warning log, install proceeds (best-effort hook)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-gitrepair-'));
    try {
      await withHomeEnv(dir, async () => {
        const events = await run(makeDeps(), { source: stagedSourceWithRepair() });
        assert.ok(events.some((e) => e.type === 'log' && /Git-config repair: not found/i.test((e as any).message)));
        assert.ok(doneOf(events), 'a missing config must never fail the install');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repairGitConfig WITHOUT stages never fires (hook requires the stage protocol)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-gitrepair-'));
    const configPath = writeGitConfigFixture(dir, 'hermes-agent', TREELESS_CONFIG);
    try {
      await withHomeEnv(dir, async () => {
        const source = makeSource({
          repairGitConfig: {
            afterStage: 'repository',
            repoRelPath: 'hermes-agent',
            homeEnv: HOME_ENV,
            defaultHome: { win32: '%MOLIO_TEST_NOWHERE%', posix: '%MOLIO_TEST_NOWHERE%' },
            key: 'remote.origin.partialclonefilter',
            fromValue: 'tree:0',
            toValue: 'blob:none',
          },
        });
        const captured: RunScriptArgs[] = [];
        const deps = makeDeps({ runScript: async (a) => { captured.push(a); return OK_RESULT; } });
        const events = await run(deps, { source });
        assert.equal(captured.length, 1, 'single full-ladder invocation');
        assert.equal(stageOf(captured[0]!), undefined, 'no stage flag in single-run mode');
        assert.match(readFileSync(configPath, 'utf8'), /tree:0/, 'hook must not fire without stages');
        assert.ok(doneOf(events));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveLockMirror — precedence and probe chain', () => {
  const samples = {
    githubUrl: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild/ffmpeg.zip',
    sha256: 'a'.repeat(64),
  };
  const logs: string[] = [];
  const onEvent = (e: InstallEvent) => { if (e.type === 'log') logs.push((e as any).message); };

  it('MOLIO_GITHUB_PROXY=off → null, no probing', async () => {
    let probed = 0;
    const mirror = await resolveLockMirror(
      { MOLIO_GITHUB_PROXY: 'off' },
      async () => { probed++; return true; },
      samples,
      onEvent,
    );
    assert.equal(mirror, null);
    assert.equal(probed, 0, 'explicit opt-out must short-circuit probing');
  });

  it('explicit MOLIO_GITHUB_PROXY → prefix mirror, trusted without probing, slash-trimmed', async () => {
    let probed = 0;
    const mirror = await resolveLockMirror(
      { MOLIO_GITHUB_PROXY: 'https://corp.proxy.example/' },
      async () => { probed++; return true; },
      samples,
      onEvent,
    );
    assert.deepEqual(mirror, { kind: 'prefix', base: 'https://corp.proxy.example' });
    assert.equal(probed, 0);
  });

  it('probe chain: first reachable GitHub proxy wins, probed with a REAL lockfile URL', async () => {
    const probedUrls: string[] = [];
    const mirror = await resolveLockMirror(
      {},
      async (url) => { probedUrls.push(url); return url.startsWith('https://gh-proxy.com'); },
      samples,
      onEvent,
    );
    assert.deepEqual(mirror, { kind: 'prefix', base: 'https://gh-proxy.com' });
    // ghfast.top probed first (with the sample URL appended), then gh-proxy.com.
    assert.equal(probedUrls[0], `https://ghfast.top/${samples.githubUrl}`);
    assert.equal(probedUrls[1], `https://gh-proxy.com/${samples.githubUrl}`);
    assert.equal(probedUrls.length, 2, 'must stop at the first reachable candidate');
  });

  it('all proxies down but upstream artifact mirror reachable → sha256 mode', async () => {
    const mirror = await resolveLockMirror(
      {},
      async (url) => url.startsWith('https://hermes-assets.nousresearch.com/upstream/sha256/'),
      samples,
      onEvent,
    );
    assert.deepEqual(mirror, {
      kind: 'sha256',
      base: 'https://hermes-assets.nousresearch.com/upstream/sha256',
    });
  });

  it('nothing reachable → null + a log telling the user how to override', async () => {
    const localLogs: string[] = [];
    const mirror = await resolveLockMirror(
      {},
      async () => false,
      samples,
      (e) => { if (e.type === 'log') localLogs.push(e.message); },
    );
    assert.equal(mirror, null);
    assert.ok(localLogs.some((m) => /keeping upstream download URLs/i.test(m) && /MOLIO_GITHUB_PROXY/.test(m)));
  });

  it('no samples → nothing to probe with, returns null without hanging', async () => {
    let probed = 0;
    const mirror = await resolveLockMirror({}, async () => { probed++; return true; }, {}, onEvent);
    assert.equal(mirror, null);
    assert.equal(probed, 0);
  });
});

describe('rewriteLockfileMirrors — prefix mode', () => {
  it('rewrites github + raw.githubusercontent + nodejs dist; leaves npm/docker/sha256 alone', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-rewrite-'));
    const lockPath = writeLockFixture(dir);
    try {
      const { rewritten } = rewriteLockfileMirrors(lockPath, { kind: 'prefix', base: 'https://ghfast.top' });
      // ffmpeg github (1) + node dist (1) + iron-proxy list (2) = 4; npm + docker untouched.
      assert.equal(rewritten, 4);

      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      assert.equal(
        lock.packages.ffmpeg.artifacts['win32-x64'].url,
        'https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild/ffmpeg.zip',
      );
      assert.equal(
        lock.packages.node.artifacts['win32-x64'].url,
        'https://registry.npmmirror.com/-/binary/node/v26.7.0/node-v26.7.0-win-x64.zip',
      );
      assert.equal(
        lock.packages['iron-proxy'].artifacts['win32-x64'][0].url,
        'https://ghfast.top/https://raw.githubusercontent.com/paradigmxyz/iron-proxy/main/public-key.asc',
      );
      assert.equal(
        lock.packages['agent-browser'].artifacts.any.url,
        'https://registry.npmjs.org/agent-browser/-/agent-browser-0.26.0.tgz',
        'npm registry URLs have their own mirror mechanism — untouched',
      );
      assert.match(lock.packages['termux-docker'].artifacts.docker.url, /^docker:\/\//);
      // sha256 pins = integrity anchor, never modified.
      assert.equal(lock.packages.ffmpeg.artifacts['win32-x64'].sha256, 'a'.repeat(64));
      assert.equal(lock.packages.node.artifacts['win32-x64'].sha256, 'b'.repeat(64));
      assert.equal(existsSync(`${lockPath}.molio-mirror.tmp`), false, 'atomic write must not leave the tmp behind');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second pass rewrites nothing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-rewrite-'));
    const lockPath = writeLockFixture(dir);
    try {
      const first = rewriteLockfileMirrors(lockPath, { kind: 'prefix', base: 'https://ghfast.top' });
      const afterFirst = readFileSync(lockPath, 'utf8');
      const second = rewriteLockfileMirrors(lockPath, { kind: 'prefix', base: 'https://ghfast.top' });
      assert.ok(first.rewritten > 0);
      assert.equal(second.rewritten, 0);
      assert.equal(readFileSync(lockPath, 'utf8'), afterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rewriteLockfileMirrors — sha256 mode', () => {
  it('rewrites every pinned http(s) URL to <base>/<sha256>; docker and unpinned untouched', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-rewrite-'));
    const lockPath = writeLockFixture(dir);
    try {
      const { rewritten } = rewriteLockfileMirrors(lockPath, {
        kind: 'sha256',
        base: 'https://hermes-assets.nousresearch.com/upstream/sha256',
      });
      // ffmpeg + node + npm + iron-proxy list (2) = 5; docker:// has no valid pin.
      assert.equal(rewritten, 5);

      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      assert.equal(
        lock.packages.ffmpeg.artifacts['win32-x64'].url,
        `https://hermes-assets.nousresearch.com/upstream/sha256/${'a'.repeat(64)}`,
      );
      assert.equal(
        lock.packages['agent-browser'].artifacts.any.url,
        `https://hermes-assets.nousresearch.com/upstream/sha256/${'c'.repeat(64)}`,
      );
      assert.match(lock.packages['termux-docker'].artifacts.docker.url, /^docker:\/\//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rewriteLockfileMirrors — malformed input (never throws)', () => {
  it('bad JSON → rewritten 0, file byte-identical', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-rewrite-'));
    const lockPath = path.join(dir, 'lock.json');
    writeFileSync(lockPath, 'not json {{{', 'utf8');
    try {
      const { rewritten } = rewriteLockfileMirrors(lockPath, { kind: 'prefix', base: 'https://ghfast.top' });
      assert.equal(rewritten, 0);
      assert.equal(readFileSync(lockPath, 'utf8'), 'not json {{{');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing file → rewritten 0', () => {
    const { rewritten } = rewriteLockfileMirrors(
      path.join(os.tmpdir(), 'molio-definitely-missing-lock.json'),
      { kind: 'prefix', base: 'https://ghfast.top' },
    );
    assert.equal(rewritten, 0);
  });

  it('BOM-prefixed JSON is parsed (installer reads locks with utf-8-sig)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-rewrite-'));
    const lockPath = writeLockFixture(dir);
    writeFileSync(lockPath, `﻿${readFileSync(lockPath, 'utf8')}`, 'utf8');
    try {
      const { rewritten } = rewriteLockfileMirrors(lockPath, { kind: 'prefix', base: 'https://ghfast.top' });
      assert.equal(rewritten, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyLockfileMirror — home resolution (best-effort, never throws)', () => {
  const cfgFor = (rel: string): NonNullable<ScriptInstallSource['mirrorLockfile']> => ({
    afterStage: 'repository',
    relPath: rel,
    homeEnv: 'MOLIO_TEST_HERMES_HOME2',
    defaultHome: { win32: '%MOLIO_TEST_HOME_EXPANDED%\\hermes', posix: '%MOLIO_TEST_HOME_EXPANDED%/hermes' },
  });

  it('homeEnv wins when set', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-applymirror-'));
    const lockPath = writeLockFixture(dir);
    const logs: string[] = [];
    try {
      await applyLockfileMirror(
        { MOLIO_TEST_HERMES_HOME2: dir, MOLIO_GITHUB_PROXY: 'https://ghfast.top' },
        cfgFor(path.join('pm', 'lock.json')),
        async () => true,
        (e) => { if (e.type === 'log') logs.push(e.message); },
      );
      assert.match(readFileSync(lockPath, 'utf8'), /ghfast\.top/);
      assert.ok(logs.some((m) => /Rewrote \d+ lockfile/.test(m)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaultHome %VAR% expansion when homeEnv is unset', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'molio-applymirror-'));
    // defaultHome expands to `<dir>\hermes` (win32) / `<dir>/hermes` (posix)
    // via %MOLIO_TEST_HOME_EXPANDED% — the fixture must sit exactly there.
    const lockPath = writeLockFixture(path.join(dir, 'hermes'));
    try {
      await applyLockfileMirror(
        { MOLIO_TEST_HOME_EXPANDED: dir, MOLIO_GITHUB_PROXY: 'https://ghfast.top' },
        cfgFor(path.join('pm', 'lock.json')),
        async () => true,
        () => {},
      );
      assert.match(readFileSync(lockPath, 'utf8'), /ghfast\.top/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unreadable/missing paths degrade to a warning — never throws', async () => {
    const logs: string[] = [];
    await applyLockfileMirror(
      {},
      cfgFor(path.join('pm', 'lock.json')),
      async () => true,
      (e) => { if (e.type === 'log') logs.push(e.message); },
    );
    assert.ok(logs.some((m) => /lockfile not found|skipped/i.test(m)));
  });
});
