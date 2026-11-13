import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  probeVersion,
  probeVersionAsync,
  quoteForCmd,
  quoteArgForCmd,
  shellCommandFor,
  resolveAgentBinaryCandidates,
  resolveAgentBinaryCandidatesAsync,
  pickFirstWorkingCandidate,
  pickFirstWorkingCandidateAsync,
  type BinaryCandidate,
} from '../../src/core/runtimes/launch.js';

/**
 * 错误驱动测试：Windows `.cmd` shim + 带空格路径 + `shell: true` 未加引号。
 *
 * 症状：daemon 报「Claude Code 未安装」，但用户明明装了。
 *
 * 根因（docs/windows-runtime-detection-fix.md）：
 *   Bug 1（致命）：`.cmd` 需要 `shell: true`，Node 拼成
 *     `cmd.exe /d /s /c "C:\Program Files\nodejs\claude.cmd --version"`，
 *     cmd 的 `/s` 剥掉最外层引号后按第一个空格断词 → 执行 `C:\Program` → 失败。
 *     即：任何带空格路径下的 `.cmd`/`.bat` shim 都探测失败。
 *   Bug 2（放大器）：只探第一个候选就判「未安装」，不回退到后面的健康副本
 *     （`~/.molio/bin/claude.exe`）。
 *
 * 修复：binary 路径加引号（quoteForCmd）+ 候选列表逐个探测直到成功。
 */

const isWin = process.platform === 'win32';

/** 造一个「路径带空格」的临时目录（Bug 1 的触发条件）。 */
function makeSpacedDir(prefix: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-cmd-'));
  const dir = path.join(base, `${prefix} with space`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造一个可执行的 `.cmd` shim，打印固定版本号。 */
function writeCmdShim(dir: string, name: string, version: string): string {
  const file = path.join(dir, `${name}.cmd`);
  // @echo off 抑制 cmd 的命令回显，只留版本号
  fs.writeFileSync(file, `@echo off\r\necho ${version}\r\n`, 'utf8');
  return file;
}

describe('Windows .cmd 引号修复（错误驱动）', () => {
  it('quoteForCmd 给路径加双引号并转义内部引号', () => {
    assert.equal(quoteForCmd('C:\\Program Files\\nodejs\\claude.cmd'),
      '"C:\\Program Files\\nodejs\\claude.cmd"');
    assert.equal(quoteForCmd('C:\\a"b\\c.cmd'), '"C:\\a""b\\c.cmd"');
    // 不含空格的路径也要加引号（统一处理，避免分支遗漏）
    assert.equal(quoteForCmd('C:\\tools\\claude.exe'), '"C:\\tools\\claude.exe"');
  });

  it('shellCommandFor 对 binary 与含空格的参数都加引号', () => {
    const cmd = shellCommandFor('C:\\Program Files\\nodejs\\claude.cmd', ['--version']);
    assert.equal(cmd, '"C:\\Program Files\\nodejs\\claude.cmd" --version');

    const withSpaceArg = shellCommandFor('C:\\a b\\c.cmd', ['--flag', 'hello world']);
    assert.equal(withSpaceArg, '"C:\\a b\\c.cmd" --flag "hello world"');
  });

  it('带空格路径下的 .cmd shim 能探测出版本（修复前必失败）', () => {
    if (!isWin) return; // 仅 Windows 相关

    const dir = makeSpacedDir('molio probe');
    const shim = writeCmdShim(dir, 'fake-agent', '1.2.3');

    const result = probeVersion(shim, ['--version']);
    assert.equal(result.error, undefined, `探测不该报错，实际：${result.error}`);
    assert.equal(result.version, '1.2.3');
  });

  it('带空格路径下的 .cmd shim 能异步探测出版本', async () => {
    if (!isWin) return;

    const dir = makeSpacedDir('molio probe async');
    const shim = writeCmdShim(dir, 'fake-agent-async', '4.5.6');

    const result = await probeVersionAsync(shim, ['--version']);
    assert.equal(result.error, undefined, `探测不该报错，实际：${result.error}`);
    assert.equal(result.version, '4.5.6');
  });

  it('探测失败时返回 error 而不是抛异常（坏 shim 不炸探测链路）', () => {
    if (!isWin) return;

    const dir = makeSpacedDir('molio probe bad');
    const shim = path.join(dir, 'broken.cmd');
    fs.writeFileSync(shim, '@echo off\r\nexit /b 1\r\n', 'utf8');

    const result = probeVersion(shim, ['--version']);
    assert.equal(result.version, null);
    assert.ok(result.error, '探测失败必须带 error 供诊断');
  });
});

describe('候选回退：坏 shim 不再遮蔽好二进制（错误驱动）', () => {
  it('候选列表保留全部 PATH 命中，而不是只留第一个', () => {
    // 用一个必定不存在的名字，避免依赖本机 PATH 的具体内容
    const candidates = resolveAgentBinaryCandidates(
      { id: 'definitely-not-a-real-agent-xyz', bin: 'definitely-not-a-real-agent-xyz' } as never,
    );
    assert.ok(Array.isArray(candidates));
    // 没有命中时是空列表（而不是塞一个假路径）
    assert.equal(candidates.length, 0);
  });

  it('候选列表去重：同一路径只出现一次', () => {
    const dir = makeSpacedDir('molio dedupe');
    const shim = writeCmdShim(dir, 'dup-agent', '9.9.9');
    const def = {
      id: 'dupagent',
      bin: 'dup-agent',
      fallbackBins: [],
      versionArgs: ['--version'],
    } as never;

    // 把同一个目录同时作为 PATH 命中与 well-known 命中注入不了，
    // 这里退而验证：候选列表里同一路径不重复（用 env-override 场景验证去重逻辑）
    const candidates = resolveAgentBinaryCandidates(def, {
      configuredEnv: { DUPAGENT_BIN: shim },
    });
    const dupCount = candidates.filter((c) => c.binary === shim).length;
    assert.equal(dupCount, 1, '同一路径不应重复出现');
  });

  it('env-override 排在候选列表首位', () => {
    const dir = makeSpacedDir('molio env first');
    const shim = writeCmdShim(dir, 'env-agent', '1.0.0');
    const def = {
      id: 'envagent',
      bin: 'env-agent',
      fallbackBins: [],
      versionArgs: ['--version'],
    } as never;

    const candidates = resolveAgentBinaryCandidates(def, {
      configuredEnv: { ENVAGENT_BIN: shim },
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.binary, shim);
    assert.equal(candidates[0]!.source, 'env-override');
  });

  it('异步候选解析与同步版一致（都保留 env-override 首位）', async () => {
    const dir = makeSpacedDir('molio env async');
    const shim = writeCmdShim(dir, 'env-agent-async', '1.0.0');
    const def = {
      id: 'envagentasync',
      bin: 'env-agent-async',
      fallbackBins: [],
      versionArgs: ['--version'],
    } as never;

    const candidates = await resolveAgentBinaryCandidatesAsync(def, {
      configuredEnv: { ENVAGENTASYNC_BIN: shim },
    });
    assert.equal(candidates[0]!.binary, shim);
    assert.equal(candidates[0]!.source, 'env-override');
  });
});

describe('候选选择：探测失败就换下一个（Bug 2 的核心行为）', () => {
  /** 造一组候选（不落盘——探测函数是注入的替身）。 */
  const cands = (...paths: string[]): BinaryCandidate[] =>
    paths.map((binary) => ({ binary, source: 'path' as const }));

  it('第一个候选探测成功时选它', () => {
    const picked = pickFirstWorkingCandidate(
      cands('C:\\a\\claude.cmd', 'C:\\b\\claude.exe'),
      ['--version'],
      (bin) => ({ version: bin === 'C:\\a\\claude.cmd' ? '1.0.0' : null }),
    );
    assert.equal(picked?.candidate.binary, 'C:\\a\\claude.cmd');
    assert.equal(picked?.version, '1.0.0');
  });

  it('第一个候选探测失败时回退到第二个（这正是「误报未安装」的修复点）', () => {
    const picked = pickFirstWorkingCandidate(
      cands('C:\\Program Files\\nodejs\\claude.cmd', 'C:\\Users\\me\\.molio\\bin\\claude.exe'),
      ['--version'],
      (bin) => (bin.endsWith('.exe')
        ? { version: '2.1.316 (Claude Code)' }
        : { version: null, error: "'C:\\Program' 不是内部或外部命令" }),
    );
    assert.equal(picked?.candidate.binary, 'C:\\Users\\me\\.molio\\bin\\claude.exe');
    assert.equal(picked?.version, '2.1.316 (Claude Code)');
    assert.equal(picked?.error, undefined, '选中的候选不应带失败信息');
  });

  it('全部候选失败时返回首个候选及其错误（供 UI 显示「为什么不能用」）', () => {
    const picked = pickFirstWorkingCandidate(
      cands('C:\\first\\claude.cmd', 'C:\\second\\claude.cmd'),
      ['--version'],
      (bin) => ({ version: null, error: `boom: ${bin}` }),
    );
    assert.equal(picked?.candidate.binary, 'C:\\first\\claude.cmd');
    assert.equal(picked?.version, null);
    assert.equal(picked?.error, 'boom: C:\\first\\claude.cmd');
  });

  it('候选列表为空时返回 null', () => {
    assert.equal(pickFirstWorkingCandidate([], ['--version'], () => ({ version: 'x' })), null);
  });

  it('异步版与同步版行为一致', async () => {
    const picked = await pickFirstWorkingCandidateAsync(
      cands('C:\\bad\\claude.cmd', 'C:\\good\\claude.exe'),
      ['--version'],
      async (bin) => (bin.endsWith('.exe')
        ? { version: '2.1.316' }
        : { version: null, error: 'boom' }),
    );
    assert.equal(picked?.candidate.binary, 'C:\\good\\claude.exe');
    assert.equal(picked?.version, '2.1.316');
  });

  it('探测顺序即优先级：不会跳过更靠前的可用候选', () => {
    const probed: string[] = [];
    const picked = pickFirstWorkingCandidate(
      cands('C:\\1\\a.cmd', 'C:\\2\\b.cmd', 'C:\\3\\c.cmd'),
      ['--version'],
      (bin) => {
        probed.push(bin);
        return { version: bin === 'C:\\2\\b.cmd' ? '9.9.9' : null, error: 'nope' };
      },
    );
    assert.equal(picked?.candidate.binary, 'C:\\2\\b.cmd');
    assert.deepEqual(probed, ['C:\\1\\a.cmd', 'C:\\2\\b.cmd'], '不应探测第三个候选');
  });
});

describe('quoteArgForCmd 保持修复前的参数转义行为', () => {
  it('含空格的参数加引号', () => {
    assert.equal(quoteArgForCmd('hello world'), '"hello world"');
  });

  it('内部引号沿用 \\" 转义（与修复前一致，不改既有行为）', () => {
    assert.equal(quoteArgForCmd('say "hi"'), '"say \\"hi\\""');
  });

  it('是否加引号由调用方决定（quoteArgForCmd 自身总是加）', () => {
    // 调用点的既有约定：只有含空格或引号的参数才加引号
    const arg = '--version';
    assert.equal(/[ "]/.test(arg) ? quoteArgForCmd(arg) : arg, '--version');
  });
});
