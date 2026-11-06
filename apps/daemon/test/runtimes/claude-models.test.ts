import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeModels } from '../../src/core/runtimes/claude-models.js';

/**
 * resolveClaudeModels — 从 ~/.claude/settings.json（CC Switch 等工具写入）解析
 * Claude Code 实际可用的模型列表，供 composer 模型 pill 展示真实接入的模型。
 *
 * 借鉴 Claude Code 自家 /model 选择器的语义：
 *  - 跟随默认 → defaultModel（ANTHROPIC_MODEL / 顶层 model 键）
 *  - 各别名槽位映射（ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL）→ 一行
 *  - 配置了任何映射/显式模型时整体替换静态 fallbackModels（第三方端点上官方 ID 不可用）
 *  - 无任何自定义 → 返回 null（走静态 fallback）
 */

function withSettings(json: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'molio-cm-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(json));
  return dir;
}

describe('resolveClaudeModels', () => {
  it('无 settings.json → null（走静态 fallback）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'molio-cm-'));
    try {
      assert.equal(resolveClaudeModels({ settingsDir: dir, env: {} }), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settings.json 无任何模型配置 → null', () => {
    const dir = withSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } });
    try {
      assert.equal(resolveClaudeModels({ settingsDir: dir, env: {} }), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CC Switch 全量映射：defaultModel + 各槽位行，主行显示解析后模型', () => {
    const dir = withSettings({
      model: 'glm-5.3-flash[1M]',
      env: {
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_MODEL: 'glm-5.3-flash[1M]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-flash[1M]',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'glm-5.3-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash[1M]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
      },
    });
    try {
      const r = resolveClaudeModels({ settingsDir: dir, env: {} });
      assert.ok(r);
      // 跟随默认的真实默认
      assert.equal(r.defaultModel?.label, 'glm-5.3-flash[1M]');
      // opus 槽位：主行 = NAME（glm-5.3-flash），发送 id = opus，detail 带真实映射
      const opus = r.models.find((m) => m.id === 'opus');
      assert.ok(opus);
      assert.equal(opus.label, 'glm-5.3-flash');
      assert.equal(opus.detail, 'Opus 映射 · glm-5.3-flash[1M]');
      // 无 NAME 时回退 MODEL 本身
      const sonnet = r.models.find((m) => m.id === 'sonnet');
      assert.equal(sonnet?.label, 'glm-5.3-flash[1M]');
      assert.ok(sonnet?.detail?.startsWith('Sonnet 映射'));
      // 无映射的槽位不出现行（haiku 有 MODEL 无行吗？——有映射就有一行）
      assert.ok(r.models.find((m) => m.id === 'haiku'));
      assert.equal(r.models.find((m) => m.id === 'fable'), undefined);
      // 静态官方 ID 不混入
      assert.equal(r.models.find((m) => m.id === 'claude-opus-4-5'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('仅 ANTHROPIC_MODEL（无槽位映射）→ defaultModel + 自定义模型行', () => {
    const dir = withSettings({
      env: { ANTHROPIC_MODEL: 'glm-5.3-flash[1M]' },
    });
    try {
      const r = resolveClaudeModels({ settingsDir: dir, env: {} });
      assert.ok(r);
      assert.equal(r.defaultModel?.label, 'glm-5.3-flash[1M]');
      const custom = r.models.find((m) => m.id === 'glm-5.3-flash[1M]');
      assert.ok(custom);
      assert.equal(custom.detail, '自定义模型');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settings.json env 缺失时回退进程 env（Molio 注入场景）', () => {
    const dir = withSettings({});
    try {
      const r = resolveClaudeModels({
        settingsDir: dir,
        env: { ANTHROPIC_MODEL: 'deepseek-v3' },
      });
      assert.ok(r);
      assert.equal(r.defaultModel?.label, 'deepseek-v3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settings.json 损坏 → 视作无配置，env 仍生效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'molio-cm-'));
    writeFileSync(join(dir, 'settings.json'), '{broken json');
    try {
      const r = resolveClaudeModels({
        settingsDir: dir,
        env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7' },
      });
      assert.ok(r);
      assert.ok(r.models.find((m) => m.id === 'opus'));
      assert.equal(r.defaultModel, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
