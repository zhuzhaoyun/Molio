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

export function ProviderConfig({ agentId }: ProviderConfigProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // Form state
  const [providerId, setProviderId] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  // Load current config on mount
  useEffect(() => {
    api.getAgentConfig(agentId).then((config) => {
      const env = (config.env ?? {}) as Record<string, string>;
      const detected = detectProvider(env);
      setProviderId(detected);
      setApiKey(env['ANTHROPIC_API_KEY'] ?? '');
      if (detected === 'custom') {
        setCustomBaseUrl(env['ANTHROPIC_BASE_URL'] ?? '');
      }
    }).catch(() => {
      // Ignore — defaults are fine
    });
  }, [agentId]);

  const provider = CLAUDE_PROVIDERS.find((p) => p.id === providerId) ?? CLAUDE_PROVIDERS[0];

  const handleProviderChange = useCallback((id: string) => {
    setProviderId(id);
    setSaveState('idle');
    // Clear API key when switching providers
    setApiKey('');
    if (id !== 'custom') {
      const p = CLAUDE_PROVIDERS.find((p) => p.id === id);
      setCustomBaseUrl(p?.baseUrl ?? '');
    }
  }, []);

  const handleSave = useCallback(async () => {
    setSaveState('saving');
    try {
      const env = buildProviderEnv(providerId, apiKey, customBaseUrl);
      await api.updateAgentConfig(agentId, { env });
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 3000);
    } catch (err) {
      setSaveState('error');
    }
  }, [agentId, providerId, apiKey, customBaseUrl]);

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
              placeholder="https://api.example.com/v1"
            />
          </label>
        )}

        {/* Model preview */}
        {provider.models.length > 0 && (
          <div className="rt-provider-form__models">
            <span className="rt-provider-form__label">{t('runtimes.models')}</span>
            <div className="rt-agent-card__models">
              {provider.models.map((m) => (
                <span key={m.id} className="rt-chip">{m.label}</span>
              ))}
            </div>
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
