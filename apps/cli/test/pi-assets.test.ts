/**
 * Pi package 资产校验：package.json manifest、SKILL.md frontmatter（Agent Skills 规范）、
 * 扩展注册代码。资产文件是发布物的一部分（files 含 pi/），坏掉会静默让 Pi 用户的
 * 插件失效（skill 不加载 / server 注册失败），所以在这里做结构性把关。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/** 编译后本文件在 dist/test/，向上两级即包根 apps/cli/。 */
const resolveFromPkgRoot = (rel: string) =>
  fileURLToPath(new URL(`../../${rel.replace(/^\.\//, '')}`, import.meta.url));
const read = (rel: string) => readFileSync(resolveFromPkgRoot(rel), 'utf-8');

const TOOL_NAMES = [
  'molio_status',
  'kb_vaults',
  'kb_tree',
  'kb_read',
  'kb_search',
  'kb_ask_start',
  'kb_ask_poll',
] as const;

/** 极简 frontmatter 解析：只取顶层 `key: value`（嵌套 metadata 不展开）。 */
function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  assert.ok(m, 'SKILL.md 必须以 --- frontmatter 开头');
  const fields: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv?.[1] != null && kv[2] != null) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

describe('pi package 资产', () => {
  it('package.json：files/keywords/pi manifest 就位，pi 宿主包零依赖', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.files.includes('pi'), 'files 必须包含 pi/，否则发布包缺插件资产');
    assert.ok(pkg.keywords.includes('pi-package'), 'keywords 需含 pi-package（Pi gallery 可发现）');
    assert.deepEqual(pkg.pi?.extensions, ['./pi/extensions/molio-mcp.ts']);
    assert.deepEqual(pkg.pi?.skills, ['./pi/skills']);
    // pi manifest 声明的路径必须真实存在（相对包根；skills 是目录，不能用 readFileSync 探测）
    for (const p of [...pkg.pi.extensions, ...pkg.pi.skills]) {
      assert.ok(existsSync(resolveFromPkgRoot(p)), `pi manifest 路径不存在: ${p}`);
    }
    // Pi 宿主包不得出现在任何依赖字段：扩展对 pi 包只有 import type（运行时擦除），
    // 而 pnpm auto-install-peers 会把 peer 真装进 workspace（连带 @google/genai 等
    // pi 的重依赖 + 锁文件膨胀，2026-10 实测踩坑），所以连 optional peer 也不声明。
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      assert.ok(
        !pkg[field]?.['@earendil-works/pi-coding-agent'],
        `${field} 不得声明 pi 宿主包（扩展只 import type，无需依赖）`,
      );
    }
  });

  it('SKILL.md：frontmatter 符合 Agent Skills 规范', () => {
    const fm = parseFrontmatter(read('pi/skills/molio-kb/SKILL.md'));
    const name = fm.name ?? '';
    const description = fm.description ?? '';
    // name：小写字母数字连字符，≤64，无首尾/连续连字符
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64);
    assert.equal(name, 'molio-kb');
    // description：非空 ≤1024，且要包含路由信息（何时用）
    assert.ok(description.length > 0 && description.length <= 1024);
    assert.match(description, /knowledge base/i);
  });

  it('SKILL.md：正文覆盖 7 个工具名与 pi 调用约定', () => {
    const body = read('pi/skills/molio-kb/SKILL.md');
    for (const tool of TOOL_NAMES) {
      assert.ok(body.includes(tool), `SKILL.md 缺少工具说明: ${tool}`);
    }
    // pi 中 MCP 工具带 mcp__molio__ 前缀；默认 codemode exposure 走 tools.mcp__molio__*
    assert.ok(body.includes('mcp__molio__'), '需说明 pi 的工具命名前缀');
    assert.ok(body.includes('codemode'), '需说明 codemode 调用方式');
    // codemode 结果是 CallToolResult，业务数据是 content[0].text 里的 JSON 字符串
    // （无 outputSchema；实测模型直接取结构化字段会得 undefined 误判工具异常）
    assert.ok(body.includes('content[0].text'), '需说明结果要 JSON.parse(content[0].text)');
    // 轮询红线：kb_ask_poll 单次返回，不允许脚本内死循环
    assert.ok(body.includes('kb_ask_poll'), '需说明问答轮询节奏');
  });

  it('扩展：注册 molio server，优先包内 dist，兜底 npx', () => {
    const ext = read('pi/extensions/molio-mcp.ts');
    assert.ok(ext.includes('export default function'), 'Pi 扩展必须默认导出 factory');
    assert.ok(ext.includes('registerMcpServer("molio"'), '必须注册名为 molio 的 MCP server');
    assert.ok(ext.includes('dist/src/index.js'), '优先指向本包 dist 入口');
    assert.ok(ext.includes('npx') && ext.includes('@molio/cli'), 'dist 缺失时兜底 npx -y @molio/cli mcp');
    assert.ok(ext.includes('process.execPath'), '用 process.execPath 而非裸 node，避免 PATH 版本问题');
    // import type 必须可擦除（发布包不依赖 pi 运行时包）：
    // 所有 import 行要么是 import type，要么只来自 node: 内置模块
    assert.ok(ext.includes('import type { ExtensionAPI }'), 'ExtensionAPI 只能 import type');
    for (const line of ext.split(/\r?\n/)) {
      if (!/^import\s/.test(line)) continue;
      const ok = /^import type\s/.test(line) || /from ["']node:/.test(line);
      assert.ok(ok, `扩展存在不允许的运行时 import: ${line}`);
    }
  });
});
