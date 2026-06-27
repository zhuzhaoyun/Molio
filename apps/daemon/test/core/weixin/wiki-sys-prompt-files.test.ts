import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureWikiSysPromptFiles,
  WEIXIN_SYS_PROMPT_FILE,
  QUERY_SYS_PROMPT_FILE,
  WIKI_WEIXIN_PROMPT,
  WIKI_QUERY_PROMPT,
} from '../../../src/core/wiki-prompts.js';

/**
 * Tests for the wiki system-prompt file materialization.
 *
 * The wiki/vault role frame is multi-KB with embedded quotes/backslashes.
 * Passing it inline as `--append-system-prompt <text>` broke the CLI's argv
 * parsing on Windows and dropped `--dangerously-skip-permissions`. Fix:
 * materialize the frame to a fixed file under ~/.molio/sysprompt/ at daemon
 * startup and pass `--append-system-prompt-file <path>`.
 */
describe('ensureWikiSysPromptFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-sysprompt-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes weixin.txt and query.txt with the prompt constants as content', () => {
    ensureWikiSysPromptFiles(dir);
    const weixin = join(dir, 'weixin.txt');
    const query = join(dir, 'query.txt');
    assert.ok(existsSync(weixin), 'weixin.txt should exist');
    assert.ok(existsSync(query), 'query.txt should exist');
    assert.equal(readFileSync(weixin, 'utf8'), WIKI_WEIXIN_PROMPT);
    assert.equal(readFileSync(query, 'utf8'), WIKI_QUERY_PROMPT);
  });

  it('is idempotent — calling twice does not throw and keeps content fresh', () => {
    ensureWikiSysPromptFiles(dir);
    assert.doesNotThrow(() => ensureWikiSysPromptFiles(dir));
    assert.equal(readFileSync(join(dir, 'weixin.txt'), 'utf8'), WIKI_WEIXIN_PROMPT);
  });

  it('the weixin frame carries the intake / file-return rules', () => {
    ensureWikiSysPromptFiles(dir);
    const sys = readFileSync(join(dir, 'weixin.txt'), 'utf8');
    // Downloaded entity files are the staging material themselves — no extra
    // .md placeholder should be created.
    assert.match(sys, /不要再额外新建/);
    assert.match(sys, /暂存文件/);
    // URL/web-share fallback still creates a .md.
    assert.match(sys, /raw\/wechat\/YYYY-MM-DD\/HHmm-简短标题\.md/);
    // mp.weixin.qq.com links must use the wechat-article-extractor skill,
    // not WebFetch (blocked by enterprise security policy).
    assert.match(sys, /wechat-article-extractor/);
    assert.match(sys, /禁止用 WebFetch/);
  });

  it('exports fixed paths under ~/.molio/sysprompt/', () => {
    assert.ok(WEIXIN_SYS_PROMPT_FILE.endsWith(join('.molio', 'sysprompt', 'weixin.txt')));
    assert.ok(QUERY_SYS_PROMPT_FILE.endsWith(join('.molio', 'sysprompt', 'query.txt')));
  });
});
