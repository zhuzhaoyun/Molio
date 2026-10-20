import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMd } from '@molio/contracts';
import { BUILTIN_SKILLS, resolveSkillsSourceDir } from '../../../src/core/skill-installer.js';

describe('bundled rule-sandbox skill', () => {
  it('is registered as a built-in skill', () => {
    assert.ok(BUILTIN_SKILLS.includes('rule-sandbox'));
  });

  it('ships a readable SKILL.md with the protocol and source rule', () => {
    const file = path.join(resolveSkillsSourceDir(), 'rule-sandbox', 'SKILL.md');
    assert.ok(fs.existsSync(file), `missing ${file}`);

    const parsed = parseSkillMd(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.name, 'rule-sandbox');
    assert.ok(parsed.description.length > 0, 'description drives trigger matching');
    assert.ok(parsed.instructions.includes('```rule-sandbox'), 'must document the fenced protocol');
    assert.ok(parsed.instructions.includes('sources'), 'must require sources');
    assert.ok(parsed.instructions.includes('JSON.parse'), 'must require valid JSON');
  });

  it('requires retrieval before generating and forbids training-memory content', () => {
    const file = path.join(resolveSkillsSourceDir(), 'rule-sandbox', 'SKILL.md');
    const parsed = parseSkillMd(fs.readFileSync(file, 'utf8'));
    assert.ok(parsed.instructions.includes('wiki/INDEX.md'), 'must retrieve from the vault index first');
    assert.ok(parsed.instructions.includes('训练记忆'), 'must forbid generating from training memory');
  });

  it('documents the single-param rule and the plain-number condition values', () => {
    const file = path.join(resolveSkillsSourceDir(), 'rule-sandbox', 'SKILL.md');
    const parsed = parseSkillMd(fs.readFileSync(file, 'utf8'));
    // P1 是单轴模板：params 恰好 1 个。
    assert.ok(parsed.instructions.includes('恰好 1 个'), 'must state the single-param rule');
    // 条件值必须数字裸写，不能是 "55" 这种字符串数字。
    assert.ok(parsed.instructions.includes('"55"'), 'must warn about string-number condition values');
  });
});
