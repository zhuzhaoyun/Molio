// apps/web/src/utils/inlineSources.test.ts
// 回归：wiki 构建一轮读上百个文件后，消息底部的引用区「排布杂乱 + 无法折叠」。
// 这里钉住拆成「可查证层 / 其余层」后的口径：
//   - 去重按归一化路径（同一文件的多种写法只算一次）
//   - 同名文件带父目录消歧（否则看着像重复 chip）
//   - Bash 解析残渣（`=`、`n:')`）不进引用区
//   - 库内文档进可查证层；媒体数据 / 索引日志 / 库外 / 检索路径进其余层
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupInlineSources } from './inlineSources.ts';
import type { ToolEvent } from '../hooks/useChatCore.ts';

function doneTool(name: string, input: unknown): ToolEvent {
  return { id: 't1', name, input, status: 'done' } as ToolEvent;
}

const VAULT = '/vault';
const opts = { vaultPath: VAULT };

describe('groupInlineSources · 去重与消歧', () => {
  test('同一文件的多种写法只算一条', () => {
    const s = groupInlineSources(
      [
        doneTool('Read', { file_path: 'notes/a.md' }),
        doneTool('Read', { file_path: './notes/a.md' }),
        doneTool('Bash', { command: 'cat notes/a.md' }),
      ],
      opts,
    );
    assert.equal(s.total, 1);
    assert.equal(s.primary[0]!.label, 'a.md');
  });

  test('同名不同目录的文件带父目录消歧（否则看着像重复 chip）', () => {
    const s = groupInlineSources(
      [
        doneTool('Read', { file_path: 'wiki/刑诉/batch-01.tsv' }),
        doneTool('Read', { file_path: 'wiki/民法/batch-01.tsv' }),
      ],
      opts,
    );
    assert.equal(s.total, 2);
    // 消歧取最小可区分深度（父目录），不是全路径 —— 全路径太长反而更乱
    const labels = s.minor.map((i) => i.label);
    assert.deepEqual(labels.sort(), ['刑诉/batch-01.tsv', '民法/batch-01.tsv']);
  });

  test('Bash 解析残渣不进引用区', () => {
    const s = groupInlineSources(
      [
        doneTool('Bash', { command: 'cat = ' }),
        doneTool('Bash', { command: "sed -n \"1,50p\" 'n:\\')'" }),
        doneTool('Bash', { command: 'cat real.md' }),
      ],
      opts,
    );
    assert.equal(s.total, 1);
    assert.equal(s.ordered[0]!.label, 'real.md');
  });
});

describe('groupInlineSources · 分层', () => {
  test('库内文档与外部链接进可查证层', () => {
    const s = groupInlineSources(
      [
        doneTool('Read', { file_path: 'notes/a.md' }),
        doneTool('WebFetch', { url: 'https://example.com/x' }),
      ],
      opts,
    );
    assert.equal(s.primary.length, 2);
    assert.equal(s.minor.length, 0);
    // 链接标签 = host（与旧口径一致）
    assert.equal(s.primary.find((i) => i.kind === 'url')!.label, 'example.com');
  });

  test('链接不进「其余」层 —— 外部来源永远是可查证依据', () => {
    const s = groupInlineSources(
      [doneTool('WebFetch', { url: 'https://example.com/x' })],
      opts,
    );
    assert.equal(s.primary.length, 1);
    assert.equal(s.minor.length, 0);
    assert.equal(s.primary[0]!.bucket, undefined);
  });

  test('媒体数据 / 索引日志 / 库外 / 检索路径各自归位', () => {
    const s = groupInlineSources(
      [
        doneTool('Read', { file_path: 'notes/a.md' }),          // 可查证
        doneTool('Read', { file_path: 'media/023.png' }),        // 媒体与数据
        doneTool('Read', { file_path: 'wiki/INDEX.md' }),        // 索引与日志
        doneTool('Read', { file_path: '/elsewhere/b.md' }),      // 库外
        doneTool('Glob', { pattern: '**/*.ts' }),                // 检索路径
      ],
      opts,
    );
    assert.equal(s.primary.length, 1);
    const byBucket = new Map(s.minor.map((i) => [i.bucket, i.label]));
    assert.equal(byBucket.get('media'), '023.png');
    assert.equal(byBucket.get('meta'), 'INDEX.md');
    assert.equal(byBucket.get('outside'), 'b.md');
    assert.equal(byBucket.get('pattern'), '*.ts');
  });

  test('库内点开头目录算「过程产物」，不是「库外文件」', () => {
    // 回归：wiki 技能把转写中间产物写在 .molio/wiki-build/ 下（wiki-build SKILL.md），
    // 那是**库内**路径 —— 之前被 classifyWritePath 的 hidden 层误标成库外。
    const s = groupInlineSources(
      [
        doneTool('Read', { file_path: '.molio/wiki-build/transcode-a.txt' }),
        doneTool('Read', { file_path: '/elsewhere/真库外.md' }),
      ],
      opts,
    );
    const byBucket = new Map(s.minor.map((i) => [i.bucket, i.label]));
    assert.equal(byBucket.get('process-dir'), 'transcode-a.txt');
    assert.equal(byBucket.get('outside'), '真库外.md');
    // 过程产物在库内 → 可导航（真库外不可导航）
    assert.equal(s.minor.find((i) => i.bucket === 'process-dir')!.navigable, true);
    assert.equal(s.minor.find((i) => i.bucket === 'outside')!.navigable, false);
  });

  test('相对路径恒在库内（run 的 cwd 就是库根）', () => {
    // 相对路径剥不掉库前缀不代表在库外 —— agent 的 cwd 是库根，相对路径必在库内
    const s = groupInlineSources(
      [doneTool('Read', { file_path: 'wiki/笔记.md' })],
      opts,
    );
    assert.equal(s.primary.length, 1);
    assert.equal(s.minor.length, 0);
  });

  test('无扩展名的库内文件（Makefile）算真实内容，进可查证层', () => {
    // 与 dock 引用 tab 同口径：无扩展名文件是真实文件，不是「媒体与数据」
    const s = groupInlineSources(
      [doneTool('Read', { file_path: 'Makefile' })],
      opts,
    );
    assert.equal(s.primary.length, 1);
    assert.equal(s.minor.length, 0);
  });

  test('Bash 未展开的变量（media-$f.md）不是文件，不进引用', () => {
    // 回归：bashReadPaths 不做变量展开，`cat media-$f.md` 会把字面量当文件名读进来
    const s = groupInlineSources(
      [doneTool('Bash', { command: 'for f in a b; do cat media-$f.md; done' })],
      opts,
    );
    assert.equal(s.total, 0);
  });

  test('库外文件与检索路径不可导航（点开只会失败）', () => {
    const s = groupInlineSources(
      [
        doneTool('Read', { file_path: '/elsewhere/b.md' }),
        doneTool('Glob', { pattern: '**/*.ts' }),
        doneTool('Read', { file_path: 'notes/a.md' }),
      ],
      opts,
    );
    assert.equal(s.primary[0]!.navigable, true);
    assert.ok(s.minor.every((i) => !i.navigable));
  });

  test('不知道库路径时：绝对路径仍判库外（路径形态本身可判，不依赖 vaultPath）', () => {
    // 绝对路径不在任何 vault 前缀下 → 形态上就是库外，与「知不知道库路径」无关。
    // 相对路径才是「恒在库内」（cwd = 库根）。
    const s = groupInlineSources([doneTool('Read', { file_path: '/elsewhere/b.md' })], {});
    assert.equal(s.primary.length, 0);
    assert.equal(s.minor[0]!.bucket, 'outside');
  });

  test('索引与日志不算依据（wiki 每次操作都读）', () => {
    const s = groupInlineSources(
      [
        doneTool('Read', { file_path: 'wiki/INDEX.md' }),
        doneTool('Read', { file_path: 'wiki/log.md' }),
        doneTool('Read', { file_path: 'wiki/hot.md' }),
      ],
      opts,
    );
    assert.equal(s.primary.length, 0);
    assert.ok(s.minor.every((i) => i.bucket === 'meta'));
  });
});
