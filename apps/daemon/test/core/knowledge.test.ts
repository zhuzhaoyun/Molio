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
  scanTree,
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
    it('should delete a file', () => {
      writeFile(vaultPath, 'to-delete.md', 'bye');
      assert.ok(existsSync(join(vaultPath, 'to-delete.md')));
      deleteFile(vaultPath, 'to-delete.md');
      assert.ok(!existsSync(join(vaultPath, 'to-delete.md')));
    });

    it('should not throw when deleting non-existent file', () => {
      deleteFile(vaultPath, 'does-not-exist.md');
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
    it('should delete an empty directory', () => {
      createDirectory(vaultPath, 'empty-dir');
      assert.ok(existsSync(join(vaultPath, 'empty-dir')));
      deleteDirectory(vaultPath, 'empty-dir');
      assert.ok(!existsSync(join(vaultPath, 'empty-dir')));
    });

    it('should delete a directory with contents', () => {
      createDirectory(vaultPath, 'full-dir/sub');
      writeFile(vaultPath, 'full-dir/note.md', 'content');
      writeFile(vaultPath, 'full-dir/sub/deep.md', 'deep');
      assert.ok(existsSync(join(vaultPath, 'full-dir', 'sub', 'deep.md')));
      deleteDirectory(vaultPath, 'full-dir');
      assert.ok(!existsSync(join(vaultPath, 'full-dir')));
    });

    it('should not throw when deleting non-existent directory', () => {
      deleteDirectory(vaultPath, 'never-existed');
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
  });
});
