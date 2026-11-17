/**
 * E2E 端口平移契约：spec / helpers 不许硬编码 localhost 端口。
 *
 * playwright.config.ts 早已支持整体平移（MOLIO_E2E_WEB_PORT / MOLIO_E2E_DAEMON_PORT /
 * MOLIO_E2E_CLOUD_PORT / MOLIO_E2E_MOCK_OSS_PORT，外加 MOLIO_E2E_DATA_DIR 数据隔离），
 * webServer 的四个服务都读 env 起在平移端口上。但 spec 里写死
 * `http://localhost:5173/...` 的 goto 会绕过 config 的 baseURL，打到**默认端口上
 * 别人的服务**：5173 被另一个 dev vite 占用、3100 被已安装桌面实例的 daemon 占用时，
 * 页面看起来正常（.kb-shell 可见）、数据全错（测试 vault 根本不存在），断言集体超时。
 * 2026-11-15 全量 E2E 实测：161 个失败里 159 个是这一条根因，与产品代码无关；
 * 云端 CI 用默认端口且无竞争，所以同一份代码云端全绿、本机平移全红。
 *
 * 两种合法写法（与既有 spec 一致）：
 * 1. 默认 context 的导航用相对路径 `page.goto('/knowledge?...')` —— 走 baseURL；
 * 2. 必须绝对地址时（自建 context 不继承 baseURL / grantPermissions 的 origin /
 *    waitForURL 前缀匹配 / daemon·mock-oss 直连 fetch），用 env 模板：
 *    `http://localhost:${process.env.MOLIO_E2E_WEB_PORT ?? '5173'}`。
 *
 * 守卫判据：`http(s)://localhost` 或 `127.0.0.1` 后面直接跟**数字**端口 = 硬编码
 * （env 模板跟的是 `$`，不命中）。只拦字面量形态：字符串拼接、非 env 常量模板
 * （`const PORT = 5173` + `${PORT}`）正则无法区分，靠 review 兜底。
 * scenarios/*.md 是手动场景文档（对着 pnpm dev 默认端口跑），不在守卫范围。
 * 失败时的修法写在断言消息里——CI 上看到这条就知道该改什么。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../e2e');
/** `http(s)://localhost|127.0.0.1:` 后紧跟数字端口 = 写死；env 模板（`${process.env.…}`）不命中。 */
const HARDCODED = /https?:\/\/(localhost|127\.0\.0\.1):\d/;

/** 收集守卫范围内的文件：e2e 根下所有 .spec.ts + helpers/ 下所有 .ts。 */
function guardedFiles(): string[] {
  const files: string[] = [];
  for (const f of readdirSync(E2E_DIR)) {
    if (f.endsWith('.spec.ts')) files.push(join(E2E_DIR, f));
  }
  const helpers = join(E2E_DIR, 'helpers');
  for (const f of readdirSync(helpers)) {
    const p = join(helpers, f);
    if (f.endsWith('.ts') && statSync(p).isFile()) files.push(p);
  }
  return files;
}

describe('E2E 端口平移契约', () => {
  it('spec / helpers 不硬编码 localhost 端口（平移跑时写死地址会打到别人的服务）', () => {
    const violations: string[] = [];
    for (const file of guardedFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (HARDCODED.test(line)) {
          violations.push(`${file.slice(E2E_DIR.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepStrictEqual(
      violations,
      [],
      '这些行把 localhost 端口写死了——MOLIO_E2E_*_PORT 平移时它们仍打默认端口，' +
        '若默认端口被其他 dev server / 已安装实例占用，页面正常但数据全错、断言集体超时：\n  ' +
        violations.join('\n  ') +
        '\n修法（二选一，与既有 spec 一致）：\n' +
        '  1. 默认 context 的导航改相对路径：page.goto(\'/knowledge?vault=…\') —— 走 config baseURL；\n' +
        '  2. 必须绝对地址时（自建 context / grantPermissions origin / waitForURL 前缀 / 直连 fetch）用 env 模板：\n' +
        '     `http://localhost:${process.env.MOLIO_E2E_WEB_PORT ?? \'5173\'}`\n' +
        '     （daemon 用 MOLIO_E2E_DAEMON_PORT ?? \'3100\'，mock-oss 用 MOLIO_E2E_MOCK_OSS_PORT ?? \'3199\'）\n' +
        '背景见 playwright.config.ts 头注与 docs/2026-11-16-e2e-port-shift-design.md。',
    );
  });
});
