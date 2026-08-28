import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  expandComposerMessage,
  fileRefMarkdown,
  flattenTreePaths,
} from './composerExpand.ts';

/**
 * Pure expansion for the Claude Code-style composer refs:
 *   `/skill-name` (leading, matching an enabled skill) → natural-language prefix
 *   `@path`       (matching a vault file/folder)       → markdown link
 * Everything unmatched stays literal — emails and stray slashes are never touched.
 */
describe('expandComposerMessage', () => {
  const skills = [{ id: 's1', name: 'docling' }, { id: 's2', name: 'wiki-build' }];
  const paths = ['notes/审计.md', 'test.md', 'docs/', 'wiki'];

  it('expands a leading /name that matches an enabled skill into the prefix', () => {
    const out = expandComposerMessage('/docling 转换这个文件', {
      skills,
      skillPrefixTemplate: '用 {name} skill ',
    });
    assert.equal(out, '用 docling skill 转换这个文件');
  });

  it('expands the skill reference alone with trailing space preserved', () => {
    const out = expandComposerMessage('/wiki-build', {
      skills,
      skillPrefixTemplate: '用 {name} skill ',
    });
    assert.equal(out, '用 wiki-build skill ');
  });

  it('matches skill names case-insensitively for latin names', () => {
    const out = expandComposerMessage('/Docling go', {
      skills,
      skillPrefixTemplate: 'Use the {name} skill to ',
    });
    assert.equal(out, 'Use the docling skill to go');
  });

  it('leaves text unchanged when leading /name matches no skill', () => {
    const out = expandComposerMessage('/doc 处理', {
      skills,
      skillPrefixTemplate: '用 {name} skill ',
    });
    assert.equal(out, '/doc 处理');
  });

  it('leaves text unchanged when no skills are provided', () => {
    const out = expandComposerMessage('/docling go', { skillPrefixTemplate: '用 {name} skill ' });
    assert.equal(out, '/docling go');
  });

  it('expands a matching @file into a markdown link', () => {
    const out = expandComposerMessage('帮我看 @notes/审计.md 有什么问题', {
      knownPaths: paths,
    });
    assert.equal(out, '帮我看 [📄 审计.md](notes/审计.md) 有什么问题');
  });

  it('expands a root-level @file', () => {
    const out = expandComposerMessage('总结 @test.md', { knownPaths: paths });
    assert.equal(out, '总结 [📄 test.md](test.md)');
  });

  it('expands a @folder with the enumerate-directory title hint', () => {
    const out = expandComposerMessage('读取 @docs/ 全部内容', { knownPaths: paths });
    assert.equal(
      out,
      '读取 [📁 docs/](docs/ "文件夹，请读取其下所有相关文件") 全部内容',
    );
  });

  it('leaves an unmatched @token literal (emails are not mangled)', () => {
    const text = '联系 t@example.com 或看 @test.md';
    const out = expandComposerMessage(text, { knownPaths: paths });
    assert.equal(out, '联系 t@example.com 或看 [📄 test.md](test.md)');
  });

  it('expands skill prefix AND @refs together, prefix first', () => {
    const out = expandComposerMessage('/docling 处理 @notes/审计.md', {
      skills,
      skillPrefixTemplate: '用 {name} skill ',
      knownPaths: paths,
    });
    assert.equal(out, '用 docling skill 处理 [📄 审计.md](notes/审计.md)');
  });

  it('handles multiple @refs in one message', () => {
    const out = expandComposerMessage('@test.md 和 @notes/审计.md 对比', { knownPaths: paths });
    assert.equal(out, '[📄 test.md](test.md) 和 [📄 审计.md](notes/审计.md) 对比');
  });

  it('no-ops on plain text', () => {
    const text = '普通消息，没有引用';
    assert.equal(expandComposerMessage(text, { skills, knownPaths: paths }), text);
  });
});

describe('fileRefMarkdown', () => {
  it('renders a file link', () => {
    assert.equal(fileRefMarkdown('notes/审计.md', false), '[📄 审计.md](notes/审计.md)');
  });

  it('renders a folder link with the enumerate title', () => {
    assert.equal(
      fileRefMarkdown('docs/', true),
      '[📁 docs/](docs/ "文件夹，请读取其下所有相关文件")',
    );
  });
});

describe('flattenTreePaths', () => {
  it('collects files and directories (dirs with trailing slash) from a tree', () => {
    const tree = [
      {
        id: '1', name: 'notes', path: 'notes', type: 'directory' as const,
        children: [{ id: '2', name: 'a.md', path: 'notes/a.md', type: 'file' as const }],
      },
      { id: '3', name: 'b.md', path: 'b.md', type: 'file' as const },
    ];
    assert.deepEqual(
      [...flattenTreePaths(tree)].sort(),
      ['b.md', 'notes/', 'notes/a.md'],
    );
  });
});
