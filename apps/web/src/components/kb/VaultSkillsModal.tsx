import type { VaultSkillEntry } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { useVaultSkills } from '../../hooks/useVaultSkills';

interface VaultSkillsModalProps {
  show: boolean;
  vaultId: string | null;
  onClose: () => void;
}

/** One row: name/description, built-in badge, per-vault enable switch. */
function VaultSkillRow({
  skill,
  onToggle,
}: {
  skill: VaultSkillEntry;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  // A globally-disabled skill is greyed and its switch is locked off — the
  // master switch lives in Settings → Skills, not per-vault.
  const lockedOff = !skill.globalEnabled;

  return (
    <div
      className={`sk-row${lockedOff ? ' sk-row--off' : ''}`}
      data-testid={`vault-skill-row-${skill.id}`}
    >
      <label className="sk-switch" title={lockedOff ? t('kb.vaultSkillsGlobalOff') : undefined}>
        <input
          type="checkbox"
          data-testid={`vault-skill-toggle-${skill.id}`}
          checked={skill.vaultEnabled}
          disabled={lockedOff}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="sk-switch__track" />
      </label>

      <div className="sk-row__body">
        <div className="sk-row__header">
          <span className="sk-row__name">{skill.name}</span>
          {skill.kind === 'bundled' ? (
            <span className="sk-badge sk-badge--bundled">{t('skills.bundled')}</span>
          ) : (
            skill.builtIn && <span className="sk-badge sk-badge--builtin">{t('skills.builtIn')}</span>
          )}
          {lockedOff && <span className="sk-badge">{t('kb.vaultSkillsGlobalOff')}</span>}
        </div>
        {skill.description && <div className="sk-row__desc">{skill.description}</div>}
      </div>
    </div>
  );
}

/**
 * Per-vault skill enablement modal. Reuses the kb-overlay / kb-modal chrome
 * (knowledge.css) and the sk-row / sk-switch list styles (settings.css).
 */
export function VaultSkillsModal({ show, vaultId, onClose }: VaultSkillsModalProps) {
  const { t } = useI18n();
  const { skills, loading, error, refresh, toggle } = useVaultSkills(vaultId);

  if (!show) return null;

  return (
    <div
      className="kb-overlay show"
      data-testid="vault-skills-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="kb-modal" style={{ width: 560 }}>
        <div className="kb-modal-header">
          <h2>{t('kb.vaultSkillsTitle')}</h2>
          <button className="kb-modal-close" onClick={onClose} aria-label="close">&times;</button>
        </div>

        <div className="kb-modal-body">
          <p className="sk-form-hint">{t('kb.vaultSkillsDesc')}</p>

          {error && (
            <div className="rt-error">
              <span>{error}</span>
              <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={refresh}>{t('skills.retry')}</button>
            </div>
          )}

          {loading ? (
            <div className="rt-loading">{t('skills.loading')}</div>
          ) : skills.length === 0 ? (
            <div className="rt-empty">
              <div className="rt-empty__icon">🧩</div>
              <div className="rt-empty__text">{t('kb.vaultSkillsEmpty')}</div>
            </div>
          ) : (
            <div className="sk-list">
              {skills.map((skill) => (
                <VaultSkillRow
                  key={skill.id}
                  skill={skill}
                  onToggle={(enabled) => void toggle(skill.id, enabled)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="kb-modal-footer">
          <button className="kb-btn kb-btn-ghost" data-testid="vault-skills-close" onClick={onClose}>
            {t('skills.form.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
