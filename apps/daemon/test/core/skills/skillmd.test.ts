import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillMd, generateSkillMd, stripFrontmatter, deriveSkillName } from '@molio/contracts';

/**
 * SKILL.md parsing — the shared format behind the skill form and the importer.
 *
 * Regression: the "新建技能" paste dialog used to require a frontmatter `name:`
 * and dead-ended on "请填写名称" with no field to type one when users pasted a
 * plain markdown file. parseSkillMd falls back to the first heading in the
 * body, and deriveSkillName guarantees a non-empty name (name → description →
 * first 10 chars → "skills") so creation NEVER asks for a manual name.
 */
describe('parseSkillMd', () => {
  it('prefers the frontmatter name over a body heading', () => {
    const parsed = parseSkillMd('---\nname: 前端名\ndescription: d\n---\n\n# 标题名\n\n正文');
    assert.equal(parsed.name, '前端名');
    assert.equal(parsed.description, 'd');
    assert.equal(parsed.instructions, '# 标题名\n\n正文');
  });

  it('falls back to the first heading when there is no frontmatter at all', () => {
    const parsed = parseSkillMd('# 周报助手\n\n按以下步骤生成周报……');
    assert.equal(parsed.name, '周报助手');
    // The heading line stays part of the instructions — the body is the skill.
    assert.equal(parsed.instructions, '# 周报助手\n\n按以下步骤生成周报……');
  });

  it('falls back to the first heading when frontmatter exists but has no name', () => {
    const parsed = parseSkillMd('---\ndescription: 只有描述\n---\n\n# 来自标题\n正文');
    assert.equal(parsed.name, '来自标题');
    assert.equal(parsed.description, '只有描述');
  });

  it('an empty frontmatter name also falls back to the heading', () => {
    const parsed = parseSkillMd('---\nname:\n---\n\n# 兜底标题\n正文');
    assert.equal(parsed.name, '兜底标题');
  });

  it('accepts any heading level and skips hash lines without whitespace (#hashtag)', () => {
    assert.equal(parseSkillMd('## 二级标题\n正文').name, '二级标题');
    assert.equal(parseSkillMd('#hashtag 不是标题\n正文').name, '');
  });

  it('ignores headings inside fenced code blocks', () => {
    const md = '```bash\n# 这是注释不是标题\necho hi\n```\n\n# 真标题\n正文';
    assert.equal(parseSkillMd(md).name, '真标题');
  });

  it('ignores shebang-style lines', () => {
    assert.equal(parseSkillMd('#!/usr/bin/env node\n正文').name, '');
  });

  it('strips inline markdown formatting from the heading text', () => {
    assert.equal(parseSkillMd('# **加粗**标题\n正文').name, '加粗标题');
    assert.equal(parseSkillMd('# [链接文字](https://example.com)\n正文').name, '链接文字');
    assert.equal(parseSkillMd('# `代码`名\n正文').name, '代码名');
  });

  it('keeps underscores in heading text (file-style titles)', () => {
    // Regression: the emphasis-strip character class used to include `_`,
    // which collapsed `# my_file_guide` into `myfileguide`. Underscores are
    // far more common in real titles than `_emphasis_` headings.
    assert.equal(parseSkillMd('# my_file_guide\n正文').name, 'my_file_guide');
    // Genuine emphasis marks still strip.
    assert.equal(parseSkillMd('# *starred* title\n正文').name, 'starred title');
  });

  it('returns an empty name when nothing is extractable', () => {
    assert.equal(parseSkillMd('一段没有任何标题的纯文本。').name, '');
    assert.equal(parseSkillMd('').name, '');
  });

  it('handles CRLF content (Windows pastes)', () => {
    const parsed = parseSkillMd('---\r\nname: CRLF名\r\n---\r\n\r\n正文');
    assert.equal(parsed.name, 'CRLF名');
    const heading = parseSkillMd('# CRLF标题\r\n\r\n正文');
    assert.equal(heading.name, 'CRLF标题');
  });

  it('generate → parse round-trips (edit mode relies on this)', () => {
    const md = generateSkillMd('写文章', '写一篇文章', '先列大纲。');
    const parsed = parseSkillMd(md);
    assert.equal(parsed.name, '写文章');
    assert.equal(parsed.description, '写一篇文章');
    assert.equal(parsed.instructions, '先列大纲。');
  });
});

/**
 * Regression (user report): pasting a platform skill whose `---` fences were
 * lost used to leave name+description empty, and the first-10-chars fallback
 * named the skill literally "name: khaz" instead of "khazix-writer".
 * Unfenced field blocks, BOMs, and YAML block scalars must all parse.
 */
describe('parseSkillMd — messy real-world pastes', () => {
  it('parses an unfenced block starting straight with name:', () => {
    const raw = [
      'name: khazix-writer',
      'description: |',
      '  数字生命卡兹克（Khazix）的公众号长文写作skill。',
      '',
      '按以下步骤写作……',
    ].join('\n');
    const parsed = parseSkillMd(raw);
    assert.equal(parsed.name, 'khazix-writer');
    assert.equal(parsed.description, '数字生命卡兹克（Khazix）的公众号长文写作skill。');
    assert.equal(parsed.instructions, '按以下步骤写作……');
  });

  it('unfenced block with a collapsed one-line block scalar (description: | text)', () => {
    const parsed = parseSkillMd('name: 直接描述\ndescription: | 一行写完的描述\n正文');
    assert.equal(parsed.name, '直接描述');
    assert.equal(parsed.description, '一行写完的描述');
    assert.equal(parsed.instructions, '正文');
  });

  it('unfenced block needs no blank line before the body', () => {
    const parsed = parseSkillMd('name: 无空行\ndescription: d\n正文第一行');
    assert.equal(parsed.name, '无空行');
    assert.equal(parsed.description, 'd');
    assert.equal(parsed.instructions, '正文第一行');
  });

  it('unfenced fields only (no body) leave empty instructions', () => {
    const parsed = parseSkillMd('name: 只有字段\ndescription: 没有正文');
    assert.equal(parsed.name, '只有字段');
    assert.equal(parsed.instructions, '');
  });

  it('unfenced block also works with CRLF', () => {
    const parsed = parseSkillMd('name: crlf-unfenced\r\ndescription: d\r\n\r\n正文');
    assert.equal(parsed.name, 'crlf-unfenced');
    assert.equal(parsed.instructions, '正文');
  });

  it('a leading non-skill field line is NOT treated as frontmatter', () => {
    // `title:` is not one of the known skill keys — the text stays body.
    const parsed = parseSkillMd('title: 不是frontmatter\n正文');
    assert.equal(parsed.name, '');
    assert.equal(parsed.instructions, 'title: 不是frontmatter\n正文');
  });

  it('tolerates a BOM before the opening fence (Windows editors)', () => {
    const parsed = parseSkillMd('﻿---\nname: BOM名\n---\n正文');
    assert.equal(parsed.name, 'BOM名');
    assert.equal(parsed.instructions, '正文');
  });

  it('tolerates a BOM built from the char code (escape-safe regression check)', () => {
    // Same guarantee as above, but constructed via String.fromCharCode so the
    // test itself never carries an invisible literal that an editor could drop.
    const bom = String.fromCharCode(0xfeff);
    assert.equal(parseSkillMd(bom + '---\nname: 码点BOM\n---\n正文').name, '码点BOM');
    // Unfenced block after a BOM must also be recognized.
    const parsed = parseSkillMd(bom + 'name: 无围栏BOM\ndescription: d\n正文');
    assert.equal(parsed.name, '无围栏BOM');
    assert.equal(parsed.instructions, '正文');
  });

  it('tolerates leading blank lines before the opening fence', () => {
    const parsed = parseSkillMd('\n\n---\nname: 前导空行\n---\n正文');
    assert.equal(parsed.name, '前导空行');
  });

  it('extracts a fenced block-scalar description (was parsed as literal "|")', () => {
    const md = '---\nname: 块描述\ndescription: |\n  第一行\n  第二行\n---\n正文';
    const parsed = parseSkillMd(md);
    assert.equal(parsed.name, '块描述');
    assert.equal(parsed.description, '第一行\n第二行');
  });

  it('folds a `>` block scalar into one line', () => {
    const md = '---\ndescription: >\n  折叠\n  成一行\n---\n正文';
    assert.equal(parseSkillMd(md).description, '折叠 成一行');
  });
});

/**
 * Regression (user report): a platform copy can collapse the frontmatter onto
 * ONE line — `name: khazix-writer description: | <text>` — losing the newline
 * between fields. The parser used to swallow everything after `name:` into the
 * name (so the name contained the whole description) and never extract the
 * description at all. Collapsed known fields must be re-split onto their own
 * lines, in both fenced and unfenced blocks.
 */
describe('parseSkillMd — fields collapsed onto one line', () => {
  it('splits name + inline block-scalar description collapsed onto one line (user report)', () => {
    const description =
      '数字生命卡兹克（Khazix）的公众号长文写作skill。包含完整的写作风格规则、四层自检体系、内容方法论和风格示例库。 ' +
      '当用户需要撰写公众号文章、写稿子、续写文章、根据素材产出长文时使用。适用于用户丢过来素材说"帮我写篇文章"的场景。';
    const raw = [
      `name: khazix-writer description: | ${description}`,
      '卡兹克公众号长文写作',
      '这是卡兹克（Khazix）的个人写作风格skill。',
    ].join('\n');
    const parsed = parseSkillMd(raw);
    assert.equal(parsed.name, 'khazix-writer');
    assert.equal(parsed.description, description);
    assert.equal(parsed.instructions, '卡兹克公众号长文写作\n这是卡兹克（Khazix）的个人写作风格skill。');
  });

  it('splits all three fields collapsed onto one line inside --- fences', () => {
    const parsed = parseSkillMd('---\nname: n1 description: d1 version: 1.0.0\n---\n正文');
    assert.equal(parsed.name, 'n1');
    assert.equal(parsed.description, 'd1');
    assert.equal(parsed.instructions, '正文');
  });

  it('a collapsed line ending in a bare block-scalar indicator swallows its indented body', () => {
    const raw = ['name: n2 description: |', '  第一行', '  第二行', '正文'].join('\n');
    const parsed = parseSkillMd(raw);
    assert.equal(parsed.name, 'n2');
    assert.equal(parsed.description, '第一行\n第二行');
    assert.equal(parsed.instructions, '正文');
  });

  it('does NOT split a block-scalar body line that merely mentions a field key', () => {
    const md = '---\ndescription: |\n  这一行提到 name: 例子 但它不是字段\n---\n正文';
    const parsed = parseSkillMd(md);
    assert.equal(parsed.description, '这一行提到 name: 例子 但它不是字段');
    assert.equal(parsed.instructions, '正文');
  });

  it('plain values containing a colon are not mistaken for collapsed fields', () => {
    // `see:` is not a known skill key — it stays part of the description value.
    const parsed = parseSkillMd('---\ndescription: 用法 see: 文档\n---\n正文');
    assert.equal(parsed.description, '用法 see: 文档');
  });
});

describe('deriveSkillName', () => {
  it('prefers the parsed name above all else', () => {
    assert.equal(deriveSkillName(parseSkillMd('---\nname: 真名\ndescription: d\n---\n\n正文')), '真名');
  });

  it('falls back to the heading-derived name', () => {
    assert.equal(deriveSkillName(parseSkillMd('# 标题名\n\n正文')), '标题名');
  });

  it('falls back to the description when there is no name or heading', () => {
    assert.equal(deriveSkillName(parseSkillMd('---\ndescription: 技能描述\n---\n\n正文')), '技能描述');
  });

  it('falls back to the first 10 characters of the content', () => {
    // 10 CJK code points — counted by code point, not UTF-16 unit.
    assert.equal(deriveSkillName(parseSkillMd('一二三四五六七八九十一二三四')), '一二三四五六七八九十');
    // Newlines within the window are collapsed so the name stays single-line.
    assert.equal(deriveSkillName(parseSkillMd('ab\ncd\nef\ngh\nij\nkl')), 'ab cd ef g');
  });

  it('falls back to the literal "skills" when nothing else is available', () => {
    assert.equal(deriveSkillName({ name: '', description: '', instructions: '' }), 'skills');
    assert.equal(deriveSkillName(parseSkillMd('   ')), 'skills');
  });
});

describe('stripFrontmatter', () => {
  it('returns the body unchanged when there is no frontmatter', () => {
    assert.equal(stripFrontmatter('# 标题\n正文'), '# 标题\n正文');
  });
});
