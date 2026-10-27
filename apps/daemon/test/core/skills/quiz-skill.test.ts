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
    // 主观题（subject）进围栏：answer 是评分点数组（web 物化进消息后脱离上下文可读）。
    assert.ok(parsed.instructions.includes('"subject"'), 'type enum must include subject');
    assert.ok(parsed.instructions.includes('评分点'), 'subject answer is a scoring-point array');
    // 批改协议：按物化消息首行【大题作答·第N题】确定性触发，不靠模型自觉。
    assert.ok(parsed.instructions.includes('大题作答'), 'grading protocol keys on the materialized message marker');
    assert.ok(parsed.instructions.includes('批改'), 'must document the grading protocol');
    // 「主观题降级」（围栏外方案）已退役：客观/填空/subject 进同一个围栏。
    assert.ok(!parsed.instructions.includes('主观题降级'), 'the outside-fence fallback is retired');
    assert.ok(!parsed.instructions.includes('自评'), 'no more self-grading fallback copy');
    // 题干配图：库内相对路径写法（答题端已支持解析成 raw URL 真实加载）。
    assert.ok(parsed.instructions.includes('![说明]('), 'must document the stem image syntax');
    assert.ok(parsed.instructions.includes('知识库根'), 'stem image paths resolve against the vault root');
    assert.ok(parsed.instructions.includes('不带前导'), 'stem image paths must not start with a slash');
    // 配图由考点驱动 + 双向锁：不预设学科比例；「如图」必须真嵌图，嵌图必须考点依赖。
    assert.ok(parsed.instructions.includes('考点'), 'image inclusion is driven by the test point, not a subject ratio');
    assert.ok(parsed.instructions.includes('如图'), 'a mentioned figure must be embedded, and vice versa');
    // 版本随协议扩充递增（诊断用）。
    assert.match(raw, /^version: 1\.3\.0$/m);
  });
});
