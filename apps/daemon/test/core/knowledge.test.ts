import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '../../src/core/knowledge.js';

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
      writeFile(vaultPath, 'Index.MD', 'case-insensitive content');
      const file = readFile(vaultPath, 'INDEX.md');
      assert.equal(file.content, 'case-insensitive content');
    });

    it('should match file in subdirectory with different case', () => {
      mkdirSync(join(vaultPath, 'Dir'), { recursive: true });
      writeFile(vaultPath, 'Dir/Readme.MD', 'dir content');
      const file = readFile(vaultPath, 'dir/README.md');
      assert.equal(file.content, 'dir content');
    });
  });
});
