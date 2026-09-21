import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildModelOptions, formatPillLabel } from './runtimeModelOptions.ts';
import type { RuntimeModelOption } from '@molio/contracts';

describe('buildModelOptions', () => {
  it('空模型列表 → 仅「跟随默认」一项', () => {
    assert.deepEqual(buildModelOptions([], '跟随默认'), [
      { id: null, label: '跟随默认' },
    ]);
  });

  it('剔除 id=default 的原生项（避免与「跟随默认」重复）', () => {
    const models: RuntimeModelOption[] = [
      { id: 'default', label: 'Default' },
      { id: 'sonnet', label: 'Sonnet (alias)' },
      { id: 'opus', label: 'Opus (alias)' },
    ];
    assert.deepEqual(buildModelOptions(models, '跟随默认'), [
      { id: null, label: '跟随默认' },
      { id: 'sonnet', label: 'Sonnet (alias)' },
      { id: 'opus', label: 'Opus (alias)' },
    ]);
  });

  it('按 id 去重，保持原有顺序', () => {
    const models: RuntimeModelOption[] = [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'sonnet', label: 'Sonnet (dup)' },
      { id: 'opus', label: 'Opus' },
    ];
    const opts = buildModelOptions(models, '跟随默认');
    assert.equal(opts.length, 3);
    assert.equal(opts[1]!.label, 'Sonnet');
  });
});

describe('formatPillLabel', () => {
  it('无 agent → 空串（不渲染 pill）', () => {
    assert.equal(formatPillLabel(null, 'sonnet', []), '');
  });

  it('未选模型（跟随默认）→ 只显示 runtime 名', () => {
    assert.equal(formatPillLabel('Claude Code', null, []), 'Claude Code');
  });

  it('已选模型 → runtime 名 · 模型 label', () => {
    const models: RuntimeModelOption[] = [{ id: 'sonnet', label: 'Sonnet (alias)' }];
    assert.equal(formatPillLabel('Claude Code', 'sonnet', models), 'Claude Code · Sonnet (alias)');
  });

  it('模型 id 不在列表（stale 记录）→ 回退显示原始 id', () => {
    assert.equal(formatPillLabel('Claude Code', 'ghost-model', []), 'Claude Code · ghost-model');
  });
});
