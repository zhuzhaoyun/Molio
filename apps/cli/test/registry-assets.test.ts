/**
 * MCP Registry（registry.modelcontextprotocol.io）资产校验：server.json 与
 * package.json 的一致性、mcpName 归属验证、参数放置位置。server.json 不进 npm
 * tarball，但坏掉会静默让官方 Registry 收录后所有客户端安装失败（例如把 `mcp`
 * 子命令放进 runtimeArguments——那是给 npx 的参数，不是给 molio 二进制的，
 * 2025-12-11 schema 实测踩坑），所以在这里做结构性把关。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/** 编译后本文件在 dist/test/，向上两级即包根 apps/cli/。 */
const resolveFromPkgRoot = (rel: string) =>
  fileURLToPath(new URL(`../../${rel.replace(/^\.\//, '')}`, import.meta.url));
const read = (rel: string) => readFileSync(resolveFromPkgRoot(rel), 'utf-8');

const SERVER_NAME = 'io.github.zhuzhaoyun/molio';

describe('MCP Registry 资产（server.json）', () => {
  const server = JSON.parse(read('server.json'));
  const pkg = JSON.parse(read('package.json'));

  it('name 与 package.json mcpName 一致（Registry 归属验证的前提）', () => {
    assert.equal(server.name, SERVER_NAME);
    // npm 归属验证：Registry 要求已发布包的 mcpName 与 server.json name 完全一致
    assert.equal(pkg.mcpName, SERVER_NAME, 'package.json mcpName 必须与 server.json name 一致');
    // GitHub 认证下命名空间必须是 io.github.<repo-owner>/
    assert.match(server.name, /^io\.github\.zhuzhaoyun\//);
  });

  it('版本三处同步：server.json 顶层 / packages[0] / package.json', () => {
    assert.equal(server.version, pkg.version);
    const npmPkg = server.packages?.[0];
    assert.ok(npmPkg, 'server.json 必须有一个 packages 条目（stdio npm 包）');
    assert.equal(npmPkg.version, pkg.version);
  });

  it('description ≤100 字符（Registry 硬限制）', () => {
    assert.ok(server.description.length > 0);
    assert.ok(
      server.description.length <= 100,
      `description 超过 Registry 100 字符限制: ${server.description.length}`,
    );
  });

  it('`mcp` 子命令必须在 packageArguments，不得放 runtimeArguments', () => {
    const npmPkg = server.packages[0];
    assert.equal(npmPkg.registryType, 'npm');
    assert.equal(npmPkg.identifier, '@molio/cli');
    assert.equal(npmPkg.transport?.type, 'stdio');
    assert.equal(npmPkg.runtimeHint, 'npx');
    // packageArguments = 传给包二进制（molio）的参数；runtimeArguments = 传给 npx 的参数。
    // `molio mcp` 的子命令属于前者，放错会导致客户端启动的是 CLI 主命令而非 MCP server。
    const positional = (npmPkg.packageArguments ?? []).filter((a: any) => a.type === 'positional');
    assert.deepEqual(positional, [{ type: 'positional', value: 'mcp' }]);
    assert.ok(
      !npmPkg.runtimeArguments?.some((a: any) => a.value === 'mcp'),
      'runtimeArguments 是给 npx 的参数，不得包含 mcp 子命令',
    );
  });

  it('环境变量声明 MOLIO_PORT（非必填、非 secret）', () => {
    const env = server.packages[0].environmentVariables ?? [];
    const port = env.find((e: any) => e.name === 'MOLIO_PORT');
    assert.ok(port, '应声明 MOLIO_PORT 供客户端配置 daemon 端口');
    assert.equal(port.isRequired, false);
    assert.equal(port.isSecret, false);
    assert.equal(port.format, 'string');
  });

  it('repository 指向 zhuzhaoyun/Molio（OIDC 发布验证同源）', () => {
    assert.equal(server.repository?.source, 'github');
    assert.equal(server.repository?.url, 'https://github.com/zhuzhaoyun/Molio');
  });
});
