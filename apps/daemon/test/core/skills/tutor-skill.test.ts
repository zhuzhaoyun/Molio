import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMd } from '@molio/contracts';
import { BUILTIN_SKILLS, resolveSkillsSourceDir } from '../../../src/core/skill-installer.js';

describe('bundled tutor skill', () => {
  it('is registered as a built-in skill', () => {
    assert.ok(BUILTIN_SKILLS.includes('tutor'));
  });

  it('ships a readable SKILL.md pinning the teaching-loop disciplines', () => {
    const file = path.join(resolveSkillsSourceDir(), 'tutor', 'SKILL.md');
    assert.ok(fs.existsSync(file), `missing ${file}`);
    const parsed = parseSkillMd(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.name, 'tutor');
    assert.ok(parsed.description.length > 0, 'description drives trigger matching');
    assert.match(fs.readFileSync(file, 'utf8'), /^version: 1\.0\.0$/m);
  });

  it('pins the four-way trigger division in the routing surface', () => {
    const parsed = parseSkillMd(fs.readFileSync(path.join(resolveSkillsSourceDir(), 'tutor', 'SKILL.md'), 'utf8'));
    // 四方分工（routing surface：description 与正文都要有）
    for (const surface of [parsed.description, parsed.instructions]) {
      assert.ok(surface.includes('wiki-query'), 'answers/explanations route to wiki-query');
      assert.ok(surface.includes('quiz-generate'), 'fresh questions route to quiz-generate');
      assert.ok(surface.includes('quiz-repractice'), 'archived replay routes to quiz-repractice');
    }
    // 触发词不占三方已占的词（只查 Triggers on 段——分工句里提到对方 skill 的词不算占词）
    const triggers = parsed.description.slice(parsed.description.indexOf('Triggers on:'));
    assert.ok(triggers.length > 0, 'description ends with a Triggers on segment');
    assert.ok(!triggers.includes('出题'), 'quiz-generate owns 出题');
    assert.ok(!triggers.includes('重练'), 'quiz-repractice owns 重练');
    assert.ok(!triggers.includes('讲解'), 'wiki-query owns 讲解');
  });

  it('pins diagnosis, textbook anchoring, adaptive feedback, and tutorial save-off disciplines', () => {
    const parsed = parseSkillMd(fs.readFileSync(path.join(resolveSkillsSourceDir(), 'tutor', 'SKILL.md'), 'utf8'));
    // 诊断：自述为主，拿不准才探底
    assert.ok(parsed.instructions.includes('探底'), 'probing questions only when self-description is unclear');
    // 讲解：检索纪律 + 红线 + 教材锚定
    assert.ok(parsed.instructions.includes('禁止只凭训练记忆'), 'KB-grounded or stay silent');
    assert.ok(parsed.instructions.includes('覆盖不足'), 'say so when the vault lacks coverage');
    assert.ok(parsed.instructions.includes('不编造页码'), 'never invent textbook coordinates');
    assert.ok(parsed.instructions.includes('例题'), 'anchor to textbook coordinates incl. worked examples');
    // 反馈源 v0（§6.6 拍板）：客观题失明已知边界；解答题为主；邀请报告是闭环启动器
    assert.ok(parsed.instructions.includes('客观题'), 'objective questions are lightweight self-checks (grading blind spot)');
    assert.ok(parsed.instructions.includes('解答题为主'), 'feedback-bearing practice leans subject-type');
    assert.ok(parsed.instructions.includes('告诉我'), 'agent invites the user to report results — without it the loop stalls silently');
    // 反馈调整（教学的核心新行为）
    assert.ok(parsed.instructions.includes('变式'), 'wrong answer → re-teach from another angle + variant question');
    // 真机回归（2026-11-12，glm）：反馈回合以 sandbox-suggest 替代变式题收尾 → 钉死变式题不可替代
    assert.ok(parsed.instructions.includes('不能替代变式题'), 'a sandbox suggestion must not replace the variant question');
    // 教程沉淀（C2）：确认后才写、一次性询问、日期在前文件名
    assert.ok(parsed.instructions.includes('教程/'), 'tutorials land in 教程/');
    assert.ok(parsed.instructions.includes('<日期>-<主题>.md'), 'filename is date-first, aligned with 题库/');
    assert.ok(parsed.instructions.includes('最多问一次'), 'one save offer per teaching session, never nag');
    assert.ok(parsed.instructions.includes('确认后才'), 'never write the tutorial without user consent');
  });
});
