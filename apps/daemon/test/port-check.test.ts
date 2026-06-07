import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * 测试端口占用检测逻辑的判断规则
 *
 * 场景：daemon 启动前检测端口是否被占用
 * - Node/tsx 进程 → 自动杀掉（可能是上次没退出的 daemon）
 * - 其他进程 → 报错退出（避免误杀用户软件）
 */
describe('port occupant detection', () => {
  it('should identify Node process as killable', () => {
    const processNames = [
      'node.exe                    12345  Console                    1    100,000 K',
      'node',
      'tsx',
      'NODE.EXE',
    ];

    for (const name of processNames) {
      const isNodeProcess = name.toLowerCase().includes('node') ||
                            name.toLowerCase().includes('tsx');
      assert.strictEqual(isNodeProcess, true, `"${name}" should be identified as Node process`);
    }
  });

  it('should identify non-Node process as non-killable', () => {
    const processNames = [
      'chrome.exe',
      'Code.exe',
      'nginx.exe',
      'java',
      'python',
      'docker-proxy',
    ];

    for (const name of processNames) {
      const isNodeProcess = name.toLowerCase().includes('node') ||
                            name.toLowerCase().includes('tsx');
      assert.strictEqual(isNodeProcess, false, `"${name}" should NOT be identified as Node process`);
    }
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
