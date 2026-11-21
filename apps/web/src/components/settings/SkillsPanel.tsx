import { useState, useCallback, useRef, useEffect } from 'react';
import { PuzzleIcon, ChevronIcon } from '../icons';
import type { SkillManifestEntry, ImportSkillRequest, SkillQuarantineEvent } from '@molio/contracts';
import { useSkills } from '../../hooks/useSkills';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';
import { SkillEditor, type SkillFormMode, type SkillFormValues } from './SkillEditor';
import { SkillCustomInstructionsModal } from './SkillCustomInstructionsModal';
import { SkillHubPanel } from './SkillHubPanel';
import { groupQuarantineEvents } from './quarantineGrouping';

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
  onCustom,
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
  /** Open the custom-instructions (overlay) editor — update-proof customization. */
  onCustom: () => void;
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
          {skill.customInstructions && (
            <span className="rt-badge" data-testid={`skill-custom-badge-${skill.id}`}>{t('skills.customBadge')}</span>
          )}
        </div>
        {skill.description && <div className="sk-row__desc">{skill.description}</div>}
      </div>

      <div className="sk-row__actions">
        <button className="rt-btn rt-btn--sm rt-btn--ghost" data-testid={`skill-custom-${skill.id}`} onClick={onCustom} disabled={fetching}>
          {t('skills.customEdit')}
        </button>
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

/**
 * One bundled-skill row: compact read-only line + a QUIET 「自定义指令」 text
 * entry. Bundled skills are app-owned and just work; the overlay channel is
 * deliberately demoted (collapsed section, text-level entry) — it exists for
 * the "I truly need to tailor this" moment, not as an invitation to tinker
 * with skills on the KB hot path.
 */
function BundledSkillRow({
  skill,
  onCustom,
}: {
  skill: SkillManifestEntry;
  onCustom: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="sk-row sk-bundled__row" data-testid={`bundled-skill-row-${skill.id}`}>
      <div className="sk-row__body">
        <div className="sk-row__header">
          <span className="sk-row__name">{skill.name}</span>
          {skill.customInstructions && (
            <span className="rt-badge" data-testid={`bundled-skill-badge-${skill.id}`}>{t('skills.customBadge')}</span>
          )}
        </div>
        {skill.description && <div className="sk-row__desc">{skill.description}</div>}
      </div>
      <div className="sk-row__actions">
        <button
          className="sk-bundled__edit"
          data-testid={`bundled-skill-edit-${skill.id}`}
          onClick={onCustom}
        >
          {t('skills.customEdit')}
        </button>
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

  // Bundled (app-shipped) skills: separate section under the library list.
  // Loaded independently of useSkills (which is library-only by design);
  // reloaded after every overlay save so badges stay in sync.
  const [bundledSkills, setBundledSkills] = useState<SkillManifestEntry[]>([]);
  const refreshBundled = useCallback(() => {
    api
      .listSkills({ includeBundled: true })
      .then((list) => setBundledSkills(list.filter((s) => s.kind === 'bundled')))
      .catch(() => setBundledSkills([])); // section simply stays empty on failure
  }, []);
  useEffect(() => {
    refreshBundled();
  }, [refreshBundled]);

  // Bundled skills are system facts, not something users manage — the section
  // stays COLLAPSED by default so the page doesn't advertise tinkering with
  // skills on the KB hot path. Expanded state persists: a user who opened it
  // is mid-task and shouldn't have to re-expand after a tab switch.
  const [bundledOpen, setBundledOpen] = useState(() => {
    try {
      return localStorage.getItem('molio.skillsBundledOpen') === '1';
    } catch {
      return false; // storage unavailable (private mode) → collapsed default
    }
  });
  const toggleBundled = useCallback(() => {
    setBundledOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem('molio.skillsBundledOpen', next ? '1' : '0');
      } catch {
        /* persistence is best-effort; the toggle still works this session */
      }
      return next;
    });
  }, []);
  // The customized count is the one state worth surfacing while collapsed:
  // it tells the user their overlays are still there without expanding.
  const customizedCount = bundledSkills.filter((s) => s.customInstructions).length;

  // Overlay editor target (bundled OR library skill).
  const [customTarget, setCustomTarget] = useState<SkillManifestEntry | null>(null);

  // Safety-net banner: unacked quarantine events. Loaded on mount AND after
  // every panel mutation — each mutation's endpoint awaits the vault
  // reconcile, so by the time it returns any new events are already in the
  // ledger and a re-fetch surfaces them in place (no remount needed).
  const [quarantine, setQuarantine] = useState<SkillQuarantineEvent[]>([]);
  const refreshQuarantine = useCallback(() => {
    api.listSkillQuarantine().then((r) => setQuarantine(r.events)).catch(() => setQuarantine([]));
  }, []);
  useEffect(() => {
    refreshQuarantine();
  }, [refreshQuarantine]);
  const ackQuarantine = useCallback(
    async (id: number) => {
      setQuarantine((prev) => prev.filter((e) => e.id !== id));
      try {
        await api.ackSkillQuarantine(id);
      } catch {
        refreshQuarantine(); // restore on failure — the event is still unacked
      }
    },
    [refreshQuarantine],
  );
  const ackColdStartAll = useCallback(() => {
    for (const ev of quarantine.filter((e) => e.source === 'vault-cold-start')) {
      void api.ackSkillQuarantine(ev.id).catch(() => {});
    }
    setQuarantine((prev) => prev.filter((e) => e.source !== 'vault-cold-start'));
  }, [quarantine]);

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
      refreshQuarantine(); // the mutation's reconcile may have ledgered events
      closeModal();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [modal, createSkill, updateSkill, flashRecentlyAdded, closeModal, refreshQuarantine]);

  const handleImport = useCallback(async (req: ImportSkillRequest) => {
    setBusy(true);
    setFormError(null);
    try {
      const skill = await importSkill(req);
      flashRecentlyAdded(skill.id);
      refreshQuarantine(); // the import's reconcile may have ledgered events
      closeModal();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [importSkill, flashRecentlyAdded, closeModal, refreshQuarantine]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    try {
      await toggleSkill(id, enabled);
      refreshQuarantine(); // disable/enable re-syncs vaults (orphan sweeps)
    } catch (err) {
      setFormError((err as Error).message);
    }
  }, [toggleSkill, refreshQuarantine]);

  const handleDeleteConfirm = useCallback(async (id: string) => {
    setConfirmDeleteId(null);
    try {
      await deleteSkill(id);
      refreshQuarantine(); // removal re-syncs vaults (orphan sweeps)
    } catch (err) {
      setFormError((err as Error).message);
    }
  }, [deleteSkill, refreshQuarantine]);

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

      {/* Safety-net banner: cold-start events collapse into ONE aggregated
          entry (they can fire per-skill on the first sync after an upgrade);
          every other source is a specific occurrence with its own ack. */}
      {quarantine.length > 0 && (
        <div className="sk-quarantine" data-testid="skill-quarantine-banner">
          {(() => {
            const { coldStart, individual } = groupQuarantineEvents(quarantine);
            return (
              <>
                {coldStart.length > 0 && (
                  <div className="sk-quarantine__row" data-testid="skill-quarantine-coldstart">
                    <span>
                      升级后首次同步：{coldStart.length} 个技能的本地副本与官方版本有差异，差异备份已存于{' '}
                      <code>~/.molio/skill-quarantine/</code>。差异也可能来自版本更新本身；若你改过它们，可从备份找回并整理进「自定义指令」。
                    </span>
                    <button
                      className="rt-btn rt-btn--sm rt-btn--ghost"
                      data-testid="skill-quarantine-ack-coldstart"
                      onClick={ackColdStartAll}
                    >
                     知道了
                    </button>
                  </div>
                )}
                {individual.map((ev) => (
                  <div className="sk-quarantine__row" key={ev.id}>
                    <span>{ev.description}</span>
                    <button
                      className="rt-btn rt-btn--sm rt-btn--ghost"
                      data-testid={`skill-quarantine-ack-${ev.id}`}
                      onClick={() => ackQuarantine(ev.id)}
                    >
                     知道了
                    </button>
                  </div>
                ))}
              </>
            );
          })()}
        </div>
      )}

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
              <div className="rt-empty__icon"><PuzzleIcon size={44} /></div>
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
                  onCustom={() => setCustomTarget(skill)}
                  onDeleteRequest={() => setConfirmDeleteId(skill.id)}
                  onDeleteConfirm={() => handleDeleteConfirm(skill.id)}
                  onDeleteCancel={() => setConfirmDeleteId(null)}
                />
              ))}
            </div>
          )}

          {/* Built-in skills: app-owned, always-on; customization rides on the
              overlay (自定义指令) — the only sanctioned edit channel, survives
              every app update. Collapsed by default; the summary keeps the
              customized count visible so overlays stay discoverable without
              advertising the edit channel. */}
          {bundledSkills.length > 0 && (
            <div data-testid="skills-pane-bundled" className={`sk-bundled${bundledOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className="sk-bundled__toggle"
                data-testid="skills-bundled-toggle"
                aria-expanded={bundledOpen}
                aria-controls="skills-bundled-list"
                onClick={toggleBundled}
              >
                <ChevronIcon size={14} className="sk-bundled__chevron" />
                <span className="sk-bundled__title">{t('skills.bundledTitle')}</span>
                <span className="sk-bundled__summary">
                  {t('skills.bundledCount', { count: bundledSkills.length })}
                  {customizedCount > 0 &&
                    t('skills.bundledCustomized', { count: customizedCount })}
                </span>
              </button>
              {bundledOpen && (
                <div id="skills-bundled-list" className="sk-bundled__body">
                  <p className="sk-bundled__hint">{t('skills.bundledHint')}</p>
                  <div className="sk-list">
                    {bundledSkills.map((skill) => (
                      <BundledSkillRow
                        key={skill.id}
                        skill={skill}
                        onCustom={() => setCustomTarget(skill)}
                      />
                    ))}
                  </div>
                </div>
              )}
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

      <SkillCustomInstructionsModal
        show={customTarget !== null}
        skill={customTarget}
        onClose={() => setCustomTarget(null)}
        onSaved={() => {
          refreshBundled();
          refresh(); // library rows' badges + hub-installed entries
          refreshQuarantine(); // the PATCH's reconcile may have ledgered drift events
        }}
      />
    </div>
  );
}
