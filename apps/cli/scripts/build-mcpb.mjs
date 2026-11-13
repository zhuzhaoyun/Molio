#!/usr/bin/env node
/**
 * 构建 MCPB 扩展包（Smithery / Claude Desktop 的本地 stdio 分发格式）。
 *
 * `molio mcp` 依赖 @modelcontextprotocol/sdk + zod，MCPB 客户端不会替我们装 npm 依赖，
 * 所以先用 esbuild 打成单文件，再交给 mcpb CLI 校验、打包。
 * 产物在 apps/cli/dist/ 下，不进 npm tarball。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
const staging = join(pkgRoot, 'dist', 'mcpb');
const outFile = join(pkgRoot, 'dist', `molio-kb-${pkg.version}.mcpb`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, 'server'), { recursive: true });

await build({
  entryPoints: [join(pkgRoot, 'mcpb', 'entry.ts')],
  outfile: join(staging, 'server', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'info',
});

// manifest 是提交给客户的元数据，版本以 package.json 为准，避免发版时漏改。
const manifest = JSON.parse(readFileSync(join(pkgRoot, 'mcpb', 'manifest.json'), 'utf-8'));
manifest.version = pkg.version;
writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 512×512 应用图标（符合 MCPB 推荐的图标尺寸）；manifest 声明了 icon，缺文件会校验失败
const iconSrc = join(pkgRoot, '..', 'desktop', 'build', 'icon.png');
if (!existsSync(iconSrc)) throw new Error(`MCPB icon not found: ${iconSrc}`);
cpSync(iconSrc, join(staging, 'icon.png'));

// 直接调 mcpb CLI 的 JS 入口：npx.cmd 在 Windows 上 spawn 会 EINVAL，且不该每次构建都联网。
const mcpbRoot = dirname(dirname(require.resolve('@anthropic-ai/mcpb')));
const mcpbBinField = JSON.parse(readFileSync(join(mcpbRoot, 'package.json'), 'utf-8')).bin;
const mcpbBin = typeof mcpbBinField === 'string' ? mcpbBinField : mcpbBinField.mcpb;
const mcpb = (args) =>
  execFileSync(process.execPath, [join(mcpbRoot, mcpbBin), ...args], { stdio: 'inherit' });

mcpb(['validate', staging]);
mcpb(['pack', staging, outFile]);
mcpb(['info', outFile]);

console.log(`\nMCPB bundle ready: ${outFile}`);