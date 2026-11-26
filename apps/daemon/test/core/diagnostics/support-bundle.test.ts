import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDiagnostics } from '../../../src/core/diagnostics/run-diagnostics.js';
import {
  BUNDLE_LOG_LINES,
  buildSupportBundle,
  filterLogForBundle,
  redactHomePaths,
  writeSupportBundle,
} from '../../../src/core/diagnostics/support-bundle.js';
import { ACCOUNT_LINE, TAIL_CONT, TAIL_HEAD, UPD_FAIL, UPD_OK, makeDeps } from './fixtures.js';

/**
 * 支持包生成的单测：日志过滤只留四类标签的行及其续行、主目录用户名打码、
 * 正文按固定版式拼装落盘。隐私是硬性要求——账号标识与用户名绝不能跟着支持包出去。
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'molio-support-bundle-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('filterLogForBundle', () => {
  it('丢弃账号状态行，保留四类标签的行及其续行', () => {
    assert.deepEqual(filterLogForBundle([ACCOUNT_LINE, TAIL_HEAD, TAIL_CONT]), [TAIL_HEAD, TAIL_CONT]);
  });

  it('分组间空格抖动的标签行仍按标签取舍，不当续行带出去', () => {
    const loose = '[2026-11-23T07:40:00.000Z]  [INFO]  [monitoring] metrics flush';
    assert.deepEqual(filterLogForBundle([TAIL_HEAD, loose, '续行']), [TAIL_HEAD]);
  });

  it('账号状态行后面的无前缀行不算续行', () => {
    assert.deepEqual(filterLogForBundle([ACCOUNT_LINE, '续行']), []);
  });

  it('续行链在被丢弃的标签行处断开', () => {
    // [monitoring] 是被刻意排除的遥测标签，它的续行同样不能带出去
    const monitoring = '[2026-11-23T07:40:01.000Z] [INFO] [monitoring] metrics flush';
    const lines = [TAIL_HEAD, TAIL_CONT, '第二行续行', monitoring, '被断开的续行', UPD_OK, '重新接上的续行'];
    assert.deepEqual(filterLogForBundle(lines), [TAIL_HEAD, TAIL_CONT, '第二行续行', UPD_OK, '重新接上的续行']);
  });

  it('日志带出上限为 300 行', () => {
    assert.equal(BUNDLE_LOG_LINES, 300);
  });
});

describe('redactHomePaths', () => {
  it('三种主目录写法都打码', () => {
    assert.equal(redactHomePaths('C:\\Users\\Administrator\\.molio\\runs'), 'C:\\Users\\<用户>\\.molio\\runs');
    assert.equal(redactHomePaths('/Users/albert/x /home/bob/y'), '/Users/<用户>/x /home/<用户>/y');
    // Windows 写法不分大小写
    assert.equal(redactHomePaths('c:\\users\\albert\\.molio'), 'c:\\users\\<用户>\\.molio');
  });

  it('Windows 用户名含空格时整段打码', () => {
    assert.equal(redactHomePaths('C:\\Users\\John Smith\\.molio\\runs'), 'C:\\Users\\<用户>\\.molio\\runs');
    // C:/Users/ 正斜杠写法同样处理
    assert.equal(redactHomePaths('C:/Users/John Smith/AppData/Local'), 'C:/Users/<用户>/AppData/Local');
  });

  it('JSON 转义写法的 Windows 路径也打码（用户名可含空格）', () => {
    // 日志里被 JSON 序列化过的内容，分隔符必然写成两个反斜杠——这是主平台上最常见的形态
    assert.equal(
      redactHomePaths('{"cwd":"C:\\\\Users\\\\zhang san\\\\project"}'),
      '{"cwd":"C:\\\\Users\\\\<用户>\\\\project"}',
    );
  });

  it('JSON 转义写法的 POSIX 路径也打码', () => {
    assert.equal(redactHomePaths('\\/Users\\/bob\\/x'), '\\/Users\\/<用户>\\/x');
  });

  it('UNC 路径（含 JSON 转义写法）也打码', () => {
    // 内网的网络共享盘
    assert.equal(redactHomePaths('\\\\server\\share\\Users\\bob\\file'), '\\\\server\\share\\Users\\<用户>\\file');
    assert.equal(
      redactHomePaths('{"p":"\\\\\\\\nas\\\\media\\\\Users\\\\bob\\\\f"}'),
      '{"p":"\\\\\\\\nas\\\\media\\\\Users\\\\<用户>\\\\f"}',
    );
  });

  it('引号终止用户名段，不吞引号与其后的正文', () => {
    assert.equal(redactHomePaths('"C:\\Users\\bob" then D:\\data'), '"C:\\Users\\<用户>" then D:\\data');
  });

  it('用户名段止于 Windows 用户名不可能出现的字符', () => {
    // 冒号/逗号终止用户名段，其后的正文原样保留
    assert.equal(redactHomePaths('C:\\Users\\bob, tel 123'), 'C:\\Users\\<用户>, tel 123');
    assert.equal(redactHomePaths('/Users/bob: EACCES'), '/Users/<用户>: EACCES');
  });

  it("撇号属于用户名（O'Brien 形态），不残留半个用户名", () => {
    // 撇号之后最近的终止类字符是分隔符或引号 → 撇号是用户名的一部分，整段打码
    assert.equal(redactHomePaths("C:\\Users\\o'brien\\x"), 'C:\\Users\\<用户>\\x');
    assert.equal(redactHomePaths("/Users/o'brien/x"), '/Users/<用户>/x');
    assert.equal(redactHomePaths("'C:\\Users\\o'brien'"), "'C:\\Users\\<用户>'");
    assert.equal(redactHomePaths('"C:\\Users\\o\'brien" then x/y'), '"C:\\Users\\<用户>" then x/y');
  });

  it('撇号后最近的终止类字符是空白时，撇号终止用户名', () => {
    // 「o'x y z」：撇号后最近终止是空白（不是分隔符/引号）→ 撇号终止用户名，后面按正文保留（已知取舍）
    assert.equal(redactHomePaths("C:\\Users\\o'x y z"), "C:\\Users\\<用户>'x y z");
  });

  it('空用户名段的引号不触发打码，根前的引号原样保留', () => {
    assert.equal(redactHomePaths("C:\\Users\\''"), "C:\\Users\\''");
    assert.equal(redactHomePaths("''C:\\Users\\bob"), "''C:\\Users\\<用户>");
  });

  it('行尾的主目录根不把下一行当用户名', () => {
    const twoLines = 'path C:\\Users\\\nthen plain text / and more';
    assert.equal(redactHomePaths(twoLines), twoLines);
  });

  it('后面没有分隔符的主目录路径也打码', () => {
    assert.equal(redactHomePaths('vault at /Users/albert'), 'vault at /Users/<用户>');
    assert.equal(redactHomePaths('installed at C:\\Users\\Administrator'), 'installed at C:\\Users\\<用户>');
    // 没有分隔符时到空白为止，只打码第一个空格前的用户名，不吞掉后面的正文
    assert.equal(redactHomePaths('C:\\Users\\John Smith 说 hi'), 'C:\\Users\\<用户> Smith 说 hi');
  });

  it('已打码的文本再处理一遍结果不变（幂等）', () => {
    const once = redactHomePaths(
      'C:\\Users\\John Smith\\.molio 与 /Users/albert/demo 和 '
        + '{"cwd":"C:\\\\Users\\\\zhang san\\\\project"}、\\\\server\\share\\Users\\bob\\file',
    );
    assert.equal(redactHomePaths(once), once);
  });
});

describe('buildSupportBundle', () => {
  it('含体检正文与日志，不含账号标识，不含标题行', async () => {
    const report = await runDiagnostics(
      makeDeps({ readMainLog: () => [UPD_FAIL, UPD_FAIL, UPD_FAIL], env: { MOLIO_APP_VERSION: '0.4.7' } }),
    );
    const text = buildSupportBundle(report, [ACCOUNT_LINE, TAIL_HEAD, TAIL_CONT]);
    assert.ok(text.startsWith('Molio 支持包\n'));
    assert.ok(text.includes('== 体检结果 ==') && text.includes('== 运行日志（最近 2 行'));
    assert.ok(text.includes('详情：net::ERR_NAME_NOT_RESOLVED'));
    assert.ok(!text.includes('u_abc123') && !text.includes('Molio 体检结果（'));
    assert.ok(text.trimEnd().endsWith('不包含对话内容和文档正文。'));
  });

  it('版本取不到写「未知」，安装目录为 null 时整行省略', async () => {
    const text = buildSupportBundle(await runDiagnostics(makeDeps()), []);
    assert.ok(text.includes('版本：未知 · 平台：win32 x64'));
    assert.ok(!text.includes('安装目录：'));
    // 没有可带出的日志也照常印标题行
    assert.ok(text.includes('== 运行日志（最近 0 行'));
  });

  it('体检结果里的主目录路径同样打码', async () => {
    // vault.missing 的摘要与详情都会带上库路径——用户名不能跟着支持包出去
    const report = await runDiagnostics(
      makeDeps({
        listVaults: () => [{ id: 'v1', name: '示例', path: '/Users/secretname/demo', fileCount: 3, createdAt: 0 }],
        pathExists: () => false,
      }),
    );
    const text = buildSupportBundle(report, []);
    assert.ok(!text.includes('secretname'));
    assert.ok(text.includes('/Users/<用户>/demo'));
  });
});

describe('writeSupportBundle', () => {
  it('目录不存在时创建并返回带时间戳的绝对路径', () => {
    const p = writeSupportBundle('x', path.join(tmp, 'nested'), new Date(2026, 10, 24, 15, 2, 5).getTime());
    assert.equal(p, path.join(tmp, 'nested', 'molio-support-20261124-150205.txt'));
    assert.ok(existsSync(p));
    assert.equal(readFileSync(p, 'utf8'), 'x');
  });
});
