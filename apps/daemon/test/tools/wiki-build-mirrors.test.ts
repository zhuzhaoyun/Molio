import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildGraph } from '../../src/routes/graph.js';
import { MAX_DIR_ENTRIES } from '../../src/core/vault-prune.js';

/**
 * 跨层镜像对账。wiki-build 的 skill 脚本跑在裸 node 下（.mjs），import 不了
 * daemon 的 TS 模块；TS 侧 tsc 无 allowJs 也 import 不了 .mjs。所以同一份规则
 * 必然两边各有一份实现——镜像删不掉，能做的是让漂移【响亮地失败】。
 * wikilink-text.test.ts 已守住 codeIntervals 这一对；这里补上剩下的三面镜子，
 * 外加一个端到端对账（deadcheck CLI vs buildGraph 对同一 vault 的死链判定）：
 *
 *   1. LINK_RE             deadcheck.mjs ↔ routes/graph.ts —— 链接抽取正则
 *   2. normalizeName       deadcheck.mjs ↔ routes/graph.ts —— 模糊名归一
 *   3. MAX_FIGURES_PER_DIR media.mjs     ↔ core/vault-prune.ts MAX_DIR_ENTRIES
 *
 * 第 3 面的事故形态最隐蔽：目录超过 MAX_DIR_ENTRIES 时 Molio 会把整个目录从
 * 文件树剪掉（所有图一次从 UI 消失），而 media check 的镜像上限若没跟上，
 * 门禁照样绿。改 vault-prune 常量时必须同步 media.mjs 的镜像。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** 既能从编译产物（dist/test/tools/…）跑，也能 tsx 直跑（test/tools/…）。 */
function appPath(rel: string): string {
  const candidates = [
    path.join(here, '..', '..', '..', rel),
    path.join(here, '..', '..', rel),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`not found under app root: ${rel}; tried:\n${candidates.join('\n')}`);
}

const SCRIPTS = appPath('src/tools/skills/wiki-build/scripts');
const read = (p: string) => fs.readFileSync(p, 'utf8');

/** 提取 `const <decl> = /…/g;` 的正则源文本（两边的镜像都是单行字面量）。 */
function regexLiteralSource(source: string, declaration: string): string {
  const line = source.split(/\r?\n/).find((l) => l.includes(`const ${declaration} = /`));
  assert.ok(line, `${declaration} declaration not found in source`);
  const m = line.match(/= \/(.*)\/g;/);
  assert.ok(m, `${declaration} is not a single-line /…/g regex literal`);
  return m[1]!;
}

/**
 * 从源文本提取 normalizeName 的函数体并建成可调用函数。.mjs 侧 import 不了
 * （deadcheck 顶层就跑 main()），TS 侧不导出——提取后行为对比是唯一不改动
 * 生产代码就能做的双实现对账。
 */
function normalizeNameFn(source: string, label: string): (n: string) => string {
  const lines = source.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes('function normalizeName('));
  assert.ok(idx >= 0, `normalizeName not found in ${label}`);
  for (let i = idx + 1; i < Math.min(idx + 8, lines.length); i++) {
    const m = lines[i]!.trim().match(/^return (.*);$/);
    if (m) return new Function('name', `return ${m[1]};`) as (n: string) => string;
  }
  throw new Error(`normalizeName body not found in ${label}`);
}

describe('wiki-build 跨层镜像对账', () => {
  it('LINK_RE：deadcheck 与 graph.ts 的链接抽取正则一致', () => {
    const deadcheckRe = regexLiteralSource(read(path.join(SCRIPTS, 'deadcheck.mjs')), 'LINK_RE');
    const graphRe = regexLiteralSource(read(appPath('src/routes/graph.ts')), 'linkRegex');
    assert.equal(
      deadcheckRe, graphRe,
      '链接抽取正则漂移：deadcheck 认的链接和图谱认的链接已经不是同一批。' +
      '改任何一边的链接语法都必须同步另一边。',
    );
    // 提取健全性：共享正则真的能抽出目标与显示形态（不是抓到了空串）。
    const re = new RegExp(graphRe, 'g');
    const found = [...'见 [[李白|诗仙]] 与 [[entities/王五]]。'.matchAll(re)].map((m) => m[1]);
    assert.deepEqual(found, ['李白', 'entities/王五']);
  });

  it('normalizeName：deadcheck 与 graph.ts 的模糊名归一行为一致', () => {
    const fromDeadcheck = normalizeNameFn(read(path.join(SCRIPTS, 'deadcheck.mjs')), 'deadcheck.mjs');
    const fromGraph = normalizeNameFn(read(appPath('src/routes/graph.ts')), 'graph.ts');
    const names = [
      '李白', 'A B_c-d', 'MOLIO Wiki', 'kebab-case_name', '  padded  ', 'Li Bai',
      'a-b_c d', '𠀀extB', '全角　空格', '',
    ];
    for (const n of names) {
      assert.equal(fromDeadcheck(n), fromGraph(n), `normalizeName drift on ${JSON.stringify(n)}`);
    }
    // 语义锚点：两边都必须维持「空白/横线/下划线折叠 + 小写」。
    assert.equal(fromGraph('A B_c-d'), 'abcd');
    assert.equal(fromGraph('MOLIO Wiki'), 'moliowiki');
  });

  it('MAX_FIGURES_PER_DIR 镜像 core/vault-prune.ts 的 MAX_DIR_ENTRIES', () => {
    const m = read(path.join(SCRIPTS, 'media.mjs')).match(/const MAX_FIGURES_PER_DIR = (\d+);/);
    assert.ok(m, 'MAX_FIGURES_PER_DIR declaration not found in media.mjs');
    assert.equal(
      Number(m[1]!), MAX_DIR_ENTRIES,
      `media.mjs 的目录扫描上限镜像已漂移（media=${m[1]}, vault-prune=${MAX_DIR_ENTRIES}）。` +
      '超过 MAX_DIR_ENTRIES 的目录会被整体从文件树剪掉——所有图在 UI 里一次消失，' +
      '而 media check 仍绿。改 vault-prune 常量时必须同步这面镜子。',
    );
    assert.ok(MAX_DIR_ENTRIES >= 1000, 'sanity：文件树剪枝上限不应骤降');
  });

  it('端到端：deadcheck 与 buildGraph 对同一 vault 判定的死链集合一致', () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-mirror-'));
    try {
      const w = (p: string, s: string) => {
        fs.mkdirSync(path.dirname(path.join(v, p)), { recursive: true });
        fs.writeFileSync(path.join(v, p), s);
      };
      // 覆盖两侧共享的全部判定路径：精确名、路径式、别名式、
      // normalizeName 折叠（空格/横线/大小写）、代码块/行内代码跳过、真死链。
      // 注意：不放 index/log/hot——graph 有意剔除它们，deadcheck 不剔，
      // 这是两边都明确设计过的分歧，不属于「漂移」。
      w('wiki/entities/李白.md',
        '---\ntitle: 李白\n---\n\n[[苏婉]] 同行，[[王五]] 无页。\`[[代码内死链]]\` 不算。\n');
      w('wiki/entities/苏婉.md',
        '---\ntitle: 苏婉\n---\n\n[[entities/李白]] 路径式，[[李白|诗仙]] 别名式，[[molio wiki]] 折叠空格。\n\n\`\`\`\n[[围栏内死链]]\n\`\`\`\n');
      w('wiki/entities/molio.md', '[[不存在的页面]] 第二个真死链。\n');
      w('wiki/concepts/molio-wiki.md', '[[Li Bai]] 等于 li-bai，[[MOLIO]] 等于 molio。\n');
      w('wiki/concepts/li-bai.md', '[[MOLIO]] 大小写不敏感。\n');

      const jsonOut = path.join(v, 'deadcheck-report.json');
      const r = spawnSync(
        process.execPath,
        [path.join(SCRIPTS, 'deadcheck.mjs'), '--vault', v, '--json', jsonOut],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 1, `真死链必须让 deadcheck exit 1；stdout: ${r.stdout}`);
      const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8')) as { dead: { target: string }[] };
      const byDeadcheck = report.dead.map((d) => d.target.toLowerCase()).sort();

      const graph = buildGraph(v);
      const byGraph = graph.nodes
        .filter((n) => n.deadLink)
        .map((n) => n.key.replace('__dead__', ''))
        .sort();

      assert.deepEqual(byDeadcheck, ['不存在的页面', '王五'], 'deadcheck 侧：两个设计好的死链（无页的王五 + 不存在的页面）');
      assert.deepEqual(byGraph, ['不存在的页面', '王五'], 'graph 侧：死节点集合一致');
    } finally {
      fs.rmSync(v, { recursive: true, force: true });
    }
  });
});
