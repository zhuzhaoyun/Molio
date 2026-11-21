import { useState } from 'react';
import { useI18n } from '../../i18n';
import {
  readVaultSwitchWindowMode,
  setVaultSwitchWindowMode,
  type VaultSwitchWindowMode,
} from '../../utils/vaultSwitchWindow';

const MODE_OPTIONS: { value: VaultSwitchWindowMode; labelKey: string }[] = [
  { value: 'new-window', labelKey: 'settings.vaultSwitchWindowNew' },
  { value: 'reuse', labelKey: 'settings.vaultSwitchWindowReuse' },
];

/** 「切换知识库时」：跨库 pick 新开窗口（默认）或就地复用当前窗口。
 *  控件与语言/主题同款 choice-pill——设置页只讲一种控件语言。 */
export function VaultSwitchWindowSettings() {
  const { t } = useI18n();
  const [mode, setMode] = useState<VaultSwitchWindowMode>(readVaultSwitchWindowMode);

  return (
    <section className="settings-section">
      <h2 className="rt-section-title">{t('settings.vaultSwitchWindow')}</h2>
      <div className="settings-choice-card">
        <div className="settings-choice-pills" data-testid="setting-vault-switch-window">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              data-testid={`setting-vault-switch-${opt.value}`}
              className={`settings-choice-pill${mode === opt.value ? ' is-active' : ''}`}
              onClick={() => {
                setMode(opt.value);
                setVaultSwitchWindowMode(opt.value);
              }}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
        <p className="settings-choice-hint">{t('settings.vaultSwitchWindowHint')}</p>
      </div>
    </section>
  );
}
