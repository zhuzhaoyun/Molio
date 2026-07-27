import { useState, useEffect } from 'react';
import type { SkillManifestEntry, PrefillResult, ImportSkillRequest } from '@molio/contracts';
import { useI18n } from '../../i18n';

export type SkillFormMode = 'create' | 'edit' | 'prefill' | 'import';

export interface SkillFormValues {
  name: string;
  description: string;
  instructions: string;
}

interface SkillFormModalProps {
  show: boolean;
  mode: SkillFormMode;
  /** Existing skill (edit mode). */
  skill?: SkillManifestEntry | null;
  /** Prefilled values (prefill mode). */
  prefillData?: PrefillResult | null;
  /** Initial raw instructions for create mode (optional). */
  initialInstructions?: string;
  busy?: boolean;
  onClose: () => void;
  /** create / edit / prefill → save a skill from form values. */
  onSave?: (values: SkillFormValues) => void | Promise<void>;
  /** import mode → import from raw text or a folder path. */
  onImport?: (req: ImportSkillRequest) => void | Promise<void>;
}

type ImportMode = 'raw' | 'folder';

function titleKey(mode: SkillFormMode): string {
  switch (mode) {
    case 'create': return 'skills.form.createTitle';
    case 'edit': return 'skills.form.editTitle';
    case 'prefill': return 'skills.form.prefillTitle';
    case 'import': return 'skills.form.importTitle';
  }
}

/**
 * Reusable skill form modal. Reuses the generic kb-overlay / kb-modal chrome
 * (defined in knowledge.css) and .sk-form-* field styles (settings.css).
 */
export function SkillFormModal({
  show,
  mode,
  skill,
  prefillData,
  initialInstructions,
  busy,
  onClose,
  onSave,
  onImport,
}: SkillFormModalProps) {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [importMode, setImportMode] = useState<ImportMode>('raw');
  const [raw, setRaw] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Reset fields whenever the modal (re)opens for a given mode/target.
  useEffect(() => {
    if (!show) return;
    setFieldError(null);
    setImportMode('raw');
    setRaw('');
    setFolderPath('');
    if (mode === 'edit' && skill) {
      setName(skill.name);
      setDescription(skill.description);
      // instructions are loaded by the parent and passed via initialInstructions
      setInstructions(initialInstructions ?? '');
    } else if (mode === 'prefill' && prefillData) {
      setName(prefillData.name);
      setDescription(prefillData.description);
      setInstructions(prefillData.instructions);
    } else {
      setName('');
      setDescription('');
      setInstructions(initialInstructions ?? '');
    }
  }, [show, mode, skill, prefillData, initialInstructions]);

  if (!show) return null;

  const isImport = mode === 'import';

  const validate = (): boolean => {
    if (!name.trim()) {
      setFieldError(t('skills.form.nameRequired'));
      return false;
    }
    if (!instructions.trim()) {
      setFieldError(t('skills.form.instructionsRequired'));
      return false;
    }
    setFieldError(null);
    return true;
  };

  const handleSubmit = () => {
    if (isImport) {
      const req: ImportSkillRequest =
        importMode === 'raw' ? { raw: raw.trim() } : { folderPath: folderPath.trim() };
      const provided = importMode === 'raw' ? req.raw : req.folderPath;
      if (!provided) {
        setFieldError(importMode === 'raw' ? t('skills.form.instructionsRequired') : t('skills.form.nameRequired'));
        return;
      }
      setFieldError(null);
      void onImport?.(req);
      return;
    }
    if (!validate()) return;
    void onSave?.({ name: name.trim(), description: description.trim(), instructions });
  };

  const submitLabel = isImport ? t('skills.form.importAction') : t('skills.form.save');

  return (
    <div
      className="kb-overlay show"
      data-testid="skill-form-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="kb-modal" style={{ width: 520 }}>
        <div className="kb-modal-header">
          <h2>{t(titleKey(mode))}</h2>
          <button className="kb-modal-close" onClick={onClose} aria-label="close">&times;</button>
        </div>
        <div className="kb-modal-body">
          {mode === 'prefill' && (
            <p className="sk-form-hint">{t('skills.form.prefillHint')}</p>
          )}

          {isImport ? (
            <>
              <div className="sk-import-switch" role="tablist">
                <button
                  type="button"
                  role="tab"
                  className={`sk-import-switch__btn${importMode === 'raw' ? ' is-active' : ''}`}
                  onClick={() => setImportMode('raw')}
                >
                  {t('skills.form.importModeRaw')}
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`sk-import-switch__btn${importMode === 'folder' ? ' is-active' : ''}`}
                  onClick={() => setImportMode('folder')}
                >
                  {t('skills.form.importModeFolder')}
                </button>
              </div>

              {importMode === 'raw' ? (
                <label className="sk-field">
                  <span className="sk-field__label">SKILL.md</span>
                  <textarea
                    className="sk-field__textarea sk-field__textarea--code"
                    data-testid="skill-import-raw"
                    rows={10}
                    value={raw}
                    placeholder={t('skills.form.rawPlaceholder')}
                    onChange={(e) => setRaw(e.target.value)}
                  />
                </label>
              ) : (
                <label className="sk-field">
                  <span className="sk-field__label">{t('skills.form.importModeFolder')}</span>
                  <input
                    className="sk-field__input"
                    data-testid="skill-import-folder"
                    type="text"
                    value={folderPath}
                    placeholder={t('skills.form.folderPlaceholder')}
                    onChange={(e) => setFolderPath(e.target.value)}
                  />
                </label>
              )}
            </>
          ) : (
            <>
              <label className="sk-field">
                <span className="sk-field__label">{t('skills.form.name')} *</span>
                <input
                  className="sk-field__input"
                  data-testid="skill-name-input"
                  type="text"
                  value={name}
                  placeholder={t('skills.form.namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <label className="sk-field">
                <span className="sk-field__label">{t('skills.form.description')}</span>
                <input
                  className="sk-field__input"
                  data-testid="skill-description-input"
                  type="text"
                  value={description}
                  placeholder={t('skills.form.descriptionPlaceholder')}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>

              <label className="sk-field">
                <span className="sk-field__label">{t('skills.form.instructions')} *</span>
                <textarea
                  className="sk-field__textarea"
                  data-testid="skill-instructions-input"
                  rows={8}
                  value={instructions}
                  placeholder={t('skills.form.instructionsPlaceholder')}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </label>
            </>
          )}

          {fieldError && <div className="sk-form-error" data-testid="skill-form-error">{fieldError}</div>}
        </div>
        <div className="kb-modal-footer">
          <button className="kb-btn kb-btn-ghost" onClick={onClose} disabled={busy}>
            {t('skills.form.cancel')}
          </button>
          <button
            className="kb-btn kb-btn-primary"
            data-testid="skill-form-submit"
            onClick={handleSubmit}
            disabled={busy}
          >
            {busy ? t('skills.form.saving') : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
