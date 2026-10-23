import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileRefChipLabel, buildFileRefPrefix } from './composerFileRefs.ts';

test('fileRefChipLabel: 取路径基名', () => {
  assert.equal(fileRefChipLabel('笔记/入门.md'), '入门.md');
});

test('fileRefChipLabel: 目录去掉尾斜杠再取基名', () => {
  assert.equal(fileRefChipLabel('笔记/方法论/'), '方法论');
});

test('fileRefChipLabel: 根级文件原样返回', () => {
  assert.equal(fileRefChipLabel('doc.md'), 'doc.md');
});

test('buildFileRefPrefix: 文件 → agent 侧 markdown 链接（与 @ 展开同款）', () => {
  assert.equal(
    buildFileRefPrefix([{ vaultId: 'v1', filePath: '笔记/入门.md' }]),
    '[📄 入门.md](笔记/入门.md)',
  );
});

test('buildFileRefPrefix: 目录带尾斜杠 + 文件夹提示（展开时据此区分文件夹）', () => {
  assert.equal(
    buildFileRefPrefix([{ vaultId: 'v1', filePath: '笔记', isDirectory: true }]),
    '[📁 笔记/](笔记/ "文件夹，请读取其下所有相关文件")',
  );
});

test('buildFileRefPrefix: 多个引用空格分隔', () => {
  assert.equal(
    buildFileRefPrefix([
      { vaultId: 'v1', filePath: 'a.md' },
      { vaultId: 'v1', filePath: 'b.md' },
    ]),
    '[📄 a.md](a.md) [📄 b.md](b.md)',
  );
});

test('buildFileRefPrefix: 空数组 → 空串（无引用时不污染消息）', () => {
  assert.equal(buildFileRefPrefix([]), '');
});
