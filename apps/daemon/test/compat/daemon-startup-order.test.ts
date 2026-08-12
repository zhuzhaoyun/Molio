import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Regression: first launch after packaging showed "后端服务启动失败" because
 * index.ts ran heavy synchronous startup chores (run-log prune sweep over
 * hundreds of run dirs + per-vault skill fan-out ≈ 1.2s/vault) BEFORE binding
 * the HTTP port. The desktop shell gates readiness on the daemon's stdout
 * "listening on" line with a fixed timeout, so the daemon was declared dead
 * while it was actually seconds away from ready (a restart "fixed" it because
 * the second launch had nothing to prune/sync).
 *
 * These static checks pin the ordering contract: bind first, defer the chores
 * (and use the async variants so they don't monopolize the event loop after
 * binding either).
 */

// Tests run from the package root (apps/daemon) with source in src/ — resolve
// against cwd, not import.meta.url (which points into dist/ after tsc).
const indexTs = readFileSync(path.resolve(process.cwd(), 'src', 'index.ts'), 'utf-8');

describe('daemon startup order: HTTP listen must precede heavy chores', () => {
  it('calls every heavy chore exactly once, only inside runDeferredStartupChores', () => {
    const choresFnStart = indexTs.indexOf('async function runDeferredStartupChores');
    assert.ok(choresFnStart !== -1, 'runDeferredStartupChores must exist');
    assert.ok(indexTs.includes('startServer();'), 'top-level startServer() call must exist');

    // Each heavy chore appears exactly once in the whole file — inside the
    // deferred function — and nowhere else (i.e. no top-level pre-listen call).
    for (const call of [
      'pruneRunLogsAsync(',
      'reconcileAllVaultsAsync(',
      'cleanupLegacyGlobalSync(',
      'preloadManager.checkSkills(',
    ]) {
      const count = indexTs.split(call).length - 1;
      assert.equal(count, 1, `${call} must be called exactly once at startup`);
      const pos = indexTs.indexOf(call);
      assert.ok(pos > choresFnStart, `${call} must live inside runDeferredStartupChores`);
    }
  });

  it('invokes the deferred chores only after the "listening on" line', () => {
    const listeningPos = indexTs.indexOf('listening on');
    const invokePos = indexTs.indexOf('runDeferredStartupChores().catch');
    assert.ok(listeningPos !== -1, 'the listening log line must exist');
    assert.ok(invokePos !== -1, 'deferred chores must be invoked');
    assert.ok(
      invokePos > listeningPos,
      'chores must be invoked after the "listening on" line is printed ' +
        '(the desktop shell resolves daemon readiness on that stdout line)',
    );
  });

  it('does not call the blocking sync variants at startup', () => {
    assert.ok(
      !indexTs.includes('pruneRunLogs();'),
      'sync pruneRunLogs() blocks the event loop for the whole sweep — use pruneRunLogsAsync',
    );
    assert.ok(
      !/\breconcileAllVaults\(/.test(indexTs),
      'sync reconcileAllVaults() blocks the event loop for the whole fan-out — use reconcileAllVaultsAsync',
    );
  });

  it('schedules the deferred chores from the listening callback', () => {
    assert.ok(
      /listening on[\s\S]{0,400}setImmediate\(/.test(indexTs),
      'chores must be scheduled right after the "listening on" line is printed ' +
        '(the desktop shell resolves readiness on that stdout line)',
    );
  });

  it('still seeds the skill library before listen', () => {
    // Fast and correctness-sensitive: routes must never observe an unseeded
    // skills table. (The feishu frame used to be materialized to a
    // sysprompt file here too, but #210 moved it onto the first message,
    // so there is nothing else to do pre-listen.)
    const listenPos = indexTs.indexOf('startServer();');
    const seedPos = indexTs.indexOf('initSkillLibrary(db)');
    assert.ok(seedPos !== -1 && seedPos < listenPos, 'initSkillLibrary must precede listen');
    assert.ok(
      !indexTs.includes('ensureWikiSysPromptFiles'),
      'the sysprompt-file channel was removed in #210 (feishu frame rides the first message) — no pre-listen materialization',
    );
  });
});
