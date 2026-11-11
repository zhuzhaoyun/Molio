import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSkillsSourceDir } from '../../../src/core/skill-installer.js';

// 批改协议（大题作答）的冻结核心。三处调用方：quiz-generate / quiz-repractice / tutor。
// 改协议先改这份清单，再同步全部文件——漂移任何一处，本测试点名所有失守文件。
const FROZEN_GRADED_FRAGMENTS: { fragment: string; why: string }[] = [
  { fragment: '【大题作答·第N题】', why: 'materialized marker the grading protocol keys on' },
  { fragment: '【批改·第N题】得分 X/Y\n1. 命中｜<一句话依据>\n2. 部分｜<一句话依据，指出缺了什么>\n3. 未中｜<一句话依据>', why: 'reply format block the answer UI parses back into the quiz card' },
  { fragment: '部分命中数 × 0.5', why: 'score formula: partial hits weigh 0.5' },
  { fragment: '命中 / 部分 / 未中', why: 'frozen three-word status enum' },
  { fragment: 'X 必须等于逐点行的加权总和', why: 'score badge and breakdown must agree' },
  { fragment: '题目指纹', why: 'fingerprint line is bookkeeping — ignore when grading' },
];

// 第三处调用方 tutor 已接入；第四处调用方在此加一行。
const FROZEN_PROTOCOL_FILES = ['quiz-generate', 'quiz-repractice', 'tutor'];

describe('grading protocol cross-skill sync', () => {
  it('every grading-capable skill carries the frozen protocol core verbatim', () => {
    for (const skill of FROZEN_PROTOCOL_FILES) {
      const file = path.join(resolveSkillsSourceDir(), skill, 'SKILL.md');
      assert.ok(fs.existsSync(file), `missing ${file}`);
      const md = fs.readFileSync(file, 'utf8');
      for (const { fragment, why } of FROZEN_GRADED_FRAGMENTS) {
        assert.ok(
          md.includes(fragment),
          `${skill}/SKILL.md drifted on grading protocol: missing ${JSON.stringify(fragment.slice(0, 24))}… (${why})`,
        );
      }
    }
  });
});
