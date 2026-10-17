import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNoteRelative, normalizeEmbedTarget, preprocessLocalImages } from './kbImage.ts';

const VAULT = 'vault-1';
const ORIGIN = 'http://localhost:5173';

/** The URL preprocessLocalImages would emit for `path`. */
const raw = (path: string) => `${ORIGIN}/api/knowledge/vaults/${VAULT}/raw/${encodeURIComponent(path)}`;

describe('resolveNoteRelative', () => {
  it('resolves against the note own folder (Obsidian rule)', () => {
    assert.equal(
      resolveNoteRelative('wiki/concepts/集合.md', 'images/a.png'),
      'wiki/concepts/images/a.png',
    );
  });

  it('walks up with ..', () => {
    assert.equal(
      resolveNoteRelative('wiki/concepts/集合.md', '../images/a.png'),
      'wiki/images/a.png',
    );
  });

  it('a note at the vault root has no leading directory', () => {
    assert.equal(resolveNoteRelative('集合.md', 'images/a.png'), 'images/a.png');
  });

  it('ignores . and redundant slashes', () => {
    assert.equal(
      resolveNoteRelative('wiki/concepts/集合.md', './images//a.png'),
      'wiki/concepts/images/a.png',
    );
  });

  it('PRESERVES a .. that would escape the vault, so the daemon rejects it', () => {
    assert.equal(
      resolveNoteRelative('集合.md', '../../etc/passwd.png'),
      '../../etc/passwd.png',
    );
  });

  it('does not let one .. cancel another above the root', () => {
    // Two pops against an empty stack would collapse to `etc/passwd.png` —
    // a real path inside the vault, i.e. silently the WRONG image.
    assert.equal(resolveNoteRelative('a.md', '../../etc/x.png'), '../../etc/x.png');
  });
});

describe('normalizeEmbedTarget', () => {
  it('strips a leading slash (root-relative spelled the absolute way)', () => {
    assert.equal(normalizeEmbedTarget('/wiki/images/a.png'), 'wiki/images/a.png');
  });

  it('strips a leading ./', () => {
    assert.equal(normalizeEmbedTarget('./wiki/images/a.png'), 'wiki/images/a.png');
  });

  it('converts Windows backslashes', () => {
    assert.equal(normalizeEmbedTarget('wiki\\images\\a.png'), 'wiki/images/a.png');
  });

  it('leaves a plain vault-relative path alone', () => {
    assert.equal(normalizeEmbedTarget('wiki/images/a.png'), 'wiki/images/a.png');
  });
});

describe('preprocessLocalImages', () => {
  it('decodes URL paths once and supports balanced parentheses and titles', () => {
    assert.equal(preprocessLocalImages('![a](%E5%9B%BE%20(1).png)', VAULT, 'wiki/a.md', ORIGIN),
      `![a](${raw('wiki/图 (1).png')})`);
    assert.equal(preprocessLocalImages('![a](<图 (1).png> "caption")', VAULT, 'wiki/a.md', ORIGIN),
      `![a](${raw('wiki/图 (1).png')} "caption")`);
    assert.equal(preprocessLocalImages('![a](图 1.png)', VAULT, 'wiki/a.md', ORIGIN),
      `![a](${raw('wiki/图 1.png')})`);
  });

  it('preserves literal image examples in fenced and inline code', () => {
    const md = '`![x](x.png)`\n\n```md\n![x](x.png)\n```';
    assert.equal(preprocessLocalImages(md, VAULT, 'wiki/a.md', ORIGIN), md);
  });
  it('rewrites a note-relative image to a raw URL', () => {
    const out = preprocessLocalImages('![图](images/a.png)', VAULT, 'wiki/concepts/集合.md', ORIGIN);
    assert.equal(out, `![图](${raw('wiki/concepts/images/a.png')})`);
  });

  it('treats a leading slash as vault-root-relative, not as a filesystem path', () => {
    const out = preprocessLocalImages('![](/wiki/images/a.png)', VAULT, 'wiki/concepts/集合.md', ORIGIN);
    assert.equal(out, `![](${raw('wiki/images/a.png')})`);
  });

  it('falls back to the path as written when the note path is unknown', () => {
    const out = preprocessLocalImages('![](./images/a.png)', VAULT, undefined, ORIGIN);
    assert.equal(out, `![](${raw('images/a.png')})`);
  });

  it('leaves external URLs untouched', () => {
    const md = '![x](https://example.com/a.png)';
    assert.equal(preprocessLocalImages(md, VAULT, 'a.md', ORIGIN), md);
  });

  it('leaves data URIs untouched', () => {
    const md = '![x](data:image/png;base64,AAAA)';
    assert.equal(preprocessLocalImages(md, VAULT, 'a.md', ORIGIN), md);
  });

  it('leaves protocol-relative URLs untouched', () => {
    const md = '![x](//cdn.example.com/a.png)';
    assert.equal(preprocessLocalImages(md, VAULT, 'a.md', ORIGIN), md);
  });

  it('leaves non-image links untouched', () => {
    const md = '![x](notes/a.md)';
    assert.equal(preprocessLocalImages(md, VAULT, 'a.md', ORIGIN), md);
  });

  it('rewrites every image in the document, not just the first', () => {
    const out = preprocessLocalImages('![a](1.png)\n![b](2.png)', VAULT, 'wiki/a.md', ORIGIN);
    assert.equal(out, `![a](${raw('wiki/1.png')})\n![b](${raw('wiki/2.png')})`);
  });
});
