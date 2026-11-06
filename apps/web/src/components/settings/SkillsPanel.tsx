import { useState, useCallback, useRef, useEffect } from 'react';
import type { SkillManifestEntry, ImportSkillRequest } from '@molio/contracts';
import { useSkills } from '../../hooks/useSkills';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';
import { SkillEditor, type SkillFormMode, type SkillFormValues } from './SkillEditor';
import { SkillHubPanel } from './SkillHubPanel';

interface ModalState {
  mode: SkillFormMode;
  skill: SkillManifestEntry | null;
  /** Prefilled fields for create (duplicate) / edit. */
  initialValues?: Partial<SkillFormValues>;
  /** Content-dir listing for the editor's folded file view (edit/duplicate). */
  files?: { dir: string; files: { path: string; size: number }[]; truncated: boolean } | null;
}

/**
 * A single skill row: toggle, name/description, duplicate, edit, delete.
 * Only user-managed (library) skills are listed — bundled skills are
 * app-owned, hidden by the API, and always effective.
 */
function SkillRow({
  skill,
  confirmingDelete,
  fetching,
  highlighted,
  onToggle,
  onEdit,
  onDuplicate,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  skill: SkillManifestEntry;
  confirmingDelete: boolean;
  /** True while this row's edit/duplicate content is loading (buttons disabled). */
  fetching: boolean;
  /** True briefly after this skill was created/imported — row flashes to guide the eye. */
  highlighted: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className={`sk-row${highlighted ? ' sk-row--highlight' : ''}`} data-testid={`skill-row-${skill.id}`}>
      <label className="sk-switch" title={skill.enabled ? 'on' : 'off'}>
        <input
          type="checkbox"
          data-testid={`skill-toggle-${skill.id}`}
          checked={skill.enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="sk-switch__track" />
      </label>

      {/* The card body IS the view/edit entry: one click opens the editor where
          details (file listing) and editing live together. The toggle switch
          and the action buttons sit OUTSIDE this div, so their clicks never
          bubble into an editor open. */}
      <div className="sk-row__body" onClick={() => { if (!fetching) onEdit(); }}>
        <div className="sk-row__header">
          <span className="sk-row__name">{skill.name}</span>
        </div>
        {skill.description && <div className="sk-row__desc">{skill.description}</div>}
      </div>

      <div className="sk-row__actions">
        <button className="rt-btn rt-btn--sm rt-btn--ghost" data-testid={`skill-duplicate-${skill.id}`} onClick={onDuplicate} disabled={fetching}>
          {t('skills.duplicate')}
        </button>
        <button className="rt-btn rt-btn--sm rt-btn--ghost" data-testid={`skill-edit-${skill.id}`} onClick={onEdit} disabled={fetching}>
          {t('skills.edit')}
        </button>
        {confirmingDelete ? (
          <>
            <button className="rt-btn rt-btn--sm rt-btn--danger" data-testid={`skill-delete-confirm-${skill.id}`} onClick={onDeleteConfirm}>
              {t('skills.delete')}?
            </button>
            <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={onDeleteCancel}>
              {t('skills.form.cancel')}
            </button>
          </>
        ) : (
          <button
            className="rt-btn rt-btn--sm rt-btn--ghost"
            data-testid={`skill-delete-${skill.id}`}
            onClick={onDeleteRequest}
          >
            {t('skills.delete')}
          </button>
        )}
      </div>
    </div>
  );
}

export function SkillsPanel() {
  const { t } = useI18n();
  const {
    skills, loading, error,
    refresh, createSkill, updateSkill, toggleSkill, deleteSkill, importSkill,
  } = useSkills();

  // Segmented view: '我的技能' (library) vs '技能商店' (skillhub.cn catalog).
  // Kept local to the panel — no route/NavRail change, and switching back to
  // 'mine' after an install shows the freshly refreshed library list.
  const [view, setView] = useState<'mine' | 'hub'>('mine');
  // The hub pane mounts LAZILY on first visit, then stays mounted (keep-alive):
  // library-only visits never fire the catalog requests, but once the store
  // has been opened its search/category/pagination state survives tab flips.
  const [hubVisited, setHubVisited] = useState(false);

  const [modal, setModal] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Row whose edit/duplicate content is loading — its action buttons stay
  // disabled and the editor only opens ONCE the content is ready, so it never
  // opens empty then overwrites what the user already typed.
  const [fetchingId, setFetchingId] = useState<string | null>(null);

  // Recently created/imported skill id — its row flashes for ~3s so the user
  // can locate the new entry in a long list. One timer, reset on every flash.
  const [recentlyAddedId, setRecentlyAddedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashRecentlyAdded = useCallback((id: string) => {
    setRecentlyAddedId(id);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setRecentlyAddedId(null), 3000);
  }, []);
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

  const enabledCount = skills.filter((s) => s.enabled).length;

  // Sequence guard for editor opens: the edit/duplicate content fetch is async
  // (fetchingId only disables the ONE row loading), so overlapping actions can
  // race — click Edit on A then Duplicate on B and the slower response used to
  // open the editor with the WRONG skill's content. Whichever open happened
  // LAST wins; stale responses are dropped. openNew bumps the counter too so a
  // pending fetch can't pop an editor over the fresh "new" form.
  const openSeqRef = useRef(0);

  // Single "新建技能" entry point: the editor itself distinguishes pasting a new
  // SKILL.md (create) from importing a local file / folder.
  const openNew = useCallback(() => {
    openSeqRef.current += 1; // any in-flight open-fetch is now stale
    setFormError(null);
    setFetchingId(null);
    setModal({ mode: 'new', skill: null });
  }, []);

  const openEdit = useCallback(async (skill: SkillManifestEntry) => {
    const seq = ++openSeqRef.current;
    setFormError(null);
    setFetchingId(skill.id);
    try {
      // Files fetch degrades to null on failure — the editor still opens for
      // editing; the folded listing just doesn't render.
      const [{ instructions }, files] = await Promise.all([
        api.getSkill(skill.id),
        api.listSkillFiles(skill.id).catch(() => null),
      ]);
      if (openSeqRef.current !== seq) return; // superseded by a newer open
      setModal({
        mode: 'edit',
        skill,
        initialValues: { name: skill.name, description: skill.description, instructions },
        files,
      });
    } catch (err) {
      if (openSeqRef.current !== seq) return;
      setFormError((err as Error).message);
    } finally {
      if (openSeqRef.current === seq) setFetchingId(null);
    }
  }, []);

  const openDuplicate = useCallback(async (skill: SkillManifestEntry) => {
    const seq = ++openSeqRef.current;
    setFormError(null);
    setFetchingId(skill.id);
    try {
      const { instructions } = await api.getSkill(skill.id);
      if (openSeqRef.current !== seq) return; // superseded by a newer open
      // No `files` here: a duplicate saves a regenerated single SKILL.md
      // (createSkill has no sourceDir), so listing the SOURCE's content dir
      // would promise companions the copy does not carry.
      setModal({
        mode: 'create',
        skill: null,
        initialValues: { name: `${skill.name} 副本`, description: skill.description, instructions },
      });
    } catch (err) {
      if (openSeqRef.current !== seq) return;
      setFormError((err as Error).message);
    } finally {
      if (openSeqRef.current === seq) setFetchingId(null);
    }
  }, []);

  const closeModal = useCallback(() => {
    setModal(null);
  }, []);

  const handleSave = useCallback(async (values: SkillFormValues) => {
    if (!modal) return;
    setBusy(true);
    setFormError(null);
    try {
      if (modal.mode === 'edit' && modal.skill) {
        await updateSkill(modal.skill.id, values);
      } else {
        const skill = await createSkill(values);
        flashRecentlyAdded(skill.id);
      }
      closeModal();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [modal, createSkill, updateSkill, flashRecentlyAdded, closeModal]);

  const handleImport = useCallback(async (req: ImportSkillRequest) => {
    setBusy(true);
    setFormError(null);
    try {
      const skill = await importSkill(req);
      flashRecentlyAdded(skill.id);
      closeModal();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [importSkill, flashRecentlyAdded, closeModal]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      await toggleSkill(id, enabled);
    } catch (err) {
      setFormError((err as Error).message);
    }
  }, [toggleSkill]);

  const handleDeleteConfirm = useCallback(async (id: string) => {
    setConfirmDeleteId(null);
    try {
      await deleteSkill(id);
    } catch (err) {
      setFormError((err as Error).message);
    }
  }, [deleteSkill]);

  return (
    <div className="sk-shell">
      <div className="sk-header">
        <div className="sk-header__left">
          <h1 className="sk-header__title">{t('skills.title')}</h1>
          <span className="sk-header__subtitle">
            {t('skills.subtitle', { count: String(skills.length), enabled: String(enabledCount) })}
          </span>
        </div>
        <div className="sk-header__actions">
          {view === 'mine' && (
            <button className="rt-btn" data-testid="skill-new-btn" onClick={openNew}>
              {t('skills.new')}
            </button>
          )}
        </div>
      </div>

      <div className="sk-seg">
        <button
          className={`sk-seg__item${view === 'mine' ? ' sk-seg__item--active' : ''}`}
          data-testid="skills-view-mine"
          onClick={() => setView('mine')}
        >
          {t('skills.viewMine')}
        </button>
        <button
          className={`sk-seg__item${view === 'hub' ? ' sk-seg__item--active' : ''}`}
          data-testid="skills-view-hub"
          onClick={() => { setHubVisited(true); setView('hub'); }}
        >
          {t('skills.viewHub')}
        </button>
      </div>

      {/* Once visited, the hub pane stays mounted; the inactive pane is hidden
          with CSS. Unmounting SkillHubPanel on every tab flip would lose its
          search keyword / category / pagination state and refetch the catalog. */}
      <div data-testid="skills-pane-mine" className={`sk-content${view === 'hub' ? ' sk-content--hidden' : ''}`}>
          {error && (
            <div className="rt-error">
              <span>{error}</span>
              <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={refresh}>{t('skills.retry')}</button>
            </div>
          )}
          {formError && (
            <div className="rt-error">
              <span>{formError}</span>
            </div>
          )}

          {loading ? (
            <div className="rt-loading">{t('skills.loading')}</div>
          ) : skills.length === 0 ? (
            <div className="rt-empty">
              <div className="rt-empty__icon">🧩</div>
              <div className="rt-empty__text">{t('skills.empty')}</div>
              <div className="rt-empty__hint">{t('skills.emptyHint')}</div>
            </div>
          ) : (
            <div className="sk-list">
              {skills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  confirmingDelete={confirmDeleteId === skill.id}
                  fetching={fetchingId === skill.id}
                  highlighted={recentlyAddedId === skill.id}
                  onToggle={(enabled) => handleToggle(skill.id, enabled)}
                  onEdit={() => openEdit(skill)}
                  onDuplicate={() => openDuplicate(skill)}
                  onDeleteRequest={() => setConfirmDeleteId(skill.id)}
                  onDeleteConfirm={() => handleDeleteConfirm(skill.id)}
                  onDeleteCancel={() => setConfirmDeleteId(null)}
                />
              ))}
            </div>
          )}

          <p className="sk-note">{t('skills.runtimeNote')}</p>
      </div>

      {hubVisited && (
        <div data-testid="skills-pane-hub" className={`sk-content${view === 'mine' ? ' sk-content--hidden' : ''}`}>
          <SkillHubPanel onInstalled={() => refresh()} />
        </div>
      )}

      <SkillEditor
        show={modal !== null}
        mode={modal?.mode ?? 'create'}
        skill={modal?.skill}
        initialValues={modal?.initialValues}
        busy={busy}
        externalError={formError}
        files={modal?.files}
        onClose={closeModal}
        onSave={handleSave}
        onImport={handleImport}
      />
    </div>
  );
}
