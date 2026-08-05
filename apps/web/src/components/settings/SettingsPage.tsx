import { useState } from 'react';
import { RuntimesPanel } from './RuntimesPanel';
import { ChannelsPanel } from './ChannelsPanel';
import { useI18n } from '../../i18n';
import { LanguageSettings } from './LanguageSettings';
import { ThemeSettings } from './ThemeSettings';
import { UpdateSettings } from './UpdateSettings';

type Tab = 'general' | 'runtimes' | 'channels';

export function SettingsPage() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>('general');

  return (
    <div className="settings-shell">
      {/* Header */}
      <div className="settings-header">
        <h1 className="settings-header__title">{t('settings.title')}</h1>
      </div>

      {/* Tab Nav */}
      <div className="settings-tab-nav">
        <button
          type="button"
          className={`settings-tab-btn${activeTab === 'general' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('general')}
        >
          {t('settings.tabGeneral')}
        </button>
        <button
          type="button"
          className={`settings-tab-btn${activeTab === 'runtimes' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('runtimes')}
        >
          {t('settings.tabRuntimes')}
        </button>
        <button
          type="button"
          className={`settings-tab-btn${activeTab === 'channels' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('channels')}
        >
          {t('settings.tabChannels')}
        </button>
      </div>

      {/* Content */}
      <div className="settings-content">
        {activeTab === 'general' && (
          <>
            <LanguageSettings />
            <ThemeSettings />
            <UpdateSettings />
          </>
        )}
        {activeTab === 'runtimes' && <RuntimesPanel />}
        {activeTab === 'channels' && <ChannelsPanel />}
      </div>
    </div>
  );
}
