import { useState, useEffect } from 'react';
import type { SkillManifestEntry, PrefillResult, ImportSkillRequest } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { parseSkillMd } from '../../utils/skillmd';

export type SkillFormMode = 'create' | 'edit' | 'prefill' | 'new';

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
  /**
   * Initial SKILL.md text for create / edit modes (edit prefills the skill's
   * serialized SKILL.md; duplicate prefills a copy; blank create leaves it empty
   * so the example placeholder shows).
   */
  initialMarkdown?: string;
  busy?: boolean;
  /**
   * Error from the host (e.g. the save request failed) — shown alongside
   * inline validation errors. The host clears it on close / retry.
   */
  externalError?: string | null;
  onClose: () => void;
  /** create / edit / prefill / new(paste) → save a skill from form values. */
  onSave?: (values: SkillFormValues) => void | Promise<void>;
  /** new(import) → import from a local file / folder path. */
  onImport?: (req: ImportSkillRequest) => void | Promise<void>;
}

/** Where the new-skill dialog sources its content from. */
type NewSource = 'paste' | 'import';

function titleKey(mode: SkillFormMode): string {
  switch (mode) {
    case 'create': return 'skills.form.createTitle';
    case 'edit': return 'skills.form.editTitle';
    case 'prefill': return 'skills.form.prefillTitle';
    case 'new': return 'skills.form.createTitle';
  }
}

/**
 * Reusable skill form modal. Reuses the generic kb-overlay / kb-modal chrome
 * (defined in knowledge.css) and .sk-form-* field styles (settings.css).
 *
 * Authoring surface:
 *   - new           → the single "新建技能" dialog: a source switch at the top
 *                     toggles between pasting a SKILL.md (→ create via onSave) and
 *                     importing a local file / folder path (→ onImport). Pasting is
 *                     creating; only a file/folder counts as an import.
 *   - create / edit → a single SKILL.md markdown editor (frontmatter + body).
 *                     `create` is reused by "duplicate" (prefilled with a copy).
 *   - prefill       → three separate fields (name / description / instructions),
 *                     since the AI-extracted parts are easier to tweak individually.
 */
export function SkillFormModal({
  show,
  mode,
  skill,
  prefillData,
  initialMarkdown,
  busy,
  externalError,
  onClose,
  onSave,
  onImport,
}: SkillFormModalProps) {
  const { t } = useI18n();

  // create / edit share a single SKILL.md editor.
  const [markdown, setMarkdown] = useState('');
  // prefill keeps three discrete fields.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [source, setSource] = useState<NewSource>('paste');
  const [folderPath, setFolderPath] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Reset fields whenever the modal (re)opens for a given mode/target.
  useEffect(() => {
    if (!show) return;
    setFieldError(null);
    setSource('paste');
    setFolderPath('');
    if (mode === 'create' || mode === 'edit' || mode === 'new') {
      setMarkdown(initialMarkdown ?? '');
      setName('');
      setDescription('');
      setInstructions('');
    } else if (mode === 'prefill' && prefillData) {
      setName(prefillData.name);
      setDescription(prefillData.description);
      setInstructions(prefillData.instructions);
      setMarkdown('');
    } else {
      setName('');
      setDescription('');
      setInstructions('');
      setMarkdown('');
    }
  }, [show, mode, skill, prefillData, initialMarkdown]);

  if (!show) return null;

  // The new-skill dialog imports only when its source switch is on "import";
  // otherwise (and for standalone create/edit) it authors via the markdown editor.
  const isImportSource = mode === 'new' && source === 'import';
  const isMarkdown = mode === 'create' || mode === 'edit' || (mode === 'new' && source === 'paste');
  // The desktop app exposes native pickers; a browser (Docker/NAS) does not, so
  // there we hide the browse buttons and let the user type the container path.
  const isDesktop = Boolean(window.__electron__?.showDirectoryPicker);

  const handleBrowseFolder = async () => {
    const picked = await window.__electron__?.showDirectoryPicker();
    if (picked) setFolderPath(picked);
  };

  const handleBrowseFile = async () => {
    const picked = await window.__electron__?.showSkillFilePicker?.();
    if (picked) setFolderPath(picked);
  };

  /** Validate the prefill three-field form. */
  const validateFields = (): boolean => {
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

  /** Parse + validate the SKILL.md editor; returns fields or null on error. */
  const validateMarkdown = (): SkillFormValues | null => {
    const parsed = parseSkillMd(markdown);
    if (!parsed.name.trim()) {
      setFieldError(t('skills.form.nameRequired'));
      return null;
    }
    if (!parsed.instructions.trim()) {
      setFieldError(t('skills.form.instructionsRequired'));
      return null;
    }
    setFieldError(null);
    return {
      name: parsed.name.trim(),
      description: parsed.description.trim(),
      instructions: parsed.instructions,
    };
  };

  const handleSubmit = () => {
    if (isImportSource) {
      const folder = folderPath.trim();
      if (!folder) {
        setFieldError(t('skills.form.folderRequired'));
        return;
      }
      setFieldError(null);
      void onImport?.({ folderPath: folder });
      return;
    }
    if (isMarkdown) {
      const values = validateMarkdown();
      if (!values) return;
      void onSave?.(values);
      return;
    }
    // prefill
    if (!validateFields()) return;
    void onSave?.({ name: name.trim(), description: description.trim(), instructions });
  };

  const submitLabel = isImportSource ? t('skills.form.importAction') : t('skills.form.save');

  return (
    <div
      className="kb-overlay show"
      data-testid="skill-form-overlay"
      onClick={(e) => {
        // The import source carries a long file path that is easy to lose on a
        // stray backdrop click — only close it via the Cancel / × buttons. Other
        // modes keep the click-outside-to-close UX.
        if (isImportSource) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="kb-modal" style={{ width: isMarkdown ? 640 : 520 }}>
        <div className="kb-modal-header">
          <h2>{t(titleKey(mode))}</h2>
          <button className="kb-modal-close" onClick={onClose} aria-label="close">&times;</button>
        </div>
        <div className="kb-modal-body">
          {mode === 'prefill' && (
            <p className="sk-form-hint">{t('skills.form.prefillHint')}</p>
          )}

          {mode === 'new' && (
            <div className="sk-import-switch" role="tablist">
              <button
                type="button"
                role="tab"
                className={`sk-import-switch__btn${source === 'paste' ? ' is-active' : ''}`}
                data-testid="skill-source-paste"
                onClick={() => setSource('paste')}
              >
                {t('skills.form.sourcePaste')}
              </button>
              <button
                type="button"
                role="tab"
                className={`sk-import-switch__btn${source === 'import' ? ' is-active' : ''}`}
                data-testid="skill-source-import"
                onClick={() => setSource('import')}
              >
                {t('skills.form.sourceImport')}
              </button>
            </div>
          )}

          {isImportSource ? (
            <div className="sk-field">
              <span className="sk-field__label">{t('skills.form.importModeFolder')}</span>
              <div className="sk-import-row">
                <input
                  className="sk-field__input"
                  data-testid="skill-import-folder"
                  type="text"
                  value={folderPath}
                  placeholder={t('skills.form.folderPlaceholder')}
                  onChange={(e) => setFolderPath(e.target.value)}
                />
                {isDesktop && (
                  <>
                    <button
                      type="button"
                      className="sk-browse-btn"
                      data-testid="skill-import-browse-folder"
                      onClick={handleBrowseFolder}
                    >
                      {t('skills.form.browseFolder')}
                    </button>
                    <button
                      type="button"
                      className="sk-browse-btn"
                      data-testid="skill-import-browse-file"
                      onClick={handleBrowseFile}
                    >
                      {t('skills.form.browseFile')}
                    </button>
                  </>
                )}
              </div>
              {!isDesktop && (
                <p className="sk-form-hint">{t('skills.form.browseDesktopOnly')}</p>
              )}
            </div>
          ) : isMarkdown ? (
            <label className="sk-field sk-field--grow">
              <span className="sk-field__label">SKILL.md</span>
              <textarea
                className="sk-field__textarea sk-field__textarea--code sk-field__textarea--md"
                data-testid="skill-markdown-input"
                value={markdown}
                placeholder={t('skills.form.markdownPlaceholder')}
                onChange={(e) => setMarkdown(e.target.value)}
              />
            </label>
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

          {(fieldError || externalError) && (
            <div className="sk-form-error" data-testid="skill-form-error">{fieldError || externalError}</div>
          )}
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
