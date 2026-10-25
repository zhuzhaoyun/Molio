import { useState, useEffect, useRef, useCallback, type ClipboardEvent, type DragEvent } from 'react';
import { parseSkillMd } from '@molio/contracts';
import type {
  SkillManifestEntry, PrefillResult, ImportSkillRequest,
  SkillImportPreview, SkillImportConflict, SkillImportIssueCode,
} from '@molio/contracts';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';

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
  /**
   * Content-dir listing (edit/duplicate) — the folded "查看目录结构" view with
   * a desktop reveal shortcut. View and edit share one surface. Absent (null)
   * for new/create-from-scratch: there is no content dir yet.
   */
  files?: { dir: string; files: { path: string; size: number }[]; truncated: boolean } | null;
  onClose: () => void;
  /** create / edit / prefill / new(paste) → save a skill from form values. */
  onSave?: (values: SkillFormValues) => void | Promise<void>;
  /** new(import) → import from a local file / folder path. */
  onImport?: (req: ImportSkillRequest) => void | Promise<void>;
}

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
 *   - new           → the single "新建技能" surface: import (dropzone / path /
 *                     preview card) and the manual three-field form live on ONE
 *                     page; the primary button follows the last-produced source
 *                     (a passing preview → 导入 via onImport, otherwise → 保存
 *                     via onSave).
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
  prefillData,
  initialValues,
  busy,
  externalError,
  files,
  onClose,
  onSave,
  onImport,
}: SkillEditorProps) {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [previewConflict, setPreviewConflict] = useState<SkillImportConflict | null>(null);
  const [previewName, setPreviewName] = useState('');
  const [previewDescription, setPreviewDescription] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Reset fields exactly at the closed→open transition. Two hazards guarded:
  //  - resetting on ANY prop change while open would let a parent re-render
  //    (fresh initialValues/prefillData object identity) wipe what the user
  //    is typing mid-edit;
  //  - keying only on `show` would still reset correctly, but the transition
  //    ref makes the "already open → ignore" intent explicit and lint-proof.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!show) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return; // already open — never reset mid-edit
    wasOpenRef.current = true;
    setFieldError(null);
    setFolderPath('');
    setPreview(null);
    setPreviewConflict(null);
    setPreviewName('');
    setPreviewDescription('');
    setPreviewError(null);
    setDragActive(false);
    if (mode === 'prefill' && prefillData) {
      setName(prefillData.name);
      setDescription(prefillData.description);
      setInstructions(prefillData.instructions);
    } else {
      setName(initialValues?.name ?? '');
      setDescription(initialValues?.description ?? '');
      setInstructions(initialValues?.instructions ?? '');
    }
  }, [show, mode, prefillData, initialValues]);

  // The desktop app exposes native pickers; a browser (Docker/NAS) does not, so
  // there we hide the browse buttons and let the user type the container path.
  const isDesktop = Boolean(window.__electron__?.showDirectoryPicker);

  const runPreview = useCallback(async (src: { folderPath: string }) => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const resp = await api.previewSkillImport(src);
      setPreview(resp.preview);
      setPreviewConflict(resp.conflict);
      setPreviewName(resp.preview.name);
      setPreviewDescription(resp.preview.description);
    } catch (err) {
      setPreview(null);
      setPreviewConflict(null);
      setPreviewError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  }, []);

  const previewByPath = useCallback((picked: string) => {
    setFolderPath(picked);
    void runPreview({ folderPath: picked });
  }, [runPreview]);

  const handleBrowseFolder = async () => {
    const picked = await window.__electron__?.showDirectoryPicker();
    if (picked) previewByPath(picked);
  };

  const handleBrowseFile = async () => {
    const picked = await window.__electron__?.showSkillFilePicker?.();
    if (picked) previewByPath(picked);
  };

  const ISSUE_KEY: Record<SkillImportIssueCode, string> = {
    NO_ENTRY: 'skills.form.issueNoEntry',
    EMPTY_BODY: 'skills.form.issueEmptyBody',
    SOURCE_UNREADABLE: 'skills.form.issueSourceUnreadable',
    UNSUPPORTED_TYPE: 'skills.form.issueUnsupportedType',
    TOO_MANY_FILES: 'skills.form.issueTooManyFiles',
    TOO_LARGE: 'skills.form.issueTooLarge',
    NAME_FALLBACK: 'skills.form.previewNameFallback',
    DESCRIPTION_FALLBACK: 'skills.form.previewDescFallback',
  };

  const issueText = (issue: SkillImportPreview['issues'][number]): string =>
    issue.code === 'NAME_FALLBACK'
      ? t('skills.form.previewNameFallback', { name: previewName.trim() || preview?.name || '' })
      : t(ISSUE_KEY[issue.code], {});

  // Drop zone accepts exactly ONE entry: a folder or a single .md. Dragging
  // non-files (text, page elements) yields an empty files list — a silent
  // no-op, never an error (Review Focus #1).
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const list = e.dataTransfer.files;
    if (!list || list.length === 0) return;
    if (list.length > 1) setPreviewError(t('skills.form.dropOneOnly'));
    if (!isDesktop) {
      setPreviewError(t('skills.form.dropDesktopOnly'));
      return;
    }
    const dropped = window.__electron__?.getPathForFile?.(list[0]);
    if (!dropped) {
      setPreviewError(t('skills.form.dropResolveFail'));
      return;
    }
    previewByPath(dropped);
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

  // ONE merged new-skill surface: dropzone/path on top, the manual three-field
  // form below. The primary button follows whatever the user last produced —
  // a passing preview switches it to 导入; without a preview it is the plain 保存.
  // edit/prefill never produce a preview, so they always take the save path.
  const handleSubmit = () => {
    if (preview) {
      // Confirm is only meaningful after a PASSING preview (Review Focus #3:
      // if the source vanished since, onImport fails and the editor stays open
      // with the error — same contract as save-failure). A failed preview
      // no-ops here, matching the disabled primary button.
      if (!preview.ok) return;
      setFieldError(null);
      void onImport?.({
        folderPath: folderPath.trim(),
        ...(previewName.trim() ? { name: previewName.trim() } : {}),
        ...(previewDescription.trim() ? { description: previewDescription.trim() } : {}),
      });
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

  const submitLabel = preview ? t('skills.form.importAction') : t('skills.form.save');

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
            disabled={busy || (!!preview && !preview.ok)}
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
          <div className="sk-import">
            <div
              className={`sk-import-dropzone${dragActive ? ' sk-import-dropzone--active' : ''}`}
              data-testid="skill-import-dropzone"
              onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
            >
              <span className="sk-import-dropzone__icon">📥</span>
              {/* Re-drag semantics are REPLACE: with a preview already on
                  screen, say so at drag-time instead of leaving the user to
                  guess whether the drop appends or overwrites. */}
              <span>{t(dragActive && preview ? 'skills.form.dropReplace' : 'skills.form.dropHint')}</span>
            </div>

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
                <button
                  type="button"
                  className="sk-browse-btn"
                  data-testid="skill-import-preview-btn"
                  onClick={() => { const p = folderPath.trim(); if (p) void runPreview({ folderPath: p }); }}
                  disabled={previewing}
                >
                  {previewing ? t('skills.form.previewing') : t('skills.form.previewAction')}
                </button>
                {isDesktop && (
                  <>
                    <button type="button" className="sk-browse-btn" data-testid="skill-import-browse-folder" onClick={handleBrowseFolder}>
                      {t('skills.form.browseFolder')}
                    </button>
                    <button type="button" className="sk-browse-btn" data-testid="skill-import-browse-file" onClick={handleBrowseFile}>
                      {t('skills.form.browseFile')}
                    </button>
                  </>
                )}
              </div>
              {!isDesktop && <p className="sk-form-hint">{t('skills.form.browseDesktopOnly')}</p>}
            </div>

            {preview && (
              <div className="sk-preview" data-testid="skill-import-preview-card">
                {/* Clear the preview to fall back to the manual form — the
                    visible way out of import mode (re-drop replaces, this
                    removes). */}
                <button
                  type="button"
                  className="sk-preview__clear"
                  data-testid="skill-import-preview-clear"
                  onClick={() => { setPreview(null); setPreviewConflict(null); }}
                  aria-label={t('skills.form.cancel')}
                >
                  ×
                </button>
                <div className="sk-editor__meta">
                  <label className="sk-field">
                    <span className="sk-field__label">{t('skills.form.name')} *</span>
                    <input
                      className="sk-field__input"
                      data-testid="skill-import-preview-name"
                      type="text"
                      value={previewName}
                      onChange={(e) => setPreviewName(e.target.value)}
                    />
                  </label>
                  <label className="sk-field">
                    <span className="sk-field__label">{t('skills.form.description')}</span>
                    <input
                      className="sk-field__input"
                      data-testid="skill-import-preview-description"
                      type="text"
                      value={previewDescription}
                      onChange={(e) => setPreviewDescription(e.target.value)}
                    />
                  </label>
                </div>

                <div className={`sk-preview__verdict${preview.ok ? '' : ' sk-preview__verdict--error'}`}>
                  {preview.ok
                    ? (preview.files.length > 1
                        ? t('skills.form.previewStructureOk', { count: String(preview.files.length - 1) })
                        : t('skills.form.previewStructureSingle'))
                    : t(ISSUE_KEY[(preview.issues.find((i) => i.level === 'error'))!.code], {})}
                </div>

                {preview.issues.filter((i) => i.level === 'warning').map((i) => (
                  <div key={i.code} className="sk-preview__issue sk-preview__issue--warning">{issueText(i)}</div>
                ))}

                {preview.truncated && <div className="sk-preview__issue">{t('skills.form.previewTruncated')}</div>}

                {previewConflict && (
                  <div className="sk-preview__conflict" data-testid="skill-import-conflict">
                    {t('skills.form.previewConflict', { name: previewConflict.existingName })}
                  </div>
                )}

                {preview.files.length > 0 && (
                  <details className="sk-preview__files">
                    <summary data-testid="skill-import-files-toggle">
                      {t('skills.form.previewFilesToggle', { count: String(preview.files.length) })}
                    </summary>
                    <ul>
                      {preview.files.map((f) => <li key={f.path}>{f.path}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}

            <p className="sk-form-hint sk-import__divider">{t('skills.form.manualHint')}</p>
          </div>
        )}

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

        {files && files.files.length > 0 && (
          <details className="sk-preview__files">
            <summary data-testid="skill-editor-files-toggle">
              {t('skills.form.previewFilesToggle', { count: String(files.files.length) })}
            </summary>
            {isDesktop && files.dir && (
              <button
                type="button"
                className="rt-btn rt-btn--sm rt-btn--ghost sk-files-reveal"
                onClick={() => void window.__electron__?.showItemInFolder(files.dir)}
              >
                {t('skills.row.reveal')}
              </button>
            )}
            {files.truncated && <div className="sk-preview__issue">{t('skills.form.previewTruncated')}</div>}
            <ul>
              {files.files.map((f) => <li key={f.path}>{f.path}</li>)}
            </ul>
          </details>
        )}

        {(fieldError || externalError || previewError) && (
          <div className="sk-form-error" data-testid="skill-form-error">{fieldError || externalError || previewError}</div>
        )}
      </div>
    </div>
  );
}
