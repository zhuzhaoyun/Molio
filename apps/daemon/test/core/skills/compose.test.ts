import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  USER_CUSTOM_BEGIN,
  USER_CUSTOM_END,
  composeSkillMd,
  hasOverlay,
  materializeComposedSource,
} from '../../../src/core/skills/compose.js';

const RAW = '---\nname: wiki-query\ndescription: d\nallowed-tools: Read, Grep\n---\n\n## 流程\n\n先读索引。';

describe('skills/compose composeSkillMd', () => {
  it('returns the raw string unchanged for empty / whitespace-only overlay (byte identity)', () => {
    assert.equal(composeSkillMd(RAW, ''), RAW);
    assert.equal(composeSkillMd(RAW, '   \n\t '), RAW);
    assert.equal(composeSkillMd(RAW, ''), RAW); // idempotent, no sentinel churn
  });

  it('appends the sentinel-wrapped overlay with the exact expected shape', () => {
    const overlay = '输出一律用简体中文。';
    const out = composeSkillMd(RAW, overlay);
    assert.equal(out, `${RAW}\n\n${USER_CUSTOM_BEGIN}\n${overlay}\n${USER_CUSTOM_END}\n`);
  });

  it('preserves CRLF and multibyte content in the overlay byte-for-byte', () => {
    const overlay = '第一行\r\n第二行 𝕏🔬 emoji';
    const out = composeSkillMd(RAW, overlay);
    // No newline normalization, no unicode mangling: the overlay bytes appear verbatim.
    assert.ok(Buffer.from(out).includes(Buffer.from(overlay)), 'overlay bytes must appear verbatim');
    assert.ok(!out.includes('\r\n\r\n'), 'no injected blank lines');
  });

  it('hasOverlay: null/undefined/empty/whitespace are all false', () => {
    assert.equal(hasOverlay(null), false);
    assert.equal(hasOverlay(undefined), false);
    assert.equal(hasOverlay(''), false);
    assert.equal(hasOverlay('  \n '), false);
    assert.equal(hasOverlay('x'), true);
  });
});

describe('skills/compose materializeComposedSource', () => {
  function makeSourceDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-compose-src-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), RAW, 'utf8');
    fs.writeFileSync(path.join(dir, 'scripts', 'helper.py'), 'print(1)\n', 'utf8');
    return dir;
  }

  it('returns the source dir itself (noop dispose) when there is no overlay', () => {
    const src = makeSourceDir();
    const m = materializeComposedSource(src, null);
    assert.equal(m.dir, src);
    assert.doesNotThrow(() => m.dispose());
    assert.ok(fs.existsSync(src), 'dispose must not remove the real source');
  });

  it('builds a temp tree: siblings copied verbatim, SKILL.md composed', () => {
    const src = makeSourceDir();
    const overlay = '附加要求';
    const m = materializeComposedSource(src, overlay);
    try {
      assert.notEqual(m.dir, src);
      assert.ok(m.dir.startsWith(os.tmpdir()), 'temp materialization lives in os.tmpdir()');
      assert.equal(
        fs.readFileSync(path.join(m.dir, 'scripts', 'helper.py'), 'utf8'),
        'print(1)\n',
      );
      const composed = fs.readFileSync(path.join(m.dir, 'SKILL.md'), 'utf8');
      assert.equal(composed, composeSkillMd(RAW, overlay));
      assert.ok(composed.includes(overlay));
      // The ORIGINAL source is untouched.
      assert.equal(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'), RAW);
    } finally {
      m.dispose();
    }
    assert.equal(fs.existsSync(m.dir), false, 'dispose removes the temp tree');
  });
});
