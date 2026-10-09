import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = ['../../src', '../../../src'].map(p => path.resolve(here, p, 'tools/skills/wiki-build/scripts'))
  .find(p => fs.existsSync(p))!;
function fixture(fn: (v: string, write: (p: string, s: string) => void) => void) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-media-'));
  const write = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(v, p)), { recursive: true });
    fs.writeFileSync(path.join(v, p), s);
  };
  try { fn(v, write); } finally { fs.rmSync(v, { recursive: true, force: true }); }
}
const run = (v: string, script: string, args: string[]) => spawnSync(process.execPath,
  [path.join(scripts, script), ...args, '--vault', v], { encoding: 'utf8' });

it('page rendering validates ranges and preserves existing renders unless forced', t => {
  if (spawnSync('python', ['-c', 'import fitz']).status !== 0) {
    t.skip('PyMuPDF unavailable'); return;
  }
  fixture((v, w) => {
    const pdf = path.join(v, 'book.pdf');
    const created = spawnSync('python', ['-c', 'import fitz,sys; d=fitz.open(); d.new_page(); d.save(sys.argv[1])', pdf]);
    assert.equal(created.status, 0, String(created.stderr));
    w('wiki/images/book/page-001.png', 'old render');
    assert.notEqual(run(v, 'media.mjs', ['pages', pdf, 'book']).status, 0);
    assert.equal(fs.readFileSync(path.join(v, 'wiki/images/book/page-001.png'), 'utf8'), 'old render');
    assert.notEqual(run(v, 'media.mjs', ['pages', pdf, 'book', '--pages', 'bad', '--force']).status, 0);
    assert.equal(run(v, 'media.mjs', ['pages', pdf, 'book', '--force']).status, 0);
    assert.equal(fs.readFileSync(path.join(v, 'wiki/images/book/page-001.png'))[0], 0x89);
  });
});

it('font repair only substitutes characters from suspect fonts', t => {
  if (spawnSync('python', ['-c', 'import fitz']).status !== 0) {
    t.skip('PyMuPDF unavailable'); return;
  }
  fixture((v, w) => {
    w('map.json', JSON.stringify({ '犃': 'A' }));
    const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location('fontmap', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class Page:
    def get_text(self, mode=None):
        if mode is None: return '\\u7283\\u7283'
        return {'blocks': [{'type': 0, 'lines': [{'spans': [
            {'font': 'E-BX9', 'chars': [{'c': '\\u7283'}]},
            {'font': 'Normal', 'chars': [{'c': '\\u7283'}]}
        ]}]}]}
class Doc:
    page_count = 1
    def __getitem__(self, i): return Page()
m.fitz.open = lambda _: Doc()
m.cmd_clean(['input.pdf', sys.argv[2], '--map', sys.argv[3]])
`;
    const out = path.join(v, 'clean.md');
    const r = spawnSync('python', ['-c', code, path.join(scripts, 'lib/fontmap.py'), out, path.join(v, 'map.json')],
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(out, 'utf8'), /A犃/);
  });
});

it('both gates resolve images outside wiki and embedded PDF attachments', () => fixture((v, w) => {
  w('attachments/figure.png', 'image'); w('raw/book.pdf', 'pdf');
  w('wiki/a.md', '![[attachments/figure.png]]\n![[raw/book.pdf]]');
  for (const [script, args] of [['media.mjs', ['check']], ['deadcheck.mjs', []]] as const) {
    const r = run(v, script, [...args]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
}));

it('does not accept a wrong directory just because the basename exists', () => fixture((v, w) => {
  w('wiki/images/book/001.png', 'image');
  w('wiki/a.md', '![[wiki/images/wrong/001.png]]');
  assert.equal(run(v, 'media.mjs', ['check']).status, 3);
}));

it('ambiguous embeds fail the media gate', () => fixture((v, w) => {
  w('wiki/images/a/001.png', 'a'); w('wiki/images/b/001.png', 'b');
  w('wiki/a.md', '![[001.png]]');
  assert.equal(run(v, 'media.mjs', ['check']).status, 3);
}));

it('checks standard markdown paths relative to the note and gates missing images', () => fixture((v, w) => {
  w('wiki/images/图 1.png', 'a');
  w('wiki/concepts/a.md', '![figure](../images/%E5%9B%BE%201.png)');
  const out = path.join(v, 'report.json');
  assert.equal(run(v, 'media.mjs', ['check', '--json', out]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).orphans, 0);
  w('wiki/concepts/a.md', '![figure](../missing.png)');
  assert.equal(run(v, 'media.mjs', ['check']).status, 3);
}));

it('refuses append with a corrupt manifest without overwriting prior images', () => fixture((v, w) => {
  w('source/a.md', '![Image](new.png)'); w('source/new.png', 'new');
  w('wiki/images/book/001.png', 'old');
  w('.molio/wiki-build/media-book.md', '![[wiki/images/book/001.png]]');
  w('.molio/wiki-build/figures-book.json', '{broken');
  const r = run(v, 'media.mjs', ['collect', path.join(v, 'source/a.md'), 'book', '--append']);
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(v, 'wiki/images/book/001.png'), 'utf8'), 'old');
}));

it('rejects traversal in collection names before writing', () => fixture((v, w) => {
  w('source/a.md', '![Image](new.png)'); w('source/new.png', 'new');
  const r = run(v, 'media.mjs', ['collect', path.join(v, 'source/a.md'), '../other']);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(v, 'wiki/other/001.png')), false);
}));

it('collect and append preserve earlier figures and generate valid embeds', () => fixture((v, w) => {
  w('source/a.md', '![Image](a.png)'); w('source/a.png', 'first');
  w('source/b.md', '![Image](b.png)'); w('source/b.png', 'second');
  assert.equal(run(v, 'media.mjs', ['collect', path.join(v, 'source/a.md'), 'book']).status, 0);
  assert.equal(run(v, 'media.mjs', ['collect', path.join(v, 'source/b.md'), 'book', '--append']).status, 0);
  assert.equal(fs.readFileSync(path.join(v, 'wiki/images/book/001.png'), 'utf8'), 'first');
  assert.equal(fs.readFileSync(path.join(v, 'wiki/images/book/002.png'), 'utf8'), 'second');
  w('wiki/a.md', fs.readFileSync(path.join(v, '.molio/wiki-build/media-book.md'), 'utf8'));
  assert.equal(run(v, 'media.mjs', ['check']).status, 0);
  assert.notEqual(run(v, 'media.mjs', ['collect', path.join(v, 'source/a.md'), 'book']).status, 0);
}));

it('collect accepts encoded and angle-bracket image paths with titles', () => fixture((v, w) => {
  w('source/图 (1).png', 'picture');
  w('source/a.md', '![Image](%E5%9B%BE%20(1).png)\n\n![Image](<图 (1).png> "caption")');
  const r = run(v, 'media.mjs', ['collect', path.join(v, 'source/a.md'), 'book']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(v, 'wiki/images/book/001.png'), 'utf8'), 'picture');
  const md = fs.readFileSync(path.join(v, '.molio/wiki-build/media-book.md'), 'utf8');
  assert.equal(md.match(/!\[\[wiki\/images\/book\/001.png\]\]/g)?.length, 2);
}));

it('collect leaves image syntax in code examples untouched', () => fixture((v, w) => {
  w('source/a.png', 'picture');
  w('source/a.md', '![Image](a.png)\n\n`![example](missing.png)`\n\n```md\n![example](missing.png)\n```');
  const r = run(v, 'media.mjs', ['collect', path.join(v, 'source/a.md'), 'book']);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(v, '.molio/wiki-build/media-book.md'), 'utf8');
  assert.ok(md.includes('![[wiki/images/book/001.png]]'));
  assert.equal(md.match(/!\[example\]\(missing.png\)/g)?.length, 2);
}));

it('collect refuses ambiguous top-level documents', () => fixture((v, w) => {
  w('source/a.md', '![Image](image.png)');
  w('source/volume-2.md', '![Image](image.png)'); w('source/image.png', 'picture');
  const r = run(v, 'media.mjs', ['collect', path.join(v, 'source'), 'book']);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(v, 'wiki/images/book/001.png')), false);
}));

it('collect does not substitute a basename for a wrong explicit image path', () => fixture((v, w) => {
  w('source/a.md', '![Image](missing/image.png)'); w('source/image.png', 'wrong picture');
  const r = run(v, 'media.mjs', ['collect', path.join(v, 'source/a.md'), 'book']);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(v, 'wiki/images/book/001.png')), false);
}));

it('collect requires a unique recursive basename fallback', () => fixture((v, w) => {
  w('source/a.md', '![Image](image.png)');
  w('source/chunk1/image.png', 'first picture'); w('source/chunk2/image.png', 'second picture');
  const args = ['collect', path.join(v, 'source/a.md'), 'book'];
  assert.notEqual(run(v, 'media.mjs', args).status, 0);
  assert.equal(fs.existsSync(path.join(v, 'wiki/images/book/001.png')), false);
  fs.unlinkSync(path.join(v, 'source/chunk2/image.png'));
  const r = run(v, 'media.mjs', args);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(v, 'wiki/images/book/001.png'), 'utf8'), 'first picture');
}));
