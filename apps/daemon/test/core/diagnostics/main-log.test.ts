import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  readLogTail,
  parseDaemonExits,
  summarizeDaemonExits,
  parseUpdaterStatus,
  parseWatchFailures,
} from '../../../src/core/diagnostics/main-log.js';
import type { DaemonExit } from '../../../src/core/diagnostics/main-log.js';
import {
  EXIT_OK,
  EXIT_KILLED,
  TASKKILL,
  EXIT_1,
  UPD_FAIL,
  UPD_OK,
  UPD_AVAIL,
  START,
  WATCH_FAIL,
} from './fixtures.js';

/**
 * 主进程日志纯解析函数的单测：
 * 夹具见 ./fixtures.ts（真实日志格式），这里只验证「日志行 → 结构化事实」。
 */

const dirs: string[] = [];

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'molio-mainlog-test-'));
  dirs.push(d);
  return d;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('readLogTail', () => {
  it('文件不存在返回空数组', () => {
    const tmp = makeTmpDir();
    assert.deepEqual(readLogTail(join(tmp, 'nope.log'), 10), []);
  });

  it('只保留最后 N 行', () => {
    const tmp = makeTmpDir();
    const file = join(tmp, 'main.log');
    writeFileSync(file, 'l1\nl2\nl3\nl4\nl5\n', 'utf-8');
    assert.deepEqual(readLogTail(file, 2), ['l4', 'l5']);
    // N 大于总行数时全量返回；末尾换行不算多一行
    assert.deepEqual(readLogTail(file, 10), ['l1', 'l2', 'l3', 'l4', 'l5']);
  });
});

describe('parseDaemonExits', () => {
  it('code=0 是 normal，其他是 abnormal', () => {
    const [a, b] = parseDaemonExits([EXIT_OK, EXIT_KILLED]);
    assert.equal(a?.kind, 'normal');
    assert.equal(b?.kind, 'abnormal');
    assert.equal(b?.code, '3758096392');
    assert.equal(b?.at, Date.parse('2026-11-23T07:39:02.508Z'));
  });

  it('force taskkill 之后 5 行内的 code=1 是 forced', () => {
    assert.equal(parseDaemonExits([TASKKILL, EXIT_1])[0]?.kind, 'forced');
  });
});

describe('summarizeDaemonExits', () => {
  it('按 24 小时 / 7 天窗口计数', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    const exits: DaemonExit[] = [
      { at: Date.parse('2026-11-20T07:39:02.508Z'), code: '3758096392', signal: null, kind: 'abnormal' },
      { at: Date.parse('2026-11-23T07:39:02.508Z'), code: '3758096392', signal: null, kind: 'abnormal' },
      { at: Date.parse('2026-11-23T09:00:00.000Z'), code: '1', signal: null, kind: 'forced' },
    ];
    assert.deepEqual(summarizeDaemonExits(exits, now), {
      abnormal24h: 1,
      abnormal7d: 2,
      forced24h: 1,
      lastAbnormalAt: Date.parse('2026-11-23T07:39:02.508Z'),
      lastAbnormalCodes: ['3758096392'],
    });
  });
});

describe('parseUpdaterStatus', () => {
  it('没有更新日志 → none', () => {
    assert.equal(parseUpdaterStatus([START]).state, 'none');
  });

  it('成功会清零连续失败计数', () => {
    const s = parseUpdaterStatus([UPD_FAIL, UPD_FAIL, UPD_OK]);
    assert.equal(s.state, 'ok');
    assert.equal(s.consecutiveFailures, 0);
  });

  it('失败累计并保留最后一次错误', () => {
    const s = parseUpdaterStatus([UPD_OK, UPD_FAIL, UPD_FAIL]);
    assert.equal(s.state, 'failed');
    assert.equal(s.consecutiveFailures, 2);
    assert.equal(s.lastError, 'net::ERR_NAME_NOT_RESOLVED');
  });

  it('发现可用更新后即使检查失败仍是 available', () => {
    const s = parseUpdaterStatus([UPD_AVAIL, UPD_FAIL]);
    assert.equal(s.state, 'available');
    assert.equal(s.availableVersion, '0.4.8');
  });
});

describe('parseWatchFailures', () => {
  it('只取本次启动（最后一行 Starting daemon 之后）的监听失败', () => {
    assert.deepEqual(parseWatchFailures([WATCH_FAIL, START]), []);
    assert.deepEqual(parseWatchFailures([START, WATCH_FAIL]), [
      {
        vaultId: '3edb6697-1',
        path: '/Volumes/My Passport/demo',
        error: "ENOENT: no such file or directory, watch '/Volumes/My Passport/demo'",
      },
    ]);
  });
});
