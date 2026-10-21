import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMd } from '@molio/contracts';
import { BUILTIN_SKILLS, resolveSkillsSourceDir } from '../../../src/core/skill-installer.js';

describe('bundled quiz-generate skill', () => {
  it('is registered as a built-in skill', () => {
    assert.ok(BUILTIN_SKILLS.includes('quiz-generate'));
  });

  it('ships a readable SKILL.md with the quiz protocol and source rule', () => {
    const file = path.join(resolveSkillsSourceDir(), 'quiz-generate', 'SKILL.md');
    assert.ok(fs.existsSync(file), `missing ${file}`);

    const parsed = parseSkillMd(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.name, 'quiz-generate');
    assert.ok(parsed.description.length > 0, 'description drives trigger matching');
    assert.ok(parsed.instructions.includes('```quiz'), 'must document the fenced protocol');
    assert.ok(parsed.instructions.includes('sources'), 'must require sources');
    assert.ok(parsed.instructions.includes('JSON.parse'), 'must require valid JSON');
  });
});
