import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import {
  CLAUDE_PROVIDERS,
  detectProvider,
  buildProviderEnv,
  type ProviderPreset,
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

  // Load current config on mount
  useEffect(() => {
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
  }, [agentId]);

  const provider = CLAUDE_PROVIDERS.find((p) => p.id === providerId) ?? CLAUDE_PROVIDERS[0];

  const handleProviderChange = useCallback((id: string) => {
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
  }, []);

  const handleSave = useCallback(async () => {
    setSaveState('saving');
    try {
      const modelMapping = (mapping.sonnet || mapping.haiku || mapping.opus)
        ? mapping
        : undefined;
      const env = buildProviderEnv(providerId, apiKey, customBaseUrl, modelMapping);
      await api.updateAgentConfig(agentId, { env });
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 3000);
    } catch (err) {
      setSaveState('error');
    }
  }, [agentId, providerId, apiKey, customBaseUrl, mapping]);

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
            {CLAUDE_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>

        {/* API Key */}
        {providerId !== 'anthropic' && (
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
        {providerId === 'custom' && (
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
        {isThirdParty && (
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
