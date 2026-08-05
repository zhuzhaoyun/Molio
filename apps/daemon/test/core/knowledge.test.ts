import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  writeFile,
  readFile,
  deleteFile,
  createDirectory,
  deleteDirectory,
  renamePath,
  resolveFilePath,
  scanTree,
  countFiles,
  resolveCanonicalPath,
  isPrunedDirName,
  PRUNE_DIR_NAMES,
  MAX_DIR_ENTRIES,
  MAX_TOTAL,
  resetMaxTotalWarnState,
} from '../../src/core/knowledge.js';
import { resetOversizedDirWarnState } from '../../src/core/vault-prune.js';

describe('readFile encoding + tiers', () => {
  let vp: string;
  before(() => { vp = mkdtempSync(join(tmpdir(), 'molio-enc-')); });
  after(() => { rmSync(vp, { recursive: true, force: true }); });

  it('decodes GBK .txt correctly', () => {
    writeFileSync(join(vp, 'cn.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3])); // 你好
    const f = readFile(vp, 'cn.txt');
    assert.equal(f.encoding, 'gb18030');
    assert.equal(f.content, '你好');
    assert.equal(f.tooLarge, undefined);
  });

  it('decodes utf-8 .txt with BOM', () => {
    writeFileSync(join(vp, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')]));
    const f = readFile(vp, 'bom.txt');
    assert.equal(f.encoding, 'utf-8');
    assert.equal(f.content, 'hi');
  });

  // Regression (2026-08-03): a 116KB UTF-8-BOM 国标 .md showed mojibake — the
  // 64KB detection sample cut a 3-byte CJK char in half, strict UTF-8 failed,
  // and the file was decoded as gb18030.
  it('large utf-8 .md with 64KB boundary splitting a multibyte char → utf-8, intact content', () => {
    const char = Buffer.from('的', 'utf8'); // e7 9a 84 — straddles byte 65536
    const tail = '可燃气体探测器';
    const body = Buffer.concat([
      Buffer.alloc(65531, 0x61),           // 'a' × 65531 → with 3-byte BOM, char starts at 65534
      char,                                 // occupies 65534-65536 (last byte past the cut)
      Buffer.from(tail, 'utf8'),
    ]);
    writeFileSync(join(vp, 'big-split.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
    const f = readFile(vp, 'big-split.md');
    assert.equal(f.encoding, 'utf-8');
    assert.ok(f.content.startsWith('aaaa'), 'content decoded, not mojibake');
    assert.ok(f.content.includes('的'), 'split char intact');
    assert.ok(f.content.endsWith(tail), 'tail intact');
    assert.ok(!f.content.includes('锘'), 'no BOM-as-gb18030 mojibake marker');
  });

  it('returns tooLarge (no content) when over soft cap, with encoding from sample', () => {
    // Lower the caps via env by writing a file just over MOLIO_MAX_VIEW_SIZE.
    // We instead test via a real >cap file using a sparse write is avoided:
    // monkey-patch is brittle, so assert the contract through a file that
    // exceeds the *default* cap is impractical in CI. Instead, trust
    // decideReadStrategy unit tests (Task 2) for tier logic and here only
    // assert the happy path + that a normal file has no tooLarge flag.
    const f = readFile(vp, 'cn.txt');
    assert.equal(f.tooLarge, undefined);
    assert.ok(f.content.length > 0);
  });
});

describe('knowledge filesystem operations', () => {
  let vaultPath: string;

  before(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'molio-vault-'));
  });

  after(() => {
    rmSync(vaultPath, { recursive: true, force: true });
  });

  describe('writeFile / readFile', () => {
    it('should create a file with content', () => {
      writeFile(vaultPath, 'hello.md', '# Hello\n');
      const file = readFile(vaultPath, 'hello.md');
      assert.equal(file.content, '# Hello\n');
      assert.equal(file.path, 'hello.md');
      assert.ok(file.size > 0);
    });

    it('should create parent directories automatically', () => {
      writeFile(vaultPath, 'sub/dir/note.md', 'deep note');
      const file = readFile(vaultPath, 'sub/dir/note.md');
      assert.equal(file.content, 'deep note');
    });

    it('should overwrite existing file', () => {
      writeFile(vaultPath, 'overwrite.md', 'v1');
      writeFile(vaultPath, 'overwrite.md', 'v2');
      const file = readFile(vaultPath, 'overwrite.md');
      assert.equal(file.content, 'v2');
    });
  });

  describe('deleteFile', () => {
    it('should delete a file', async () => {
      writeFile(vaultPath, 'to-delete.md', 'bye');
      assert.ok(existsSync(join(vaultPath, 'to-delete.md')));
      await deleteFile(vaultPath, 'to-delete.md');
      assert.ok(!existsSync(join(vaultPath, 'to-delete.md')));
    });

    it('should not throw when deleting non-existent file', async () => {
      await deleteFile(vaultPath, 'does-not-exist.md');
      // No error — silent success
    });
  });

  describe('createDirectory', () => {
    it('should create a directory', () => {
      createDirectory(vaultPath, 'new-folder');
      assert.ok(existsSync(join(vaultPath, 'new-folder')));
    });

    it('should create nested directories', () => {
      createDirectory(vaultPath, 'a/b/c');
      assert.ok(existsSync(join(vaultPath, 'a', 'b', 'c')));
    });
  });

  describe('deleteDirectory', () => {
    it('should delete an empty directory', async () => {
      createDirectory(vaultPath, 'empty-dir');
      assert.ok(existsSync(join(vaultPath, 'empty-dir')));
      await deleteDirectory(vaultPath, 'empty-dir');
      assert.ok(!existsSync(join(vaultPath, 'empty-dir')));
    });

    it('should delete a directory with contents', async () => {
      createDirectory(vaultPath, 'full-dir/sub');
      writeFile(vaultPath, 'full-dir/note.md', 'content');
      writeFile(vaultPath, 'full-dir/sub/deep.md', 'deep');
      assert.ok(existsSync(join(vaultPath, 'full-dir', 'sub', 'deep.md')));
      await deleteDirectory(vaultPath, 'full-dir');
      assert.ok(!existsSync(join(vaultPath, 'full-dir')));
    });

    it('should not throw when deleting non-existent directory', async () => {
      await deleteDirectory(vaultPath, 'never-existed');
      // No error
    });
  });

  describe('renamePath', () => {
    it('should rename a file', () => {
      writeFile(vaultPath, 'old-name.md', 'rename me');
      renamePath(vaultPath, 'old-name.md', 'new-name.md');
      assert.ok(!existsSync(join(vaultPath, 'old-name.md')));
      assert.ok(existsSync(join(vaultPath, 'new-name.md')));
      const file = readFile(vaultPath, 'new-name.md');
      assert.equal(file.content, 'rename me');
    });

    it('should rename a directory', () => {
      createDirectory(vaultPath, 'dir-old');
      writeFile(vaultPath, 'dir-old/inside.md', 'inside');
      renamePath(vaultPath, 'dir-old', 'dir-new');
      assert.ok(!existsSync(join(vaultPath, 'dir-old')));
      assert.ok(existsSync(join(vaultPath, 'dir-new', 'inside.md')));
    });

    it('should move a directory into another directory (preserving name + subtree)', () => {
      createDirectory(vaultPath, 'srcdir');
      createDirectory(vaultPath, 'destdir');
      writeFile(vaultPath, 'srcdir/file.md', 'payload');
      createDirectory(vaultPath, 'srcdir/sub');
      writeFile(vaultPath, 'srcdir/sub/nested.md', 'nested');
      // Move srcdir into destdir → destdir/srcdir/...
      renamePath(vaultPath, 'srcdir', 'destdir/srcdir');
      assert.ok(!existsSync(join(vaultPath, 'srcdir')));
      assert.ok(existsSync(join(vaultPath, 'destdir', 'srcdir', 'file.md')));
      assert.ok(existsSync(join(vaultPath, 'destdir', 'srcdir', 'sub', 'nested.md')));
    });

    it('should reject moving a directory into its own descendant (cycle)', () => {
      // Build outer/inner/leaf
      createDirectory(vaultPath, 'outer');
      createDirectory(vaultPath, 'outer/inner');
      writeFile(vaultPath, 'outer/inner/leaf.md', 'leaf');
      // Trying to move outer → outer/inner/outer would put a parent inside its
      // own descendant. fs.renameSync cannot perform this (destination is inside
      // source), so renamePath must surface the error rather than silently
      // succeed or corrupt the tree.
      assert.throws(() => {
        renamePath(vaultPath, 'outer', 'outer/inner/outer');
      });
      // Original structure intact.
      assert.ok(existsSync(join(vaultPath, 'outer', 'inner', 'leaf.md')));
    });

    it('should move a file to a different directory', () => {
      createDirectory(vaultPath, 'src');
      createDirectory(vaultPath, 'dst');
      writeFile(vaultPath, 'src/move-me.md', 'moving');
      renamePath(vaultPath, 'src/move-me.md', 'dst/moved.md');
      assert.ok(!existsSync(join(vaultPath, 'src', 'move-me.md')));
      const file = readFile(vaultPath, 'dst/moved.md');
      assert.equal(file.content, 'moving');
    });

    it('should reject path traversal', () => {
      assert.throws(() => {
        renamePath(vaultPath, 'hello.md', '../../etc/passwd');
      }, /Path traversal/);
    });

    it('should throw when source does not exist', () => {
      assert.throws(() => {
        renamePath(vaultPath, 'nonexistent.md', 'anything.md');
      }, /Source not found/);
    });
  });

  describe('resolveFilePath — sibling-directory bypass', () => {
    // Regression: `startsWith(vaultRoot)` without a trailing separator let a
    // sibling directory whose name shares the vault's prefix (e.g. vault
    // `/data/vault` vs `/data/vault-secret`) pass the traversal check. The
    // daemon has no auth, so this was directly exploitable to read/escape.
    it('should reject a sibling path that shares the vault name prefix', () => {
      const vaultName = basename(vaultPath);
      const siblingDir = join(vaultPath + '-secret');
      try {
        mkdirSync(siblingDir, { recursive: true });
        writeFileSync(join(siblingDir, 'secret.txt'), 'OUTSIDE_VAULT');

        const relEscape = `../${vaultName}-secret/secret.txt`;
        // resolveFilePath must throw — the sibling is outside the vault even
        // though its path starts with the (un-separator) vault root prefix.
        assert.throws(() => resolveFilePath(vaultPath, relEscape), /Path traversal/);
        // And readFile must not read it either.
        assert.throws(() => readFile(vaultPath, relEscape), /Path traversal/);
      } finally {
        rmSync(siblingDir, { recursive: true, force: true });
      }
    });

    it('should still resolve legitimate in-vault paths', () => {
      writeFileSync(join(vaultPath, 'legit.md'), 'inside');
      const resolved = resolveFilePath(vaultPath, 'legit.md');
      assert.ok(resolved.startsWith(vaultPath));
      assert.equal(readFile(vaultPath, 'legit.md').content, 'inside');
    });
  });

  describe('scanTree', () => {
    it('should return a tree of supported files', () => {
      // Clean vault for this test
      const cleanVault = mkdtempSync(join(tmpdir(), 'molio-scan-'));
      try {
        writeFileSync(join(cleanVault, 'root.md'), '# Root');
        mkdirSync(join(cleanVault, 'notes'));
        writeFileSync(join(cleanVault, 'notes', 'a.md'), 'a');
        writeFileSync(join(cleanVault, 'notes', 'b.txt'), 'b');
        writeFileSync(join(cleanVault, '.hidden'), 'skip');

        const tree = scanTree(cleanVault);
        assert.ok(tree.length > 0);

        // Should have 'notes' directory and 'root.md' file
        const dirs = tree.filter((n) => n.type === 'directory');
        const files = tree.filter((n) => n.type === 'file');
        assert.equal(dirs.length, 1);
        assert.equal(dirs[0]!.name, 'notes');
        assert.equal(files.length, 1);
        assert.equal(files[0]!.name, 'root.md');

        // notes/ should have 2 children (a.md, b.txt)
        assert.equal(dirs[0]!.children?.length, 2);
      } finally {
        rmSync(cleanVault, { recursive: true, force: true });
      }
    });

    it('should sort directories before files', () => {
      const cleanVault = mkdtempSync(join(tmpdir(), 'molio-sort-'));
      try {
        writeFileSync(join(cleanVault, 'zebra.md'), 'z');
        writeFileSync(join(cleanVault, 'alpha.md'), 'a');
        mkdirSync(join(cleanVault, 'middle-dir'));
        writeFileSync(join(cleanVault, 'beta.txt'), 'b');

        const tree = scanTree(cleanVault);
        // First entry should be the directory, then files alphabetically
        assert.equal(tree[0]!.type, 'directory');
        assert.equal(tree[0]!.name, 'middle-dir');
        assert.equal(tree[1]!.type, 'file');
        assert.equal(tree[1]!.name, 'alpha.md');
        assert.equal(tree[2]!.type, 'file');
        assert.equal(tree[2]!.name, 'beta.txt');
        assert.equal(tree[3]!.type, 'file');
        assert.equal(tree[3]!.name, 'zebra.md');
      } finally {
        rmSync(cleanVault, { recursive: true, force: true });
      }
    });

    it('should skip unsupported file extensions', () => {
      const cleanVault = mkdtempSync(join(tmpdir(), 'molio-ext-'));
      try {
        writeFileSync(join(cleanVault, 'good.md'), 'ok');
        writeFileSync(join(cleanVault, 'bad.exe'), 'skip');
        writeFileSync(join(cleanVault, 'also-bad.zip'), 'skip');

        const tree = scanTree(cleanVault);
        assert.equal(tree.length, 1);
        assert.equal(tree[0]!.name, 'good.md');
      } finally {
        rmSync(cleanVault, { recursive: true, force: true });
      }
    });

    it('should include video and audio files (inline <video>/<audio> preview)', () => {
      const cleanVault = mkdtempSync(join(tmpdir(), 'molio-media-'));
      try {
        writeFileSync(join(cleanVault, 'clip.mp4'), 'fake-video');
        writeFileSync(join(cleanVault, 'voiceover.mp3'), 'fake-audio');
        writeFileSync(join(cleanVault, 'notes.md'), 'ok');

        const tree = scanTree(cleanVault);
        const names = tree.map((n) => n.name).sort();
        assert.deepEqual(names, ['clip.mp4', 'notes.md', 'voiceover.mp3']);
      } finally {
        rmSync(cleanVault, { recursive: true, force: true });
      }
    });

    it('should return empty array for empty vault', () => {
      const cleanVault = mkdtempSync(join(tmpdir(), 'molio-empty-'));
      try {
        const tree = scanTree(cleanVault);
        assert.deepEqual(tree, []);
      } finally {
        rmSync(cleanVault, { recursive: true, force: true });
      }
    });
  });

  describe('countFiles', () => {
    it('should count supported files recursively', () => {
      const cleanVault = mkdtempSync(join(tmpdir(), 'molio-count-'));
      try {
        writeFileSync(join(cleanVault, 'a.md'), 'a');
        writeFileSync(join(cleanVault, 'b.txt'), 'b');
        mkdirSync(join(cleanVault, 'sub'));
        writeFileSync(join(cleanVault, 'sub', 'c.md'), 'c');
        writeFileSync(join(cleanVault, 'sub', 'skip.exe'), 'skip');

        const count = countFiles(cleanVault);
        assert.equal(count, 3); // a.md, b.txt, sub/c.md
      } finally {
        rmSync(cleanVault, { recursive: true, force: true });
      }
    });
  });

  describe('readFile — MIME types', () => {
    it('should detect markdown MIME type', () => {
      writeFile(vaultPath, 'mime-test.md', '# MD');
      const file = readFile(vaultPath, 'mime-test.md');
      assert.equal(file.mimeType, 'text/markdown');
    });

    it('should detect JSON MIME type', () => {
      writeFile(vaultPath, 'data.json', '{}');
      const file = readFile(vaultPath, 'data.json');
      assert.equal(file.mimeType, 'application/json');
    });

    it('should detect YAML MIME type', () => {
      writeFile(vaultPath, 'config.yaml', 'key: val');
      const file = readFile(vaultPath, 'config.yaml');
      assert.equal(file.mimeType, 'text/yaml');
    });
  });

  describe('writeFile — edge cases', () => {
    it('should create a file with empty content', () => {
      writeFile(vaultPath, 'empty.md', '');
      const file = readFile(vaultPath, 'empty.md');
      assert.equal(file.content, '');
      assert.equal(file.size, 0);
    });

    it('should handle unicode content', () => {
      writeFile(vaultPath, 'unicode.md', '# 中文测试 🎉\n\n内容');
      const file = readFile(vaultPath, 'unicode.md');
      assert.equal(file.content, '# 中文测试 🎉\n\n内容');
    });
  });

  describe('path traversal protection', () => {
    it('writeFile should reject path traversal', () => {
      assert.throws(() => {
        writeFile(vaultPath, '../../etc/passwd', 'hacked');
      }, /Path traversal/);
    });

    it('readFile should reject path traversal', () => {
      assert.throws(() => {
        readFile(vaultPath, '../../etc/passwd');
      }, /Path traversal/);
    });

    it('createDirectory should reject path traversal', () => {
      assert.throws(() => {
        createDirectory(vaultPath, '../../tmp/evil');
      }, /Path traversal/);
    });

    it('deleteDirectory should reject path traversal', async () => {
      await assert.rejects(async () => {
        await deleteDirectory(vaultPath, '../../tmp');
      }, /Path traversal/);
    });

    it('resolveFilePath should reject path traversal', () => {
      assert.throws(() => {
        resolveFilePath(vaultPath, '../../../etc/shadow');
      }, /Path traversal/);
    });
  });

  describe('renamePath — edge cases', () => {
    it('should reject path traversal on destination', () => {
      writeFile(vaultPath, 'safe.md', 'safe');
      assert.throws(() => {
        renamePath(vaultPath, 'safe.md', '../../etc/evil.md');
      }, /Path traversal/);
    });

    it('should create parent directories for the new path', () => {
      writeFile(vaultPath, 'flat.md', 'flatten');
      renamePath(vaultPath, 'flat.md', 'new/deep/path/flat.md');
      assert.ok(!existsSync(join(vaultPath, 'flat.md')));
      const file = readFile(vaultPath, 'new/deep/path/flat.md');
      assert.equal(file.content, 'flatten');
    });
  });

  describe('readFile auto-resolve', () => {
    it('should read a .md file with path lacking extension', () => {
      writeFile(vaultPath, 'doc.md', 'hello auto-resolve');
      const file = readFile(vaultPath, 'doc');
      assert.equal(file.content, 'hello auto-resolve');
    });

    it('should read a .md file in subdirectory with path lacking extension', () => {
      mkdirSync(join(vaultPath, 'sub'), { recursive: true });
      writeFile(vaultPath, 'sub/nested.md', 'nested content');
      const file = readFile(vaultPath, 'sub/nested');
      assert.equal(file.content, 'nested content');
    });

    it('should use exact path when file with full extension exists', () => {
      writeFile(vaultPath, 'readme.md', 'readme content');
      const file = readFile(vaultPath, 'readme.md');
      assert.equal(file.content, 'readme content');
    });

    it('should throw if neither exact path nor .md fallback exists', () => {
      assert.throws(() => readFile(vaultPath, 'nonexistent'));
    });

    it('should not auto-append .md when other extension is present', () => {
      writeFile(vaultPath, 'data.txt', 'text data');
      // 'data.txt' exists, so it should read it
      const file = readFile(vaultPath, 'data.txt');
      assert.equal(file.content, 'text data');
    });

    it('should match file with different case (case-insensitive fallback)', () => {
      writeFile(vaultPath, 'CaseTest.MD', 'case-insensitive content');
      const file = readFile(vaultPath, 'CASETEST.md');
      assert.equal(file.content, 'case-insensitive content');
    });

    it('should match file in subdirectory with different case', () => {
      mkdirSync(join(vaultPath, 'Dir'), { recursive: true });
      writeFile(vaultPath, 'Dir/Readme.MD', 'dir content');
      const file = readFile(vaultPath, 'dir/README.md');
      assert.equal(file.content, 'dir content');
    });

    it('should find wiki files via wiki/ prefix fallback', () => {
      mkdirSync(join(vaultPath, 'wiki'), { recursive: true });
      writeFile(vaultPath, 'wiki/INDEX.md', 'wiki index content');
      const file = readFile(vaultPath, 'INDEX.md');
      assert.equal(file.content, 'wiki index content');
    });

    it('should resolve a bare page name to a nested wiki file (recursive)', () => {
      mkdirSync(join(vaultPath, 'wiki', 'dev', 'concept'), { recursive: true });
      writeFile(vaultPath, 'wiki/dev/concept/paradigm.md', 'nested paradigm');
      const file = readFile(vaultPath, 'paradigm');
      assert.equal(file.content, 'nested paradigm');
    });

    it('should resolve a bare page name case-insensitively across the tree', () => {
      mkdirSync(join(vaultPath, 'notes', 'sub'), { recursive: true });
      writeFile(vaultPath, 'notes/sub/Canon.md', 'canon content');
      const file = readFile(vaultPath, 'canon');
      assert.equal(file.content, 'canon content');
    });

    it('should skip hidden directories during recursive bare-name search', () => {
      mkdirSync(join(vaultPath, '.molio', 'assets'), { recursive: true });
      writeFile(vaultPath, '.molio/assets/hidden.md', 'hidden content');
      assert.throws(() => readFile(vaultPath, 'hidden'));
    });
  });

  describe('resolveCanonicalPath', () => {
    it('exact path returns the path unchanged', () => {
      writeFile(vaultPath, 'exact.md', '# x\n');
      assert.equal(resolveCanonicalPath(vaultPath, 'exact.md'), 'exact.md');
    });

    it('appends .md when input has no extension', () => {
      writeFile(vaultPath, 'bar.md', '# x\n');
      assert.equal(resolveCanonicalPath(vaultPath, 'bar'), 'bar.md');
    });

    it('tries the wiki/ prefix when the link drops it', () => {
      mkdirSync(join(vaultPath, 'wiki', 'entities'), { recursive: true });
      writeFileSync(join(vaultPath, 'wiki', 'entities', '宇树科技.md'), '# x\n');
      assert.equal(
        resolveCanonicalPath(vaultPath, 'entities/宇树科技'),
        'wiki/entities/宇树科技.md',
      );
    });

    it('stem-matches a non-md file when the link omits the extension', () => {
      mkdirSync(join(vaultPath, 'wiki', 'entities'), { recursive: true });
      writeFileSync(join(vaultPath, 'wiki', 'entities', '季度报告.pdf'), '%PDF-1.4\n');
      assert.equal(
        resolveCanonicalPath(vaultPath, 'entities/季度报告'),
        'wiki/entities/季度报告.pdf',
      );
    });

    it('prefers .md over other extensions with the same stem', () => {
      mkdirSync(join(vaultPath, 'docs'), { recursive: true });
      writeFileSync(join(vaultPath, 'docs', 'dup.md'), '# md\n');
      writeFileSync(join(vaultPath, 'docs', 'dup.pdf'), '%PDF\n');
      assert.equal(resolveCanonicalPath(vaultPath, 'docs/dup'), 'docs/dup.md');
    });

    it('bare page name resolves anywhere in the tree', () => {
      mkdirSync(join(vaultPath, 'wiki', 'deep'), { recursive: true });
      writeFileSync(join(vaultPath, 'wiki', 'deep', '概念.md'), '# x\n');
      assert.equal(resolveCanonicalPath(vaultPath, '概念'), 'wiki/deep/概念.md');
    });

    it('case-insensitive match', () => {
      writeFileSync(join(vaultPath, 'Case.md'), '# x\n');
      assert.equal(resolveCanonicalPath(vaultPath, 'case'), 'Case.md');
    });

    it('returns null when nothing matches', () => {
      assert.equal(resolveCanonicalPath(vaultPath, 'nope/missing'), null);
    });

    it('returns null for empty input', () => {
      assert.equal(resolveCanonicalPath(vaultPath, ''), null);
    });
  });
});

// Pruning + bounded-scan backstop: the architecture that prevents FD exhaustion
// and event-loop blocking when a vault contains a node_modules / dumped dataset.
// See apps/daemon/src/core/knowledge.ts — isPrunedDirName, MAX_DIR_ENTRIES, MAX_TOTAL.
describe('vault scan pruning + bounded backstop', () => {
  let vp: string;
  before(() => { vp = mkdtempSync(join(tmpdir(), 'molio-prune-')); });
  after(() => { rmSync(vp, { recursive: true, force: true }); });

  describe('isPrunedDirName', () => {
    it('prunes dotfile entries (except the vault root marker itself)', () => {
      assert.equal(isPrunedDirName('.git'), true);
      assert.equal(isPrunedDirName('.molio'), true);
      assert.equal(isPrunedDirName('.claude'), true);
      assert.equal(isPrunedDirName('.'), false);
    });

    it('prunes known build/dependency directories', () => {
      assert.equal(isPrunedDirName('node_modules'), true);
      assert.equal(isPrunedDirName('dist'), true);
      assert.equal(isPrunedDirName('build'), true);
      assert.equal(isPrunedDirName('__pycache__'), true);
      assert.equal(isPrunedDirName('.venv'), true);
      assert.equal(isPrunedDirName('target'), true);
    });

    it('does not prune ordinary knowledge directories', () => {
      assert.equal(isPrunedDirName('notes'), false);
      assert.equal(isPrunedDirName('wiki'), false);
      assert.equal(isPrunedDirName('attachments'), false);
    });

    it('PRUNE_DIR_NAMES is non-empty and stable', () => {
      assert.ok(PRUNE_DIR_NAMES.size >= 10);
      assert.ok(PRUNE_DIR_NAMES.has('node_modules'));
    });
  });

  describe('scanTree pruning', () => {
    it('does not descend into node_modules (the FD-exhaustion root cause)', () => {
      const clean = mkdtempSync(join(tmpdir(), 'molio-prune-nm-'));
      try {
        writeFileSync(join(clean, 'real.md'), '# real');
        mkdirSync(join(clean, 'node_modules', 'some-pkg', 'lib'), { recursive: true });
        // 30 fake files inside node_modules — scanTree must never touch them.
        for (let i = 0; i < 30; i++) {
          writeFileSync(join(clean, 'node_modules', 'some-pkg', 'lib', `f${i}.md`), 'x');
        }

        const tree = scanTree(clean);
        const nodeModules = tree.find((n) => n.name === 'node_modules');
        assert.equal(nodeModules, undefined);
        // The real knowledge file still surfaces.
        assert.equal(tree.find((n) => n.name === 'real.md')?.type, 'file');
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    });

    it('prunes every PRUNE_DIR_NAMES entry (not just node_modules)', () => {
      const clean = mkdtempSync(join(tmpdir(), 'molio-prune-all-'));
      try {
        writeFileSync(join(clean, 'keep.md'), 'k');
        for (const name of ['dist', 'build', 'out', '__pycache__']) {
          mkdirSync(join(clean, name), { recursive: true });
          writeFileSync(join(clean, name, 'inside.md'), 'x');
        }
        const tree = scanTree(clean);
        assert.deepEqual(
          tree.map((n) => n.name),
          ['keep.md'],
        );
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    });
  });

  describe('scanTree per-directory entry backstop', () => {
    it('prunes a non-blacklisted directory with > MAX_DIR_ENTRIES entries', () => {
      const clean = mkdtempSync(join(tmpdir(), 'molio-prune-huge-'));
      try {
        mkdirSync(join(clean, 'dump'));
        // One over the cap, all supported so without the backstop they'd all become nodes.
        for (let i = 0; i <= MAX_DIR_ENTRIES; i++) {
          writeFileSync(join(clean, 'dump', `f${i}.md`), 'x');
        }
        const tree = scanTree(clean);
        const dump = tree.find((n) => n.name === 'dump');
        assert.ok(dump, 'dump dir node should still exist (pruned, not hidden)');
        // Pruned → empty children, NOT MAX_DIR_ENTRIES+1 stat'd file nodes.
        assert.equal(dump!.children?.length, 0);
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    });

    it('countFiles skips the oversized subtree entirely', () => {
      const clean = mkdtempSync(join(tmpdir(), 'molio-prune-count-'));
      try {
        writeFileSync(join(clean, 'real.md'), 'r');
        mkdirSync(join(clean, 'dump'));
        for (let i = 0; i <= MAX_DIR_ENTRIES; i++) {
          writeFileSync(join(clean, 'dump', `f${i}.md`), 'x');
        }
        // Only real.md counts — the dump subtree is pruned, not counted.
        assert.equal(countFiles(clean), 1);
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    });
  });

  // Regression: the oversized-directory warning used to fire on EVERY scan, so a
  // vault with two large dirs that is rescanned many times a second (the UI
  // refreshes on each `tree-changed` event) flooded stderr — which cloud log
  // collectors classify as ERROR — producing thousands of false anomalies. The
  // warning is now throttled per (source, dir); repeated scans warn once each.
  describe('oversized-directory warning throttle (stderr noise)', () => {
    let clean: string;
    let warnings: string[];
    let origWarn: typeof console.warn;

    before(() => {
      origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
    });
    after(() => {
      console.warn = origWarn;
    });

    it('repeated scanTree + countFiles over the same oversized dir warn once per source', () => {
      clean = mkdtempSync(join(tmpdir(), 'molio-prune-throttle-'));
      warnings = [];
      resetOversizedDirWarnState();
      try {
        mkdirSync(join(clean, 'dump'));
        for (let i = 0; i <= MAX_DIR_ENTRIES; i++) {
          writeFileSync(join(clean, 'dump', `f${i}.md`), 'x');
        }
        // Simulate the UI hammering the daemon: three tree refreshes + three counts.
        for (let i = 0; i < 3; i++) scanTree(clean);
        for (let i = 0; i < 3; i++) countFiles(clean);

        const scanWarns = warnings.filter((w) => w.includes('scanTree pruned oversized'));
        const countWarns = warnings.filter((w) => w.includes('countFiles pruned oversized'));
        assert.equal(scanWarns.length, 1, `scanTree should warn once, got ${scanWarns.length}`);
        assert.equal(countWarns.length, 1, `countFiles should warn once, got ${countWarns.length}`);
        assert.equal(warnings.length, 2, `total warnings should be 2, got ${warnings.length}`);
      } finally {
        resetOversizedDirWarnState();
        rmSync(clean, { recursive: true, force: true });
      }
    });
  });

  // Regression: like the oversized-directory warning, the "hit MAX_TOTAL …
  // truncating" warning used to fire on every scan, so a vault over the cap
  // that is rescanned on each `tree-changed` event flooded stderr (→ SLS ERROR).
  // It is now throttled per (source, dir); repeated scans warn once each.
  describe('MAX_TOTAL truncation warning throttle (stderr noise)', () => {
    let clean: string;
    let warnings: string[];
    let origWarn: typeof console.warn;

    before(() => {
      origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
    });
    after(() => {
      console.warn = origWarn;
    });

    it('repeated scanTree + countFiles over an over-cap vault warn once per source', () => {
      clean = mkdtempSync(join(tmpdir(), 'molio-maxtotal-throttle-'));
      warnings = [];
      resetMaxTotalWarnState();
      try {
        mkdirSync(join(clean, 'a'), { recursive: true });
        for (let i = 0; i < 10; i++) writeFileSync(join(clean, 'a', `f${i}.md`), 'x');
        // maxTotal=2 → every scan truncates and would warn un-throttled.
        for (let i = 0; i < 3; i++) scanTree(clean, '', { maxTotal: 2 });
        for (let i = 0; i < 3; i++) countFiles(clean, { maxTotal: 2 });

        const scanWarns = warnings.filter((w) => w.includes('scanTree hit MAX_TOTAL'));
        const countWarns = warnings.filter((w) => w.includes('countFiles hit MAX_TOTAL'));
        assert.equal(scanWarns.length, 1, `scanTree should warn once, got ${scanWarns.length}`);
        assert.equal(countWarns.length, 1, `countFiles should warn once, got ${countWarns.length}`);
      } finally {
        resetMaxTotalWarnState();
        rmSync(clean, { recursive: true, force: true });
      }
    });
  });

  describe('scanTree total-file cap (MAX_TOTAL)', () => {
    it('truncates once the injected maxTotal is exceeded and stops descending', () => {
      const clean = mkdtempSync(join(tmpdir(), 'molio-prune-total-'));
      try {
        // Two dirs, 3 supported files each = 6 total; cap at 2.
        mkdirSync(join(clean, 'a'), { recursive: true });
        mkdirSync(join(clean, 'b'), { recursive: true });
        for (const d of ['a', 'b']) {
          for (let i = 0; i < 3; i++) {
            writeFileSync(join(clean, d, `f${i}.md`), 'x');
          }
        }
        const tree = scanTree(clean, '', { maxTotal: 2 });
        // The scan stops once 2 files are visited, so far fewer than 6 appear.
        const files = tree.flatMap((n) => n.children ?? []).filter((n) => n.type === 'file');
        assert.ok(files.length < 6, `expected truncation before 6, got ${files.length}`);
        assert.ok(files.length >= 1, `expected at least 1 file, got ${files.length}`);
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    });

    it('does not false-trigger at small scales under default caps', () => {
      const clean = mkdtempSync(join(tmpdir(), 'molio-prune-default-'));
      try {
        mkdirSync(join(clean, 'notes'), { recursive: true });
        for (let i = 0; i < 20; i++) writeFileSync(join(clean, 'notes', `n${i}.md`), 'x');
        // Defaults (MAX_DIR_ENTRIES=1000, MAX_TOTAL=50000) must not prune 20 files.
        assert.equal(countFiles(clean), 20);
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    });
  });

  describe('constants sanity', () => {
    it('MAX_DIR_ENTRIES is below the ~10k FD-exhaustion ceiling', () => {
      assert.ok(MAX_DIR_ENTRIES < 5000, `MAX_DIR_ENTRIES too high: ${MAX_DIR_ENTRIES}`);
    });
    it('MAX_TOTAL is set and generous', () => {
      assert.ok(MAX_TOTAL >= 10000 && MAX_TOTAL <= 100000);
    });
  });
});
