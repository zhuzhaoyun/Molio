import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import {
  CLAUDE_PROVIDERS,
  CODEX_PROVIDERS,
  detectProvider,
  buildProviderEnv,
  type ProviderPreset,
  type CodexProviderPreset,
} from './providers';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface ProviderConfigProps {
  agentId: string;
}

interface ModelMapping {
  sonnet: string;
  haiku: string;
  opus: string;
}

const EMPTY_MAPPING: ModelMapping = { sonnet: '', haiku: '', opus: '' };

export function ProviderConfig({ agentId }: ProviderConfigProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // Form state
  const [providerId, setProviderId] = useState('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [mapping, setMapping] = useState<ModelMapping>(EMPTY_MAPPING);
  const [showMapping, setShowMapping] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const isCodex = agentId === 'codex';
  const [codexModel, setCodexModel] = useState('');
  const [codexWireApi, setCodexWireApi] = useState<'responses' | 'chat'>('responses');

  // Load current config on mount
  useEffect(() => {
    if (isCodex) {
      api.getAgentProvider(agentId).then((raw) => {
        const s = raw as { presetHint: string; baseUrl: string | null; model: string | null; wireApi: string | null };
        const matched = CODEX_PROVIDERS.find((p) => p.id === s.presetHint);
        if (matched) setProviderId(s.presetHint);
        if (s.baseUrl) setCustomBaseUrl(s.baseUrl);
        if (s.wireApi === 'chat' || s.wireApi === 'responses') setCodexWireApi(s.wireApi);
        if (s.model) {
          setCodexModel(s.model);
        } else if (matched && !matched.isCustom && !matched.isOfficial && matched.models.length > 0) {
          // config.toml 有 model_provider 但没有顶层 model 时，下拉框会显示第一个模型，
          // 状态也要同步，否则直接保存会发出空 model → 400
          setCodexModel(matched.models[0]?.id ?? '');
        }
      }).catch(() => {
        // Ignore — defaults are fine
      });
      return;
    }
    api.getAgentConfig(agentId).then((config) => {
      const env = (config.env ?? {}) as Record<string, string>;
      const detected = detectProvider(env);
      setProviderId(detected);
      // ANTHROPIC_AUTH_TOKEN is the canonical key; fall back to API_KEY
      setApiKey(env['ANTHROPIC_AUTH_TOKEN'] || env['ANTHROPIC_API_KEY'] || '');
      if (detected === 'custom') {
        setCustomBaseUrl(env['ANTHROPIC_BASE_URL'] ?? '');
      }
      // Load saved model mapping
      const savedMapping: ModelMapping = {
        sonnet: env['ANTHROPIC_DEFAULT_SONNET_MODEL'] ?? '',
        haiku: env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] ?? '',
        opus: env['ANTHROPIC_DEFAULT_OPUS_MODEL'] ?? '',
      };
      if (savedMapping.sonnet || savedMapping.haiku || savedMapping.opus) {
        setMapping(savedMapping);
      }
    }).catch(() => {
      // Ignore — defaults are fine
    });
  }, [agentId, isCodex]);

  const provider: ProviderPreset | CodexProviderPreset = isCodex
    ? CODEX_PROVIDERS.find((p) => p.id === providerId) ?? CODEX_PROVIDERS[0]
    : CLAUDE_PROVIDERS.find((p) => p.id === providerId) ?? CLAUDE_PROVIDERS[0];

  const providers: { id: string; name: string }[] = isCodex ? CODEX_PROVIDERS : CLAUDE_PROVIDERS;

  const handleProviderChange = useCallback((id: string) => {
    if (isCodex) {
      setProviderId(id);
      setSaveState('idle');
      setApiKey('');
      const p = CODEX_PROVIDERS.find((x) => x.id === id);
      setCodexModel(p && !p.isCustom && !p.isOfficial ? (p.models[0]?.id ?? '') : '');
      return;
    }
    setProviderId(id);
    setSaveState('idle');
    setApiKey('');
    if (id !== 'custom') {
      const p = CLAUDE_PROVIDERS.find((p) => p.id === id);
      setCustomBaseUrl(p?.baseUrl ?? '');
      // Pre-fill model mapping from provider defaults
      if (p?.defaultModelMapping) {
        setMapping({
          sonnet: p.defaultModelMapping.sonnet ?? '',
          haiku: p.defaultModelMapping.haiku ?? '',
          opus: p.defaultModelMapping.opus ?? '',
        });
      } else {
        setMapping(EMPTY_MAPPING);
      }
    } else {
      setMapping(EMPTY_MAPPING);
    }
  }, [isCodex]);

  const handleSave = useCallback(async () => {
    setSaveState('saving');
    try {
      if (isCodex) {
        const body: Record<string, unknown> = { presetId: providerId };
        if (providerId === 'custom') {
          body.baseUrl = customBaseUrl;
          body.wireApi = codexWireApi;
        }
        if (providerId !== 'official') {
          body.model = codexModel;
          if (apiKey) body.apiKey = apiKey;
        }
        await api.updateAgentProvider(agentId, body);
      } else {
        const modelMapping = (mapping.sonnet || mapping.haiku || mapping.opus)
          ? mapping
          : undefined;
        const env = buildProviderEnv(providerId, apiKey, customBaseUrl, modelMapping);
        await api.updateAgentConfig(agentId, { env });
      }
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 3000);
    } catch (err) {
      setSaveState('error');
    }
  }, [agentId, isCodex, providerId, apiKey, customBaseUrl, mapping, codexModel, codexWireApi]);

  const isThirdParty = providerId !== 'anthropic';

  if (!expanded) {
    return (
      <button
        className="rt-btn rt-btn--sm rt-btn--ghost rt-provider-toggle"
        onClick={() => setExpanded(true)}
      >
        <span className="rt-provider-toggle__icon">⚙</span>
        {t('runtimes.provider')}
        <span className="rt-provider-toggle__current">
          {provider.name}
        </span>
      </button>
    );
  }

  return (
    <div className="rt-provider-config">
      <div className="rt-provider-config__header">
        <span className="rt-provider-config__title">{t('runtimes.provider')}</span>
        <button
          className="rt-btn rt-btn--sm rt-btn--ghost"
          onClick={() => setExpanded(false)}
        >
          ✕
        </button>
      </div>

      <div className="rt-provider-form">
        {/* Provider selector */}
        <label className="rt-provider-form__field">
          <span className="rt-provider-form__label">{t('runtimes.provider')}</span>
          <select
            className="rt-provider-form__select"
            value={providerId}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>

        {isCodex && (
          <p className="rt-provider-form__hint">{t('runtimes.codexConfigHint')}</p>
        )}

        {isCodex && providerId === 'official' && (
          <p className="rt-provider-form__hint">{t('runtimes.officialHint')}</p>
        )}

        {isCodex && providerId !== 'official' && (
          <label className="rt-provider-form__field">
            <span className="rt-provider-form__label">{t('runtimes.model')}</span>
            {(() => {
              const preset = CODEX_PROVIDERS.find((p) => p.id === providerId);
              const options = preset?.models ?? [];
              const inList = options.some((m) => m.id === codexModel);
              if (!preset?.isCustom && options.length > 0 && (inList || !codexModel)) {
                return (
                  <select
                    data-testid="codex-model-field"
                    className="rt-provider-form__select"
                    value={inList || !codexModel ? (codexModel || options[0]?.id || '') : ''}
                    onChange={(e) => { setCodexModel(e.target.value); setSaveState('idle'); }}
                  >
                    {options.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                );
              }
              return (
                <input
                  data-testid="codex-model-field"
                  type="text"
                  className="rt-provider-form__input"
                  value={codexModel}
                  onChange={(e) => { setCodexModel(e.target.value); setSaveState('idle'); }}
                  placeholder="deepseek-v4-flash"
                />
              );
            })()}
          </label>
        )}

        {isCodex && providerId === 'custom' && (
          <>
            <label className="rt-provider-form__field">
              <span className="rt-provider-form__label">{t('runtimes.baseUrl')}</span>
              <input
                type="url"
                className="rt-provider-form__input"
                value={customBaseUrl}
                onChange={(e) => { setCustomBaseUrl(e.target.value); setSaveState('idle'); }}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label className="rt-provider-form__field">
              <span className="rt-provider-form__label">{t('runtimes.wireApi')}</span>
              <select
                data-testid="codex-wire-api-field"
                className="rt-provider-form__select"
                value={codexWireApi}
                onChange={(e) => { setCodexWireApi(e.target.value as 'responses' | 'chat'); setSaveState('idle'); }}
              >
                <option value="responses">responses</option>
                <option value="chat">chat</option>
              </select>
            </label>
          </>
        )}

        {/* API Key */}
        {(isCodex ? providerId !== 'official' : providerId !== 'anthropic') && (
          <label className="rt-provider-form__field">
            <span className="rt-provider-form__label">
              {t('runtimes.apiKey')}
              {provider.apiKeyHint && (
                <span className="rt-provider-form__hint"> ({provider.apiKeyHint})</span>
              )}
            </span>
            <input
              type="password"
              className="rt-provider-form__input"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setSaveState('idle'); }}
              placeholder={provider.apiKeyHint ?? 'sk-...'}
              autoComplete="off"
            />
            {provider.apiKeyUrl && (
              <a
                className="rt-provider-form__link"
                href={provider.apiKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('runtimes.getApiKey')} →
              </a>
            )}
          </label>
        )}

        {/* Base URL (for custom provider) */}
        {!isCodex && providerId === 'custom' && (
          <label className="rt-provider-form__field">
            <span className="rt-provider-form__label">{t('runtimes.baseUrl')}</span>
            <input
              type="url"
              className="rt-provider-form__input"
              value={customBaseUrl}
              onChange={(e) => { setCustomBaseUrl(e.target.value); setSaveState('idle'); }}
              placeholder="https://api.example.com/anthropic"
            />
          </label>
        )}

        {/* Model mapping for third-party providers */}
        {!isCodex && isThirdParty && (
          <div className="rt-provider-form__mapping">
            <button
              type="button"
              className="rt-btn rt-btn--xs rt-btn--ghost rt-provider-mapping-toggle"
              onClick={() => setShowMapping(!showMapping)}
            >
              {showMapping ? '▾' : '▸'} {t('runtimes.models')}
            </button>
            {showMapping && (
              <div className="rt-provider-mapping">
                <p className="rt-provider-mapping__hint">{t('runtimes.modelMappingHint')}</p>
                {(['sonnet', 'haiku', 'opus'] as const).map((alias) => (
                  <label key={alias} className="rt-provider-mapping__field">
                    <span className="rt-provider-mapping__alias">{alias}</span>
                    <span className="rt-provider-mapping__arrow">→</span>
                    <input
                      type="text"
                      className="rt-provider-form__input rt-provider-mapping__input"
                      value={mapping[alias]}
                      onChange={(e) => {
                        setMapping({ ...mapping, [alias]: e.target.value });
                        setSaveState('idle');
                      }}
                      placeholder={`${alias} model id`}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Provider docs link */}
        {provider.docsUrl && (
          <a
            className="rt-provider-form__link"
            href={provider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('runtimes.providerDocs')} →
          </a>
        )}

        {/* Save button + status */}
        <div className="rt-provider-form__actions">
          <button
            className="rt-btn rt-btn--sm"
            onClick={handleSave}
            disabled={saveState === 'saving'}
          >
            {saveState === 'saving' ? t('runtimes.saving') : t('runtimes.save')}
          </button>
          {saveState === 'saved' && (
            <span className="rt-provider-form__status rt-provider-form__status--ok">
              ✓ {t('runtimes.providerSaved')}
            </span>
          )}
          {saveState === 'error' && (
            <span className="rt-provider-form__status rt-provider-form__status--err">
              ✗ {t('runtimes.saveFailed')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
