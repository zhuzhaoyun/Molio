import { useEffect, useRef, useState } from 'react';
import type { SkillManifestEntry } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';

/**
 * Custom-instructions (overlay) editor — the sanctioned edit channel for
 * BUNDLED skills (and an update-proof customization slot for library/hub
 * skills). Shows the read-only base body and a textarea whose content is
 * appended to the synced SKILL.md inside a sentinel block; app updates and
 * hub refreshes swap the base while the overlay rides along untouched.
 * Dialog classes reuse the kb-overlay/kb-modal family (cross-page precedent:
 * account panels), form fields reuse settings.css sk-field.
 */
export function SkillCustomInstructionsModal({
  show,
  skill,
  onClose,
  onSaved,
}: {
  show: boolean;
  skill: SkillManifestEntry | null;
  onClose: () => void;
  /** Called after a successful save/clear so the caller can refresh its list. */
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [base, setBase] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const seqRef = useRef(0);

  // Load the current base + overlay whenever the editor opens for a skill.
  useEffect(() => {
    if (!show || !skill) return;
    const seq = ++seqRef.current;
    setBase('');
    setText('');
    setError(null);
    api
      .getSkill(skill.id)
      .then((detail) => {
        if (seqRef.current !== seq) return;
        setBase(detail.instructions ?? '');
        setText(detail.skill.customInstructions ?? '');
      })
      .catch((err: Error) => {
        if (seqRef.current !== seq) return;
        setError(err.message);
      });
  }, [show, skill]);

  // Esc closes (unless busy — a save in flight must not be discarded by a stray key).
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, busy, onClose]);

  if (!show || !skill) return null;

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateSkillCustomInstructions(skill.id, value);
      setText(value);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kb-overlay show" data-testid="custom-instructions-overlay" role="dialog" aria-modal="true">
      <div className="kb-modal">
        <div className="kb-modal-header">
          <h2>
            {t('skills.ci.title')} · {skill.name}
          </h2>
          <button className="kb-modal-close" onClick={onClose} disabled={busy} aria-label="close">✕</button>
        </div>
        <div className="kb-modal-body">
          <p className="sk-note" style={{ marginTop: 0 }}>{t('skills.ci.subtitle')}</p>
          {error && <div className="rt-error"><span>{error}</span></div>}

          <div className="sk-field">
            <label className="sk-field__label">{t('skills.ci.baseLabel')}</label>
            {/* Read-only upstream body — scrollable so long skills don't flood the dialog. */}
            <pre
              data-testid="custom-instructions-base"
              style={{ overflow: 'auto', maxHeight: '26vh', margin: 0, whiteSpace: 'pre-wrap' }}
              className="sk-field__textarea sk-field__textarea--code"
            >{base || '…'}</pre>
          </div>

          <div className="sk-field sk-field--grow">
            <textarea
              className="sk-field__textarea sk-field__textarea--md"
              data-testid="custom-instructions-textarea"
              placeholder={t('skills.ci.placeholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        <div className="kb-modal-footer">
          {savedFlash && <span data-testid="custom-instructions-saved" style={{ alignSelf: 'center', marginRight: 'auto' }}>{t('skills.ci.saved')}</span>}
          <button
            className="rt-btn rt-btn--sm rt-btn--ghost"
            data-testid="custom-instructions-clear"
            onClick={() => save('')}
            disabled={busy || text === ''}
          >
            {t('skills.ci.clear')}
          </button>
          <button className="rt-btn rt-btn--sm rt-btn--ghost" onClick={onClose} disabled={busy}>
            {t('skills.ci.cancel')}
          </button>
          <button
            className="rt-btn rt-btn--sm"
            data-testid="custom-instructions-save"
            onClick={() => save(text)}
            disabled={busy}
          >
            {t('skills.ci.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
