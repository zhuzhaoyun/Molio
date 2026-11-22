import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_PROVIDERS,
  CODEX_PROVIDERS,
  HERMES_PROVIDERS,
  buildProviderEnv,
  detectProvider,
  getPrimaryModel,
  applyPrimaryModel,
  EMPTY_CLAUDE_MODEL_MAPPING,
} from './providers.ts';
import { SILICONFLOW, SILICONFLOW_DEFAULT_MODEL, SILICONFLOW_MODELS } from '@molio/contracts';

describe('SiliconFlow Claude Code preset', () => {
  const sf = CLAUDE_PROVIDERS.find((p) => p.id === 'siliconflow');

  it('使用 Anthropic 兼容根地址，而不是 OpenAI 的 /v1 路径', () => {
    assert.ok(sf);
    assert.equal(sf.baseUrl, 'https://api.siliconflow.cn/');
    assert.ok(!sf.baseUrl.endsWith('/v1'));
  });

  it('内置免费模型，默认三档都指向推荐的免费模型', () => {
    assert.ok(sf);
    assert.ok(sf.models.some((m) => m.free));
    assert.equal(sf.models[0]?.id, SILICONFLOW_DEFAULT_MODEL);
    assert.deepEqual(sf.defaultModelMapping, {
      sonnet: SILICONFLOW_DEFAULT_MODEL,
      haiku: SILICONFLOW_DEFAULT_MODEL,
      opus: SILICONFLOW_DEFAULT_MODEL,
    });
    assert.equal(sf.modelsUrl, SILICONFLOW.modelPlazaUrl);
  });

  it('buildProviderEnv 落盘 Anthropic 根地址与所选模型', () => {
    const env = buildProviderEnv('siliconflow', 'sk-sf', undefined, {
      sonnet: 'Qwen/Qwen3-8B',
      haiku: 'Qwen/Qwen3-8B',
      opus: 'Qwen/Qwen3-8B',
    });
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.siliconflow.cn/');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-sf');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-sf');
    assert.equal(env.ANTHROPIC_MODEL, 'Qwen/Qwen3-8B');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'Qwen/Qwen3-8B');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'Qwen/Qwen3-8B');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'Qwen/Qwen3-8B');
  });

  it('detectProvider 同时识别新根地址与旧 /v1 配置', () => {
    assert.equal(detectProvider({ ANTHROPIC_BASE_URL: SILICONFLOW.anthropicBaseUrl }), 'siliconflow');
    assert.equal(detectProvider({ ANTHROPIC_BASE_URL: SILICONFLOW.openaiBaseUrl }), 'siliconflow');
  });
});

describe('SiliconFlow Codex preset', () => {
  const sf = CODEX_PROVIDERS.find((p) => p.id === 'siliconflow');

  it('使用 OpenAI 兼容地址 + chat 协议', () => {
    assert.ok(sf);
    assert.equal(sf.baseUrl, 'https://api.siliconflow.cn/v1');
    assert.equal(sf.wireApi, 'chat');
    assert.equal(sf.models[0]?.id, SILICONFLOW_DEFAULT_MODEL);
    assert.ok(sf.models.some((m) => m.free));
    assert.equal(sf.modelsUrl, SILICONFLOW.modelPlazaUrl);
  });
});

describe('SiliconFlow Hermes preset', () => {
  const sf = HERMES_PROVIDERS.find((p) => p.id === 'siliconflow');

  it('复用 hermes 的 custom OpenAI 兼容 profile（hermes 没有 siliconflow 原生 profile）', () => {
    assert.ok(sf);
    assert.equal(sf.providerValue, 'custom');
    assert.equal(sf.isCustom, true);
    assert.equal(sf.defaultBaseUrl, SILICONFLOW.openaiBaseUrl);
  });

  it('预填免费模型清单与申请链接', () => {
    assert.ok(sf);
    assert.equal(sf.models, SILICONFLOW_MODELS);
    assert.equal(sf.models[0]?.id, SILICONFLOW_DEFAULT_MODEL);
    assert.ok(sf.models.some((m) => m.free));
    assert.equal(sf.apiKeyUrl, SILICONFLOW.apiKeyUrl);
  });
});

describe('primary model helpers', () => {
  it('空映射时选择主模型会填满三档', () => {
    assert.deepEqual(applyPrimaryModel(EMPTY_CLAUDE_MODEL_MAPPING, 'Qwen/Qwen3-8B'), {
      sonnet: 'Qwen/Qwen3-8B',
      opus: 'Qwen/Qwen3-8B',
      haiku: 'Qwen/Qwen3-8B',
    });
  });

  it('单独定制过的 haiku 不被覆盖', () => {
    assert.deepEqual(
      applyPrimaryModel({ sonnet: 'pro', opus: 'pro', haiku: 'flash' }, 'new'),
      { sonnet: 'new', opus: 'new', haiku: 'flash' },
    );
  });

  it('getPrimaryModel 以 sonnet 为准', () => {
    assert.equal(getPrimaryModel({ sonnet: 's', opus: 'o', haiku: 'h' }), 's');
    assert.equal(getPrimaryModel({ sonnet: '', opus: 'o', haiku: 'h' }), 'o');
    assert.equal(getPrimaryModel(EMPTY_CLAUDE_MODEL_MAPPING), '');
  });
});