import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isKillablePortOccupant } from '../../src/core/port-check.js';

/**
 * 测试端口占用检测逻辑的判断规则
 *
 * 场景：daemon 启动前检测端口是否被占用
 * - node/tsx 或打包后的 Molio.exe / electron.exe（以 ELECTRON_RUN_AS_NODE
 *   跑 daemon）→ 自动杀掉（可能是上次没退出的 daemon）
 * - 其他进程 → 报错退出（避免误杀用户软件）
 *
 * 回归：打包后 daemon 是用 Molio.exe 跑的，旧的 isNodeProcess 只认
 * node/tsx，导致残留的 daemon 被当成"非 Node 进程"拒绝清理，
 * daemon 直接 process.exit(1)，应用卡在 splash（见 desktop 错误页修复）。
 */
describe('port occupant detection', () => {
  const killable = [
    'node.exe                    12345  Console                    1    100,000 K',
    'node',
    'tsx',
    'NODE.EXE',
    'Molio.exe                   67890  Console                    1     80,000 K',
    'molio.exe',
    'electron.exe                11111  Console                    1    120,000 K',
    'ELECTRON.EXE',
  ];

  const nonKillable = [
    'chrome.exe',
    'Code.exe',
    'nginx.exe',
    'java',
    'python.exe',
    'docker-proxy',
  ];

  it('should identify killable processes (node/tsx/molio/electron)', () => {
    for (const name of killable) {
      assert.strictEqual(
        isKillablePortOccupant(name),
        true,
        `"${name}" should be identified as a killable stale daemon`
      );
    }
  });

  it('should identify non-killable processes', () => {
    for (const name of nonKillable) {
      assert.strictEqual(
        isKillablePortOccupant(name),
        false,
        `"${name}" should NOT be identified as a killable process`
      );
    }
  });

  it('should be case-insensitive', () => {
    assert.strictEqual(isKillablePortOccupant('MOLIO.EXE'), true);
    assert.strictEqual(isKillablePortOccupant('Electron.exe'), true);
    assert.strictEqual(isKillablePortOccupant('NODE'), true);
  });

  it('should parse PID from Windows netstat output', () => {
    const outputs = [
      '  TCP    0.0.0.0:3100           0.0.0.0:0              LISTENING       12345\r\n',
      'TCP    [::]:3100              [::]:0                 LISTENING       67890',
      '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       11111\r\n  TCP    [::]:5173              [::]:0                 LISTENING       11111',
    ];

    const expectedPids = [12345, 67890, 11111];

    outputs.forEach((output, i) => {
      const match = output.match(/\s+(\d+)\s*$/m);
      assert.ok(match, `Should match PID in output ${i}`);
      assert.strictEqual(Number(match[1]), expectedPids[i], `PID should be ${expectedPids[i]}`);
    });
  });

  it('should parse PID from Unix lsof output', () => {
    const outputs = [
      '12345\n',
      '67890',
      '11111\n22222\n', // 多个进程，取第一个
    ];

    const expectedPids = [12345, 67890, 11111];

    outputs.forEach((output, i) => {
      const match = output.match(/\d+/);
      assert.ok(match, `Should match PID in output ${i}`);
      assert.strictEqual(Number(match[0]), expectedPids[i], `PID should be ${expectedPids[i]}`);
    });
  });
});
