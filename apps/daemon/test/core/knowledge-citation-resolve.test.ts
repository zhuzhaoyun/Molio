/**
 * Citation path resolution — regression tests for the 2026-09 support
 * incident: chat citations truncated from Windows absolute paths arrived as
 * '<vaultDirName>/raw/…' and were unresolvable forever ("无法打开文件"),
 * even though the file sat at 'raw/…' inside the vault.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from '../../src/core/knowledge.js';

describe('resolveWithFallbacks — citation candidates', () => {
  let tmp: string;
  let vp: string; // vault root, dir name intentionally distinctive
  const DIR_NAME_STEM = '01M10TEST-vault';

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'molio-cite-'));
    vp = join(tmp, DIR_NAME_STEM);
    mkdirSync(join(vp, 'raw'), { recursive: true });
    writeFileSync(join(vp, 'raw', '书.txt'), 'stripped-resolve');
    writeFileSync(join(vp, 'plain.txt'), 'plain');
  });
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('resolves a path prefixed with the vault directory name (truncated absolute citation)', () => {
    const cited = `${DIR_NAME_STEM}/raw/书.txt`;
    const f = readFile(vp, cited);
    assert.equal(f.content, 'stripped-resolve');
  });

  it('resolves the same prefixed path with Windows backslashes', () => {
    const cited = `${DIR_NAME_STEM}\\raw\\书.txt`;
    const f = readFile(vp, cited);
    assert.equal(f.content, 'stripped-resolve');
  });

  it('resolves a truncated Windows absolute path (drive + dirs above vault lost)', () => {
    const cited = `D:\\AI\\Molio\\${DIR_NAME_STEM}\\raw\\书.txt`;
    const f = readFile(vp, cited);
    assert.equal(f.content, 'stripped-resolve');
  });

  it('exact in-vault match still wins over the stripped candidate', () => {
    // 'work-vault/x.txt' exists inside the vault AND 'x.txt' exists at root:
    // the exact (unstripped) path must resolve first.
    mkdirSync(join(vp, DIR_NAME_STEM), { recursive: true });
    writeFileSync(join(vp, DIR_NAME_STEM, 'x.txt'), 'exact');
    writeFileSync(join(vp, 'x.txt'), 'stripped');
    const f = readFile(vp, `${DIR_NAME_STEM}/x.txt`);
    assert.equal(f.content, 'exact');
  });

  it('plain vault-relative paths are unaffected (no regression)', () => {
    const f = readFile(vp, 'plain.txt');
    assert.equal(f.content, 'plain');
    assert.equal(readFile(vp, './plain.txt').content, 'plain');
  });

  it('vault dir name is derived from the actual root, not hardcoded', () => {
    assert.equal(basename(vp), DIR_NAME_STEM);
  });
});
