import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codeIntervals, intervalOverlaps } from '../../src/core/wikilink-text.js';

/**
 * Parity guard: src/core/wikilink-text.ts (daemon/graph side, compiled) and
 * src/tools/skills/wiki-build/scripts/lib/linktext.mjs (skill side, plain JS
 * for bare-node execution) are two implementations of the same rules by
 * necessity — neither runtime can import the other. This test runs BOTH over
 * the same tricky inputs and diffs the intervals, so drift fails loudly
 * instead of splitting "what deadcheck checks" from "what the graph shows".
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveMjs(): string {
  const candidates = [
    // compiled run: dist/test/core/ → app root → src/...
    path.join(__dirname, '..', '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'linktext.mjs'),
    // tsx run: test/core/ → app root → src/...
    path.join(__dirname, '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'lib', 'linktext.mjs'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`linktext.mjs not found; tried:\n${candidates.join('\n')}`);
}

const FIXTURES: Array<[name: string, content: string]> = [
  ['empty', ''],
  ['no code at all', '# 标题\n\n正文 [[甲]] 与 `x`。\n'],
  ['fence with wikilink', '# A\n\n```\n[[不存在的页面]]\n```\n\n正文 [[乙]]。\n'],
  ['unclosed fence runs to EOF', '# A\n\n```\n[[甲]]\n没有闭合\n'],
  ['inline code', '见 `[[甲|乙]]乙]]` 代码，再 [[丙]]。\n'],
  ['CRLF line endings', '# A\r\n\r\n```\r\n[[甲]]\r\n```\r\n\r\n[[乙]]\r\n'],
  ['indented fence', '列表项：\n\n  ```js\n  const x = "[[甲]]";\n  ```\n\n[[乙]]\n'],
  ['two fences', '```\n[[甲]]\n```\n\n中间 [[乙]]\n\n```\n[[丙]]\n```\n'],
  ['fence info string', '```markdown\n[[甲|乙]]乙]]\n```\n'],
  ['ext-B chars around code', '𠀀`[[甲]]`𠀁 与 [[乙]]\n'],
];

describe('wikilink-text parity — TS twin vs skill .mjs', () => {
  it('codeIntervals identical on all fixtures', async () => {
    const mjs = await import(pathToFileURL(resolveMjs()).href);
    for (const [name, content] of FIXTURES) {
      assert.deepEqual(
        codeIntervals(content),
        mjs.codeIntervals(content),
        `codeIntervals drift on fixture "${name}"`,
      );
    }
  });

  it('intervalOverlaps matches plain overlap semantics', () => {
    const list = codeIntervals(FIXTURES[2]![1]);
    assert.equal(intervalOverlaps([0, 2], list), false, 'before the fence');
    const [s, e] = list[0]!;
    assert.equal(intervalOverlaps([s, s + 1], list), true, 'touching the fence start');
    assert.equal(intervalOverlaps([e - 1, e + 5], list), true, 'crossing the fence end');
    assert.equal(intervalOverlaps([e, e + 3], list), false, 'right after the fence');
  });
});
