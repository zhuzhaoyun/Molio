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

  it('documents the fill protocol and the subjective-question fallback', () => {
    const file = path.join(resolveSkillsSourceDir(), 'quiz-generate', 'SKILL.md');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parseSkillMd(raw);

    // 填空题型：无 options，answer 是可接受写法数组。
    assert.ok(parsed.instructions.includes('"fill"'), 'type enum must include fill');
    assert.ok(parsed.instructions.includes('____'), 'must mark the blank in stem');
    assert.ok(parsed.instructions.includes('64'), 'answer item cap must match daemon chosen limit');
    // 写法变体规则（领域无关）：难输入字符须给键盘可打变体，且变体不得改变考察点。
    assert.ok(parsed.instructions.includes('sqrt'), 'must document a keyboard-typeable variant example');
    assert.ok(parsed.instructions.includes('考察点'), 'variants must not change what is being tested');
    // 答题区不渲染 LaTeX：题干/选项必须用纯文本记法（√ x²），禁止 $…$ 源码。
    assert.ok(parsed.instructions.includes('LaTeX'), 'must forbid LaTeX source in stems/options');
    // 主观题降级（混合请求不得整体退化成纯文本，主观题不进围栏）。
    assert.ok(parsed.instructions.includes('主观题'), 'must document the subjective-question fallback');
    assert.ok(parsed.instructions.includes('围栏外'), 'subjective questions stay outside the fence');
    // 版本随协议扩充递增（诊断用）。
    assert.match(raw, /^version: 1\.1\.0$/m);
  });
});
