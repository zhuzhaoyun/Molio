/**
 * Regression test for: the OSS upload step dies with SecurityTokenExpired.
 *
 * Root cause (run 36685374706): the step uploaded assets ONE AT A TIME, which
 * took ~60 minutes for ~340MB (GitHub's US runners → Guangzhou OSS ≈ 95KB/s per
 * stream). The STS session issued by scripts/sts_oidc.py lasts 3600s, so the
 * token expired mid-upload — 5 of 8 assets landed and the 6th failed with
 * `403 SecurityTokenExpired`. The job died, so latest.json / latest*.yml were
 * never rewritten and v0.3.59 never reached users.
 *
 * Fix: scripts/upload-release-assets.sh fans the transfers out (bounded
 * concurrency) and exits non-zero if any of them fails, so the caller aborts
 * before advertising a version whose files never landed.
 *
 * Don't read the token expiry as the root cause, though. It is the proximate
 * one: the same three big files moved at 16694KB/s on 09-18 (v0.3.56, 20s) and
 * at 67-121KB/s on 09-24 (v0.3.58) with no repo change in between, i.e. the
 * runner→Guangzhou OSS path lost ~170x and dragged the upload past the 1h
 * token. Parallelism only helps if that throttle is per-connection, which is
 * why the script reports aggregate vs per-stream throughput.
 *
 * This test runs the real script against a stub `ossutil` — it drives the
 * actual control flow (concurrency, failure aggregation) instead of
 * pattern-matching script text. Skipped where bash is unavailable (Windows).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const scriptPath = path.resolve(
  import.meta.dirname,
  '../../../scripts/upload-release-assets.sh'
);

const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0;

/** Stub ossutil: logs START/DONE/FAIL per transfer, sleeps so overlap is observable. */
const STUB_OSSUTIL = `#!/usr/bin/env bash
dest=""
for arg in "$@"; do
  case "$arg" in
    oss://*) dest="$arg" ;;
  esac
done
echo "START \${dest}" >> "\${STUB_LOG}"
sleep "\${STUB_SLEEP:-0.3}"
if [ -n "\${STUB_FAIL_MATCH:-}" ]; then
  case "\${dest}" in
    *"\${STUB_FAIL_MATCH}"*)
      echo "FAIL \${dest}" >> "\${STUB_LOG}"
      exit 1
      ;;
  esac
fi
echo "DONE \${dest}" >> "\${STUB_LOG}"
`;

function makeSandbox({ assets = 3 } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'oss-upload-'));
  const assetDir = path.join(root, 'release-assets');
  const binDir = path.join(root, 'bin');
  mkdirSync(assetDir);
  mkdirSync(binDir);
  for (let i = 0; i < assets; i++) {
    writeFileSync(path.join(assetDir, `asset-${i}.bin`), `payload ${i}`);
  }
  const ossutil = path.join(binDir, 'ossutil');
  writeFileSync(ossutil, STUB_OSSUTIL);
  chmodSync(ossutil, 0o755);
  return { root, assetDir, log: path.join(root, 'ossutil.log') };
}

function runScript(sandbox, env = {}) {
  const { TAG = 'v0.3.59', ...rest } = env;
  return spawnSync('bash', [scriptPath, sandbox.assetDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(sandbox.root, 'bin')}:${process.env.PATH}`,
      STUB_LOG: sandbox.log,
      TAG,
      OSS_BUCKET: 'test-bucket',
      OSS_ENDPOINT: 'oss-test.aliyuncs.com',
      OSS_ACCESS_KEY_ID: 'test-id',
      OSS_ACCESS_KEY_SECRET: 'test-secret',
      OSS_SECURITY_TOKEN: 'test-token',
      ...rest,
    },
  });
}

function readLog(sandbox) {
  try {
    return readFileSync(sandbox.log, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Peak number of transfers in flight at the same time. */
function peakConcurrency(lines) {
  let inFlight = 0;
  let peak = 0;
  for (const line of lines) {
    if (line.startsWith('START')) inFlight++;
    else inFlight--;
    peak = Math.max(peak, inFlight);
  }
  return peak;
}

describe('scripts/upload-release-assets.sh', { skip: !bashAvailable }, () => {
  it('uploads every asset and exits 0', () => {
    const sandbox = makeSandbox({ assets: 3 });
    const result = runScript(sandbox);

    assert.equal(result.status, 0, result.stderr);
    const done = readLog(sandbox).filter((line) => line.startsWith('DONE'));
    assert.equal(done.length, 3);
    assert.ok(done.every((line) => line.includes('/releases/v0.3.59/')));
  });

  it('overlaps transfers instead of uploading one at a time', () => {
    const sandbox = makeSandbox({ assets: 6 });
    const result = runScript(sandbox);

    assert.equal(result.status, 0, result.stderr);
    // Serial uploads would peak at 1 — that is the bug this guards against.
    assert.ok(
      peakConcurrency(readLog(sandbox)) >= 2,
      'expected concurrent transfers; the upload is serial again'
    );
  });

  it('stays correct when concurrency is dialled down to 1', () => {
    // OSS_UPLOAD_PARALLEL=1 empties the pid window on every asset. Slicing the
    // array to nothing used to crash bash 3.2 (macOS /bin/bash) with
    // "pids[@]: unbound variable", killing the release after the upload had
    // already started — keep this pinned so the guard can't be "simplified" away.
    const sandbox = makeSandbox({ assets: 3 });
    const result = runScript(sandbox, { OSS_UPLOAD_PARALLEL: '1' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readLog(sandbox).filter((line) => line.startsWith('DONE')).length, 3);
    assert.equal(peakConcurrency(readLog(sandbox)), 1);
  });

  it('exits non-zero when a transfer fails, so the caller skips the channel pointers', () => {
    const sandbox = makeSandbox({ assets: 3 });
    const result = runScript(sandbox, { STUB_FAIL_MATCH: 'asset-1.bin' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /At least one asset upload failed/);
    // The failure must be reported, not swallowed by a bare `wait`.
    assert.equal(readLog(sandbox).filter((line) => line.startsWith('FAIL')).length, 1);
  });

  it('reports per-asset and aggregate throughput', () => {
    // The runner→Guangzhou leg collapsed ~170x between v0.3.56 and v0.3.58 with
    // no repo change, so "is the throttle per-connection or link-wide?" has to
    // be answerable from the log alone: per-connection means the aggregate rate
    // scales with OSS_UPLOAD_PARALLEL and fanning out is the fix; link-wide
    // means the aggregate stays flat and parallelism buys nothing.
    const sandbox = makeSandbox({ assets: 3 });
    const result = runScript(sandbox);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /asset-0\.bin\s+\d+ KB\s+\d+s\s+\d+ KB\/s\s+OK/,
      'per-asset line should carry size, elapsed and effective rate'
    );
    assert.match(
      result.stdout,
      /Total: 3 assets, \d+ KB in \d+s → aggregate \d+ KB\/s \(parallel=4, \d+ KB\/s per stream\)/,
      'aggregate line is what distinguishes a per-connection throttle from a link-wide one'
    );
  });

  it('refuses to upload when the release tag is missing', () => {
    const sandbox = makeSandbox({ assets: 1 });
    const result = runScript(sandbox, { TAG: '' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /TAG is required/);
    assert.equal(readLog(sandbox).length, 0);
  });
});
