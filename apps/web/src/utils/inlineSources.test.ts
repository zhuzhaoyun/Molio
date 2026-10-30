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

  test('不知道库路径时不判库外（无法证伪的按库内处理，与旧行为一致）', () => {
    const s = groupInlineSources([doneTool('Read', { file_path: '/elsewhere/b.md' })], {});
    assert.equal(s.primary.length, 1);
    assert.equal(s.minor.length, 0);
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
