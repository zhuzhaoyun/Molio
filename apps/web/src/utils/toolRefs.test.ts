// apps/web/src/utils/toolRefs.test.ts
// 回归：E1 引用对账实验（docs/articles/evidence/e1/）实测面板漏记——
// Bash 记账规则是字符串级的（只认「命令以 cat/head/tail/less 开头」的第一个
// 路径参数），agent 换个写法账就漏。本文件钉住修复后的口径。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bashReadPaths, extractSources } from './toolRefs.ts';
import type { ToolEvent } from '../hooks/useChatCore.ts';

function doneTool(name: string, input: unknown): ToolEvent {
  return { id: 't1', name, input, status: 'done' } as ToolEvent;
}

describe('bashReadPaths', () => {
  test('旧口径保留：cat/head/tail/less 开头取首个路径', () => {
    assert.deepEqual(bashReadPaths('cat wiki/hot.md'), ['wiki/hot.md']);
    assert.deepEqual(bashReadPaths('head -50 raw/a.txt'), ['raw/a.txt']);
    assert.deepEqual(bashReadPaths('tail -n 20 b.md'), ['b.md']);
    assert.deepEqual(bashReadPaths('less +5g c.md'), ['c.md']);
  });

  test('E1-F2 复现：cd && 后的相对路径（旧口径完全漏记）', () => {
    assert.deepEqual(
      bashReadPaths('cd /vault/wiki/刑诉 && cat 条号速查.md'),
      ['条号速查.md'],
    );
  });

  test('E1-F3 复现：一条命令 cat 多个文件全部计入', () => {
    assert.deepEqual(
      bashReadPaths('cat concepts/财产罪体系.md && echo "=====" && cat concepts/盗窃与侵占的界分.md'),
      ['concepts/财产罪体系.md', 'concepts/盗窃与侵占的界分.md'],
    );
    assert.deepEqual(bashReadPaths('cat a.md b.md'), ['a.md', 'b.md']);
  });

  test('E1-F3 复现：sed 读文件计入', () => {
    assert.deepEqual(
      bashReadPaths("sed -n '1,40p' notes/真题/zhuguan-2023.txt"),
      ['notes/真题/zhuguan-2023.txt'],
    );
  });

  test('E1-F3 复现：grep 单文件计入；目录仍是搜索动作不计入', () => {
    assert.deepEqual(
      bashReadPaths('grep -n "缺口" 法考刑法知识库总览.md | head -20'),
      ['法考刑法知识库总览.md'],
    );
    assert.deepEqual(bashReadPaths('grep -rn "转账" wiki/'), []);
  });

  test('E1-F2 复现：for 循环清单里的文件计入，$f 变量不计入', () => {
    assert.deepEqual(
      bashReadPaths('for f in 刑诉法解释-2021.md 检察院规则-2019.md; do cat "$f"; done'),
      ['刑诉法解释-2021.md', '检察院规则-2019.md'],
    );
  });

  test('重定向目标是写入不是读取', () => {
    assert.deepEqual(bashReadPaths('cat a.md > copy.md'), ['a.md']);
    assert.deepEqual(bashReadPaths('cat b.md >> log.txt'), ['b.md']);
    assert.deepEqual(bashReadPaths('grep -n x c.md 2> err.txt'), ['c.md']);
  });

  test('非读文件命令不产出（rm/ls/echo/mkdir）', () => {
    assert.deepEqual(bashReadPaths('rm notes.md'), []);
    assert.deepEqual(bashReadPaths('ls -la raw'), []);
    assert.deepEqual(bashReadPaths('echo cat fake.md'), []);
    assert.deepEqual(bashReadPaths('mkdir dir && touch x.md'), []);
  });

  test('引号路径与反斜杠归一化', () => {
    assert.deepEqual(bashReadPaths('cat "my file.md"'), ['my file.md']);
    assert.deepEqual(bashReadPaths("cat '笔记/第一章.md'"), ['笔记/第一章.md']);
    assert.deepEqual(bashReadPaths('cat D:\\vault\\a.md'), ['D:/vault/a.md']);
  });

  test('空命令 / 无路径 cat → 空数组', () => {
    assert.deepEqual(bashReadPaths(''), []);
    assert.deepEqual(bashReadPaths('cat -n'), []);
    assert.deepEqual(bashReadPaths('git log --oneline'), []);
  });
});

describe('extractSources × Bash（面板口径）', () => {
  test('一条 Bash 消息读多个文件 → 多条来源（旧口径只出第一条）', () => {
    const refs = extractSources([
      doneTool('Bash', { command: 'cat a.md && cat b.md' }),
    ]);
    assert.deepEqual(refs.map((r) => r.target), ['a.md', 'b.md']);
    assert.ok(refs.every((r) => r.navigable && r.kind === 'file'));
  });

  test('cd && cat 的文件也进面板', () => {
    const refs = extractSources([
      doneTool('Bash', { command: 'cd /v/wiki/刑诉 && grep -n "第" 定位卡/03-管辖与回避.md' }),
    ]);
    assert.deepEqual(refs.map((r) => r.target), ['定位卡/03-管辖与回避.md']);
  });

  test('running 状态照旧不产出；error 工具照旧不产出', () => {
    const running = extractSources([
      { id: 't1', name: 'Bash', input: { command: 'cat a.md' }, status: 'running' } as ToolEvent,
    ]);
    assert.deepEqual(running, []);
  });
});
