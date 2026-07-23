import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinSkills } from '../../src/core/skill-installer.js';

describe('skill-installer migration', () => {
  let tmpVault: string;
  let skillsDir: string;

  before(() => {
    // Create a temporary vault directory
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vault-test-'));
    skillsDir = path.join(tmpVault, '.claude', 'skills');
  });

  beforeEach(() => {
    // Clean skills directory before each test
    if (fs.existsSync(skillsDir)) {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  after(() => {
    // Cleanup
    if (tmpVault && fs.existsSync(tmpVault)) {
      fs.rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  it('should remove deprecated skills (docx, pdf, pptx, xlsx) and install docling', () => {
    // Create deprecated skills (old versions with SKILL.md)
    const deprecatedSkills = ['docx', 'pdf', 'pptx', 'xlsx'];
    for (const skill of deprecatedSkills) {
      const skillDir = path.join(skillsDir, skill);
      fs.mkdirSync(skillDir);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# Old ${skill} skill`);
    }

    // Create a non-deprecated skill that should remain
    const wikiDir = path.join(skillsDir, 'wiki-build');
    fs.mkdirSync(wikiDir);
    fs.writeFileSync(path.join(wikiDir, 'SKILL.md'), '# Wiki build skill');

    // Run the installer
    installBuiltinSkills(tmpVault);

    // Verify deprecated skills are removed
    for (const skill of deprecatedSkills) {
      const skillDir = path.join(skillsDir, skill);
      assert.strictEqual(
        fs.existsSync(skillDir),
        false,
        `Deprecated skill "${skill}" should be removed`,
      );
    }

    // Verify non-deprecated skill remains
    assert.strictEqual(
      fs.existsSync(wikiDir),
      true,
      'Non-deprecated skill should remain',
    );

    // Verify docling (new skill) is installed
    const doclingDir = path.join(skillsDir, 'docling');
    assert.strictEqual(
      fs.existsSync(doclingDir),
      true,
      'New docling skill should be installed',
    );
    assert.strictEqual(
      fs.existsSync(path.join(doclingDir, 'SKILL.md')),
      true,
      'docling should have SKILL.md',
    );
  });

  it('should not remove user-created skills with deprecated names (no SKILL.md)', () => {
    // Create a skill with deprecated name but no SKILL.md (user-created)
    const userPdfDir = path.join(skillsDir, 'pdf');
    fs.mkdirSync(userPdfDir);
    fs.writeFileSync(path.join(userPdfDir, 'custom-script.py'), '# User script');

    // Run the installer
    installBuiltinSkills(tmpVault);

    // Verify user-created skill is preserved
    assert.strictEqual(
      fs.existsSync(userPdfDir),
      true,
      'User-created skill without SKILL.md should be preserved',
    );
    assert.strictEqual(
      fs.existsSync(path.join(userPdfDir, 'custom-script.py')),
      true,
      'User content should not be deleted',
    );
  });

  it('should inject docling-preference rule into .claude/CLAUDE.md', () => {
    installBuiltinSkills(tmpVault);

    const claudeMd = path.join(tmpVault, '.claude', 'CLAUDE.md');
    assert.strictEqual(fs.existsSync(claudeMd), true, '.claude/CLAUDE.md should exist');

    const content = fs.readFileSync(claudeMd, 'utf-8');
    assert.ok(content.includes('docling'), 'CLAUDE.md should mention docling');
    assert.ok(
      content.includes('Always') || content.includes('always'),
      'CLAUDE.md should instruct to always use docling',
    );
  });

  it('should inject environment self-healing rule into .claude/CLAUDE.md', () => {
    installBuiltinSkills(tmpVault);

    const content = fs.readFileSync(
      path.join(tmpVault, '.claude', 'CLAUDE.md'),
      'utf-8',
    );
    // Core behavioral directive: install automatically, don't bail out
    assert.ok(
      content.includes('install it automatically'),
      'should instruct to install automatically before asking user',
    );
    assert.ok(
      content.includes('before asking the user'),
      'should emphasize installing before asking the user',
    );
    // Should NOT contain the removed general-knowledge install commands —
    // the agent already knows how to detect platform & install; the rule only
    // encodes the behavioral default.
    assert.ok(
      !content.includes('winget'),
      'should not spell out winget (general knowledge, removed to keep rule short)',
    );
  });

  it('should inject web-fetch preference rule into .claude/CLAUDE.md', () => {
    installBuiltinSkills(tmpVault);

    const content = fs.readFileSync(
      path.join(tmpVault, '.claude', 'CLAUDE.md'),
      'utf-8',
    );
    // Core directive: prefer curl over WebFetch for Chinese sites
    assert.ok(
      content.includes('Prefer curl') || content.includes('prefer curl'),
      'should instruct to prefer curl',
    );
    assert.ok(
      content.includes('curl'),
      'should mention curl as the preferred alternative',
    );
    assert.ok(
      content.includes('WebFetch'),
      'should mention WebFetch limitations',
    );
    // Should NOT mention browser-mcp or kimi-webbridge (simplified rule)
    assert.ok(
      !content.includes('browser-mcp'),
      'should not mention browser-mcp (simplified to curl only)',
    );
    assert.ok(
      !content.includes('kimi-webbridge'),
      'should not mention kimi-webbridge (simplified to curl only)',
    );
  });

  it('should inject remotion-preference rule into .claude/CLAUDE.md', () => {
    installBuiltinSkills(tmpVault);

    const content = fs.readFileSync(
      path.join(tmpVault, '.claude', 'CLAUDE.md'),
      'utf-8',
    );
    // Core directive: route video creation to the remotion skill, not Python
    // video libraries. Without this rule the agent defaults to moviepy/ffmpeg
    // even though the remotion skill is installed — same reason docling needs
    // a hard rule to win over legacy office skills.
    assert.ok(
      content.includes('remotion'),
      'should mention the remotion skill',
    );
    assert.ok(
      content.includes('moviepy') || content.includes('manim'),
      'should explicitly call out the Python video libraries to avoid',
    );
    // Chinese trigger types must be listed so 介绍视频/宣传视频-style requests
    // route to the rule via keyword match in the system prompt.
    assert.ok(
      content.includes('介绍视频') || content.includes('宣传视频'),
      'should list Chinese video-type triggers',
    );
  });

  it('should inject wiki-query-preference rule into .claude/CLAUDE.md', () => {
    installBuiltinSkills(tmpVault);

    const content = fs.readFileSync(
      path.join(tmpVault, '.claude', 'CLAUDE.md'),
      'utf-8',
    );
    // Regression guard for the "知识库问答不读 wiki" bug: the old QUERY frame
    // rode --append-system-prompt-file, which the CLI silently dropped, so the
    // model answered vault questions from training memory. The retrieval
    // instruction now lives in this always-on CLAUDE.md rule (loaded natively),
    // which must reach the model and force retrieve-before-answer.
    assert.ok(
      content.includes('<!-- molio:wiki-query-preference -->'),
      'should carry the wiki-query sentinel',
    );
    assert.ok(
      content.includes('wiki-query'),
      'should route content questions to the wiki-query skill',
    );
    assert.ok(
      content.includes('wiki/INDEX.md'),
      'should instruct reading the wiki index before answering',
    );
    assert.ok(
      /never answer a vault-content question from training memory/i.test(content),
      'should forbid answering vault-content questions from memory',
    );
    // Regression guard for the opposite failure mode: the rule must NOT
    // role-lock general questions (weather, coding, chit-chat, …) into
    // wiki retrieval — retrieval is scoped to vault-content questions.
    assert.ok(
      /unrelated to the vault's contents/i.test(content) &&
        /need no wiki retrieval/i.test(content),
      'should exempt general (non-vault) questions from wiki retrieval',
    );
  });

  it('should not overwrite existing user content in .claude/CLAUDE.md', () => {
    // Pre-create .claude/CLAUDE.md with user content
    const claudeDir = path.join(tmpVault, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const userContent = '# My Vault Rules\n\nThis is my personal vault.\n';
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), userContent);

    installBuiltinSkills(tmpVault);

    const content = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf-8');
    // User content must be preserved
    assert.ok(content.includes('My Vault Rules'), 'User content should be preserved');
    assert.ok(content.includes('personal vault'), 'User content should be preserved');
    // Docling rule should be appended
    assert.ok(content.includes('docling'), 'Docling rule should be appended');
  });

  it('should be idempotent — running twice does not duplicate the rule', () => {
    installBuiltinSkills(tmpVault);
    const afterFirst = fs.readFileSync(
      path.join(tmpVault, '.claude', 'CLAUDE.md'),
      'utf-8',
    );

    installBuiltinSkills(tmpVault);
    const afterSecond = fs.readFileSync(
      path.join(tmpVault, '.claude', 'CLAUDE.md'),
      'utf-8',
    );

    assert.strictEqual(afterFirst, afterSecond, 'Second run should not change CLAUDE.md');
  });

  it('should replace outdated rule blocks in place when content changes', () => {
    // First pass: inject current rules
    installBuiltinSkills(tmpVault);
    const claudeMd = path.join(tmpVault, '.claude', 'CLAUDE.md');
    const original = fs.readFileSync(claudeMd, 'utf-8');

    // Simulate an older version of the env-self-heal rule with more verbose content
    const oldVerbose = [
      '<!-- molio:env-self-heal -->',
      '## Environment Self-healing (OLD VERBOSE VERSION)',
      '',
      '### Detect platform',
      '- `echo $OS` → `Windows_NT` means Windows',
      '- `uname -s` → `Darwin` / `Linux`',
      '',
      '### Install commands',
      '- Windows: `winget install Python.Python.3.12`',
      '- macOS: `brew install python`',
      '',
      '### PATH refresh',
      'After install, PATH may not update immediately...',
    ].join('\n');

    // Manually write the old verbose version
    const updated = original.replace(
      /<!-- molio:env-self-heal -->[\s\S]*?(?=<!-- molio:|$)/,
      oldVerbose + '\n',
    );
    fs.writeFileSync(claudeMd, updated, 'utf-8');
    const withOld = fs.readFileSync(claudeMd, 'utf-8');
    assert.ok(withOld.includes('OLD VERBOSE VERSION'), 'old version should be present');

    // Second pass: should replace the old verbose block with current version
    installBuiltinSkills(tmpVault);
    const afterUpdate = fs.readFileSync(claudeMd, 'utf-8');

    // Old content should be gone
    assert.ok(
      !afterUpdate.includes('OLD VERBOSE VERSION'),
      'old verbose version should be replaced',
    );
    // Current short version should be present
    assert.ok(
      afterUpdate.includes('install it automatically before asking the user'),
      'current short version should be in place',
    );
    // User content should be preserved
    assert.ok(
      afterUpdate.includes('My Vault Rules'),
      'user content should be preserved',
    );
  });

  it('should update a version-less dest when the source gains a version', () => {
    // Reproduces the wiki-large-source-file bug: a skill whose SKILL.md had no
    // `version:` field was shipped to existing vaults, then later gained both
    // new content AND a `version:` field. The old `shouldUpdateSkill` returned
    // false whenever either side lacked a version, so the new content never
    // reached existing vaults — only new ones. The fix: a versioned source
    // must refresh a version-less dest.
    const wikiBuildDir = path.join(skillsDir, 'wiki-build');
    fs.mkdirSync(wikiBuildDir, { recursive: true });
    // Simulate an old version-less install (pre-1.1.0, no `version:` line).
    fs.writeFileSync(
      path.join(wikiBuildDir, 'SKILL.md'),
      ['# ---', 'name: wiki-build', 'description: old.', '---', '', '# old body'].join('\n'),
    );

    installBuiltinSkills(tmpVault);

    const installed = fs.readFileSync(path.join(wikiBuildDir, 'SKILL.md'), 'utf-8');
    // Must now carry a version line (proves the versioned source was copied in).
    assert.match(installed, /^version:\s*1\.\d+\.\d+$/m, 'version-less dest should be updated to versioned source');
    // And the current body content, not the stale old body.
    assert.ok(
      installed.includes('超长源文件处理'),
      'dest should reflect current source content, not the stale version-less copy',
    );
  });

  it('should update skill when version differs, skip when same', () => {
    // First install
    installBuiltinSkills(tmpVault);
    const doclingMd = path.join(skillsDir, 'docling', 'SKILL.md');
    const currentContent = fs.readFileSync(doclingMd, 'utf-8');

    // Read the current version dynamically so this test doesn't break when
    // the skill's version is bumped.
    const versionMatch = currentContent.match(/^version:\s*(.+)$/m);
    const currentVersion = versionMatch?.[1]?.trim() ?? '';
    assert.ok(currentVersion, 'SKILL.md should declare a version');

    // Simulate an older version in the vault
    const oldContent = currentContent.replace(`version: ${currentVersion}`, 'version: 0.9.0');
    fs.writeFileSync(doclingMd, oldContent, 'utf-8');
    assert.ok(
      fs.readFileSync(doclingMd, 'utf-8').includes('version: 0.9.0'),
      'old version should be written',
    );

    // Second pass: version differs, should update
    installBuiltinSkills(tmpVault);
    assert.ok(
      fs.readFileSync(doclingMd, 'utf-8').includes(`version: ${currentVersion}`),
      'skill should be updated to current version',
    );

    // Third pass: version is same, should not rewrite (no error either)
    installBuiltinSkills(tmpVault);
    assert.ok(
      fs.readFileSync(doclingMd, 'utf-8').includes(`version: ${currentVersion}`),
      'skill should remain at current version',
    );
  });
});
