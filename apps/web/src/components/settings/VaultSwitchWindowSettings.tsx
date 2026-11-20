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

/** 「切换知识库时」：跨库 pick 新开窗口（默认）或就地复用当前窗口。 */
export function VaultSwitchWindowSettings() {
  const { t } = useI18n();
  const [mode, setMode] = useState<VaultSwitchWindowMode>(readVaultSwitchWindowMode);

  return (
    <section className="settings-section">
      <h2 className="rt-section-title">{t('settings.vaultSwitchWindow')}</h2>
      <div className="settings-choice-card">
        <select
          className="settings-select"
          data-testid="setting-vault-switch-window"
          value={mode}
          onChange={(e) => {
            const next = e.target.value as VaultSwitchWindowMode;
            setMode(next);
            setVaultSwitchWindowMode(next);
          }}
        >
          {MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
          ))}
        </select>
        <p className="settings-choice-hint">{t('settings.vaultSwitchWindowHint')}</p>
      </div>
    </section>
  );
}
