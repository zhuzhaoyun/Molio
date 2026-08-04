import { useState, useEffect, useRef, type ClipboardEvent } from 'react';
import { parseSkillMd } from '@molio/contracts';
import type { SkillManifestEntry, PrefillResult, ImportSkillRequest } from '@molio/contracts';
import { useI18n } from '../../i18n';

export type SkillFormMode = 'create' | 'edit' | 'prefill' | 'new';

export interface SkillFormValues {
  name: string;
  description: string;
  instructions: string;
}

interface SkillEditorProps {
  show: boolean;
  mode: SkillFormMode;
  /** Existing skill (edit mode). */
  skill?: SkillManifestEntry | null;
  /** Prefilled values (prefill mode). */
  prefillData?: PrefillResult | null;
  /**
   * Initial field values for create / edit modes (edit prefills the skill's
   * current values; duplicate prefills a copy with a "副本" name suffix).
   */
  initialValues?: Partial<SkillFormValues> | null;
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
 * Fullscreen skill editor — takes over the whole screen (Claude Cowork /
 * ChatGPT-style dedicated authoring surface) instead of the old 520px modal:
 * name + description sit in a compact metadata row and the SKILL.md body
 * editor fills all remaining height (Ctrl/Cmd+S saves).
 *
 * Authoring surface — three explicit fields (name / description / instructions):
 *   - new           → the single "新建技能" surface: a source switch at the top
 *                     toggles between the three-field form (→ create via onSave)
 *                     and importing a local file / folder path (→ onImport).
 *   - create / edit → the same three fields; `create` is reused by "duplicate"
 *                     (prefilled copy).
 *   - prefill       → three fields prefilled from the AI extraction of an
 *                     assistant reply ("存为技能").
 *
 * Pasting a complete SKILL.md into the instructions field auto-extracts the
 * frontmatter into the name / description fields (stripping it from the body),
 * so the convenience of a whole-document paste never hides what will actually
 * be saved — extraction only ever FILLS the editable fields.
 */
export function SkillEditor({
  show,
  mode,
  skill,
  prefillData,
  initialValues,
  busy,
  externalError,
  onClose,
  onSave,
  onImport,
}: SkillEditorProps) {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [source, setSource] = useState<NewSource>('paste');
  const [folderPath, setFolderPath] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Reset fields whenever the editor (re)opens for a given mode/target.
  useEffect(() => {
    if (!show) return;
    setFieldError(null);
    setSource('paste');
    setFolderPath('');
    if (mode === 'prefill' && prefillData) {
      setName(prefillData.name);
      setDescription(prefillData.description);
      setInstructions(prefillData.instructions);
    } else {
      setName(initialValues?.name ?? '');
      setDescription(initialValues?.description ?? '');
      setInstructions(initialValues?.instructions ?? '');
    }
  }, [show, mode, skill, prefillData, initialValues]);

  // The new-skill surface imports only when its source switch is on "import";
  // otherwise (and for standalone create/edit) it authors via the three fields.
  const isImportSource = mode === 'new' && source === 'import';
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

  /**
   * Pasting a complete SKILL.md into the instructions field auto-extracts it:
   * frontmatter name / description fill their own fields and the frontmatter is
   * stripped, leaving only the instruction body. Plain text (nothing
   * extractable) pastes through untouched. The results land in EDITABLE fields,
   * so a wrong extraction is always visible + correctable before saving.
   */
  const handleInstructionsPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const parsed = parseSkillMd(text);
    const extractedName = parsed.name.trim();
    const extractedDesc = parsed.description.trim();
    if (!extractedName && !extractedDesc) return;
    e.preventDefault();
    if (extractedName) setName(extractedName);
    if (extractedDesc) setDescription(extractedDesc);
    setInstructions(parsed.instructions);
  };

  /**
   * All three fields are REQUIRED: the description is the only thing the agent
   * sees when deciding whether to invoke the skill, so saving without one ships
   * a skill that never matches — exactly the silent breakage this form exists
   * to prevent.
   */
  const validateFields = (): boolean => {
    if (!name.trim()) {
      setFieldError(t('skills.form.nameRequired'));
      return false;
    }
    if (!description.trim()) {
      setFieldError(t('skills.form.descriptionRequired'));
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
    if (!validateFields()) return;
    void onSave?.({ name: name.trim(), description: description.trim(), instructions });
  };

  // Ctrl/Cmd+S saves without leaving the editor. The handler reads the latest
  // field state through a ref so the keydown listener attaches once per open.
  const submitRef = useRef(handleSubmit);
  useEffect(() => {
    submitRef.current = handleSubmit;
  });
  useEffect(() => {
    if (!show) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!busy) submitRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [show, busy]);

  if (!show) return null;

  const submitLabel = isImportSource ? t('skills.form.importAction') : t('skills.form.save');

  return (
    <div
      className="sk-editor"
      data-testid="skill-form-overlay"
      // NO click-on-empty-space-to-close: every mode of this editor carries
      // content that is painful to lose — a pasted/typed name + description +
      // instructions, or a long import path. A stray click must not wipe it;
      // only the Back / Cancel buttons close the editor.
    >
      <header className="sk-editor__bar">
        <button
          type="button"
          className="sk-editor__back"
          data-testid="skill-form-back"
          onClick={onClose}
          aria-label={t('skills.form.cancel')}
          disabled={busy}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h2 className="sk-editor__title">{t(titleKey(mode))}</h2>
        <div className="sk-editor__actions">
          <button
            type="button"
            className="kb-btn kb-btn-ghost"
            data-testid="skill-form-cancel"
            onClick={onClose}
            disabled={busy}
          >
            {t('skills.form.cancel')}
          </button>
          <button
            type="button"
            className="kb-btn kb-btn-primary"
            data-testid="skill-form-submit"
            onClick={handleSubmit}
            disabled={busy}
          >
            {busy ? t('skills.form.saving') : submitLabel}
          </button>
        </div>
      </header>

      <div className="sk-editor__body">
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
        ) : (
          <>
            <div className="sk-editor__meta">
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
                <span className="sk-field__label">{t('skills.form.description')} *</span>
                <input
                  className="sk-field__input"
                  data-testid="skill-description-input"
                  type="text"
                  value={description}
                  placeholder={t('skills.form.descriptionPlaceholder')}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            </div>

            <label className="sk-field sk-field--grow">
              <span className="sk-field__label">{t('skills.form.instructions')} *</span>
              <textarea
                className="sk-field__textarea sk-field__textarea--md"
                data-testid="skill-instructions-input"
                value={instructions}
                placeholder={t('skills.form.instructionsPlaceholder')}
                onChange={(e) => setInstructions(e.target.value)}
                onPaste={handleInstructionsPaste}
              />
            </label>
            {mode !== 'prefill' && (
              <p className="sk-form-hint">{t('skills.form.pasteHint')}</p>
            )}
          </>
        )}

        {(fieldError || externalError) && (
          <div className="sk-form-error" data-testid="skill-form-error">{fieldError || externalError}</div>
        )}
      </div>
    </div>
  );
}
