import { useState, useCallback } from 'react';
import type { SkillManifestEntry, ImportSkillRequest } from '@molio/contracts';
import { useSkills } from '../../hooks/useSkills';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';
import { SkillFormModal, type SkillFormMode, type SkillFormValues } from './SkillFormModal';

interface ModalState {
  mode: SkillFormMode;
  skill: SkillManifestEntry | null;
}

/** A single skill row: name/description, built-in badge, toggle, edit, delete. */
function SkillRow({
  skill,
  confirmingDelete,
  onToggle,
  onEdit,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  skill: SkillManifestEntry;
  confirmingDelete: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="sk-row" data-testid={`skill-row-${skill.id}`}>
      <label className="sk-switch" title={skill.enabled ? 'on' : 'off'}>
        <input
          type="checkbox"
          data-testid={`skill-toggle-${skill.id}`}
          checked={skill.enabled}
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
        </div>
        {skill.description && <div className="sk-row__desc">{skill.description}</div>}
      </div>

      <div className="sk-row__actions">
        {skill.kind !== 'bundled' && (
          <button className="rt-btn rt-btn--sm rt-btn--ghost" data-testid={`skill-edit-${skill.id}`} onClick={onEdit}>
            {t('skills.edit')}
          </button>
        )}
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
            disabled={skill.builtIn}
            title={skill.builtIn ? t('skills.deleteConfirm', { name: skill.name }) : undefined}
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

  const [modal, setModal] = useState<ModalState | null>(null);
  const [editInstructions, setEditInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const enabledCount = skills.filter((s) => s.enabled).length;

  const openCreate = useCallback(() => {
    setFormError(null);
    setModal({ mode: 'create', skill: null });
  }, []);

  const openImport = useCallback(() => {
    setFormError(null);
    setModal({ mode: 'import', skill: null });
  }, []);

  const openEdit = useCallback(async (skill: SkillManifestEntry) => {
    setFormError(null);
    setEditInstructions('');
    setModal({ mode: 'edit', skill });
    try {
      const { instructions } = await api.getSkill(skill.id);
      setEditInstructions(instructions);
    } catch (err) {
      setFormError((err as Error).message);
    }
  }, []);

  const closeModal = useCallback(() => {
    setModal(null);
    setEditInstructions('');
  }, []);

  const handleSave = useCallback(async (values: SkillFormValues) => {
    if (!modal) return;
    setBusy(true);
    setFormError(null);
    try {
      if (modal.mode === 'edit' && modal.skill) {
        await updateSkill(modal.skill.id, values);
      } else {
        await createSkill(values);
      }
      closeModal();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [modal, createSkill, updateSkill, closeModal]);

  const handleImport = useCallback(async (req: ImportSkillRequest) => {
    setBusy(true);
    setFormError(null);
    try {
      await importSkill(req);
      closeModal();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [importSkill, closeModal]);

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
          <button className="rt-btn rt-btn--ghost" data-testid="skill-import-btn" onClick={openImport}>
            {t('skills.import')}
          </button>
          <button className="rt-btn" data-testid="skill-new-btn" onClick={openCreate}>
            {t('skills.new')}
          </button>
        </div>
      </div>

      <div className="sk-content">
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
                onToggle={(enabled) => handleToggle(skill.id, enabled)}
                onEdit={() => openEdit(skill)}
                onDeleteRequest={() => setConfirmDeleteId(skill.id)}
                onDeleteConfirm={() => handleDeleteConfirm(skill.id)}
                onDeleteCancel={() => setConfirmDeleteId(null)}
              />
            ))}
          </div>
        )}

        <p className="sk-note">{t('skills.claudeOnlyNote')}</p>
      </div>

      <SkillFormModal
        show={modal !== null}
        mode={modal?.mode ?? 'create'}
        skill={modal?.skill}
        initialInstructions={modal?.mode === 'edit' ? editInstructions : undefined}
        busy={busy}
        onClose={closeModal}
        onSave={handleSave}
        onImport={handleImport}
      />
    </div>
  );
}
