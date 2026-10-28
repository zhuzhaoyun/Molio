/**
 * MCPB 资产校验（Smithery / Claude Desktop 的本地 stdio 分发格式）。
 *
 * manifest 由 `scripts/build-mcpb.mjs` 打包时把版本覆盖成 package.json 的值，
 * 但其他字段（入口路径、env 映射、user_config 键）写错时构建仍然"成功"，
 * 直到用户在客户端装包才暴露，所以这里做结构性把关。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const resolveFromPkgRoot = (rel: string) =>
  fileURLToPath(new URL(`../../${rel.replace(/^\.\//, '')}`, import.meta.url));
const read = (rel: string) => readFileSync(resolveFromPkgRoot(rel), 'utf-8');

const normalizeRepo = (url: string) => url.replace(/\.git$/, '');

describe('MCPB 资产（mcpb/manifest.json）', () => {
  const manifest = JSON.parse(read('mcpb/manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  const server = JSON.parse(read('server.json'));

  it('版本与 package.json 同步（发版时容易漏）', () => {
    assert.equal(manifest.manifest_version, '0.3');
    assert.equal(manifest.version, pkg.version);
  });

  it('入口指向构建产物 server/index.js，由 node 启动', () => {
    assert.equal(manifest.server?.type, 'node');
    assert.equal(manifest.server?.entry_point, 'server/index.js');
    assert.equal(manifest.server?.mcp_config?.command, 'node');
    assert.deepEqual(manifest.server?.mcp_config?.args, ['${__dirname}/server/index.js']);
    // 该文件由 scripts/build-mcpb.mjs 用 esbuild 产出，不应出现在源码目录里
    assert.ok(existsSync(resolveFromPkgRoot('scripts/build-mcpb.mjs')));
    assert.ok(!existsSync(resolveFromPkgRoot('mcpb/server/index.js')), '构建产物不应提交进仓');
  });

  it('daemon 配置通过 user_config 注入环境变量', () => {
    const env = manifest.server?.mcp_config?.env ?? {};
    const userConfig = manifest.user_config ?? {};
    for (const [envName, template] of Object.entries(env)) {
      const match = String(template).match(/^\$\{user_config\.([\w-]+)\}$/);
      assert.ok(match, `${envName} 必须是 ${'${user_config.<key>}'} 形式`);
      assert.ok(match[1] && userConfig[match[1]], `${envName} 引用了不存在的 user_config.${match[1]}`);
    }
    assert.equal(env.MOLIO_PORT, '${user_config.molio_port}');
    assert.equal(env.MOLIO_DAEMON_URL, '${user_config.daemon_url}');
    // 与 daemon-client.ts 的默认端口保持一致
    assert.equal(userConfig.molio_port?.default, '3100');
    assert.equal(userConfig.molio_port?.required, false);
    assert.equal(userConfig.daemon_url?.required, false);
  });

  it('描述与官方 Registry 一致且满足 Registry 的 100 字符限制', () => {
    assert.equal(manifest.description, server.description);
    assert.ok(manifest.description.length <= 100);
  });

  it('仓库 / 官网与 server.json 同源', () => {
    assert.equal(normalizeRepo(manifest.repository?.url), normalizeRepo(server.repository.url));
    assert.equal(manifest.homepage, server.websiteUrl);
  });

  it('Node 运行时下限与 package.json engines 一致', () => {
    assert.equal(manifest.compatibility?.runtimes?.node, pkg.engines.node);
  });

  it('图标源存在且为 512×512（MCPB 推荐尺寸）', () => {
    assert.equal(manifest.icon, 'icon.png');
    const icon = resolveFromPkgRoot('../desktop/build/icon.png');
    assert.ok(existsSync(icon), '缺少打包脚本依赖的 desktop/build/icon.png');
    const png = readFileSync(icon);
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 512);
  });

  it('打包依赖与脚本已声明', () => {
    assert.ok(pkg.scripts?.['build:mcpb'], 'package.json 缺少 build:mcpb 脚本');
    assert.ok(pkg.devDependencies?.esbuild, '缺少 esbuild（单文件打包）');
    assert.ok(pkg.devDependencies?.['@anthropic-ai/mcpb'], '缺少 @anthropic-ai/mcpb（打包/校验）');
  });
});