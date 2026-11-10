import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMd } from '@molio/contracts';
import { BUILTIN_SKILLS, resolveSkillsSourceDir } from '../../../src/core/skill-installer.js';

describe('bundled quiz-repractice skill', () => {
  it('is registered as a built-in skill', () => {
    assert.ok(BUILTIN_SKILLS.includes('quiz-repractice'));
  });

  it('ships a readable SKILL.md pinning the faithful-replay discipline', () => {
    const file = path.join(resolveSkillsSourceDir(), 'quiz-repractice', 'SKILL.md');
    assert.ok(fs.existsSync(file), `missing ${file}`);

    const parsed = parseSkillMd(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.name, 'quiz-repractice');
    assert.ok(parsed.description.length > 0, 'description drives trigger matching');
    assert.ok(parsed.instructions.includes('```quiz'), 'must document the fenced protocol');
    assert.ok(parsed.instructions.includes('逐字照抄'), 'faithful replay is the core discipline');
  });

  it('documents reconstruction rules, grading copy, and the removal protocol', () => {
    const file = path.join(resolveSkillsSourceDir(), 'quiz-repractice', 'SKILL.md');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parseSkillMd(raw);

    // 题源边界：只看当前库 题库/ 目录，不走 wiki 检索（防「知识库优先」劫持）。
    assert.ok(parsed.instructions.includes('题库/'), 'bank directory is the sole source');
    assert.ok(parsed.instructions.includes('不走 wiki 检索'), 'must opt out of the wiki-first rule');
    assert.ok(parsed.instructions.includes('原序'), 'replay keeps the archived question order');
    // 重建纪律：剥 ../ 配图前缀 + type 判定 + frontmatter 原 id。
    assert.ok(parsed.instructions.includes('剥掉'), 'image paths must strip the archived ../ prefix');
    assert.ok(parsed.instructions.includes('quiz_question_ids'), 'ids come from frontmatter');
    assert.ok(parsed.instructions.includes('对不上'), 'id mismatch falls back explicitly, never silently');
    assert.ok(parsed.instructions.includes('____'), 'fill detection via blank marker');
    assert.ok(parsed.instructions.includes('评分点'), 'subject detection via scoring points');
    assert.ok(parsed.instructions.includes('自动补默认'), 'judge omits options; parser fills the default pair');
    // 批改协议副本（与 quiz-generate 同步维护，这里钉冻结格式串防漂移）。
    assert.ok(parsed.instructions.includes('大题作答'), 'grading protocol keys on the materialized marker');
    assert.ok(parsed.instructions.includes('批改·第'), 'reply must carry the grading marker line');
    assert.ok(parsed.instructions.includes('命中'), 'point lines use the frozen status enum');
    assert.ok(parsed.instructions.includes('部分命中数 × 0.5'), 'score formula must be pinned');
    assert.ok(parsed.instructions.includes('X 必须等于逐点行的加权总和'), 'score and breakdown must agree');
    assert.ok(parsed.instructions.includes('题目指纹'), 'fingerprint line is bookkeeping — ignore when grading');
    // 移除协议：答对才问；客观题判分不进对话（agent 无从自行得知对错）；
    // 移空删整文件；不生成新题。
    assert.ok(parsed.instructions.includes('移除'), 'removal offer after correct answers');
    assert.ok(parsed.instructions.includes('不会进入对话'), 'objective grading results never reach the conversation');
    assert.ok(parsed.instructions.includes('删除整个文件'), 'empty file gets deleted');
    assert.ok(parsed.instructions.includes('不生成、不改写'), 'no new-question generation, ever');
    // 版本（诊断用）。
    assert.match(raw, /^version: 1\.0\.0$/m);
  });
});
