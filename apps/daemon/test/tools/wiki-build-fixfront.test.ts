import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = ['../../src', '../../../src']
  .map((p) => path.resolve(here, p, 'tools/skills/wiki-build/scripts'))
  .find((p) => fs.existsSync(p))!;

function fixture(fn: (v: string, write: (p: string, s: string) => void) => void) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-fixfront-'));
  const write = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(v, p)), { recursive: true });
    fs.writeFileSync(path.join(v, p), s);
  };
  try { fn(v, write); } finally { fs.rmSync(v, { recursive: true, force: true }); }
}

const run = (v: string) =>
  spawnSync(process.execPath, [path.join(scripts, 'fixfront.mjs'), '--vault', v], { encoding: 'utf8' });
const read = (v: string, p: string) => fs.readFileSync(path.join(v, p), 'utf8');

/**
 * fixfront.mjs 用 lib/linktext.mjs 的 frontmatterEnd() 拆 frontmatter（与
 * linkpass/deadcheck 同一判定）。这些用例钉住收敛后的契约，包括旧私有正则
 * 漏判、如今按共享判定被修复的两个边界。
 */
it('fixes curly quotes in frontmatter, strips blockquote prefixes, leaves body verbatim', () => {
  fixture((v, w) => {
    w('wiki/entities/a.md', '---\ntitle: “弯引号”\ntag: ‘单’\n---\n\n正文保留“弯引号”。\n\n> 引文行\n');
    const r = run(v);
    assert.equal(r.status, 0, String(r.stderr));
    assert.equal(JSON.parse(r.stdout).filesFixed, 1);

    const out = read(v, 'wiki/entities/a.md');
    assert.ok(out.includes('title: "弯引号"'), 'frontmatter double quotes fixed');
    assert.ok(out.includes("tag: '单'"), 'frontmatter single quotes fixed');
    assert.ok(out.includes('正文保留“弯引号”'), 'body curly quotes stay verbatim');
    assert.ok(out.includes('\n引文行'), 'blockquote prefix stripped');
    assert.ok(!out.includes('\n> '), 'no blockquote prefix left');
  });
});

it('frontmatter detection matches the shared frontmatterEnd contract (EOF-close, trailing-space delimiters)', () => {
  fixture((v, w) => {
    // 旧私有正则两处漏判，收敛到 frontmatterEnd 后必须被识别：
    w('wiki/entities/a.md', '---\ntitle: “x”\n---');            // 正好结束在闭合 ---（EOF，无尾换行）
    w('wiki/entities/b.md', '--- \ntitle: “y”\n--- \nbody');     // 分隔符带尾随空格
    const r = run(v);
    assert.equal(r.status, 0, String(r.stderr));
    assert.ok(read(v, 'wiki/entities/a.md').includes('title: "x"'), 'EOF-closed frontmatter is fixed');
    assert.ok(read(v, 'wiki/entities/b.md').includes('title: "y"'), 'trailing-space delimiters are fixed');
  });
});

it('files without frontmatter only get blockquote handling', () => {
  fixture((v, w) => {
    w('wiki/entities/a.md', '# 标题\n\n> 引文\n');
    const r = run(v);
    assert.equal(r.status, 0, String(r.stderr));
    const out = read(v, 'wiki/entities/a.md');
    assert.ok(out.startsWith('# 标题'), 'no frontmatter fabricated');
    assert.ok(out.includes('\n引文'), 'blockquote prefix still stripped');
  });
});

it('preserves CRLF line endings in both touched and untouched lines', () => {
  fixture((v, w) => {
    w('wiki/entities/a.md', '---\r\ntitle: “x”\r\n---\r\n\r\n> 引文\r\n正文\r\n');
    const r = run(v);
    assert.equal(r.status, 0, String(r.stderr));
    const out = read(v, 'wiki/entities/a.md');
    assert.ok(out.includes('title: "x"\r\n'), 'frontmatter fix keeps its CRLF');
    assert.ok(out.includes('\r\n引文\r\n'), 'stripped blockquote line keeps CRLF');
    assert.ok(out.includes('\r\n正文\r\n'), 'untouched body keeps CRLF');
  });
});
