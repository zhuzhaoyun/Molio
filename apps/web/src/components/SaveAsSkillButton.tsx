import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '../api/client';
import { skillPrefillStore } from '../stores/skillPrefillStore';
import { useI18n } from '../i18n';
import { SparkleIcon, CheckIcon } from './icons';

interface Props {
  /** Raw markdown content of the assistant message to distill into a skill. */
  content: string;
}

/**
 * "Save this reply as a skill" button (mirrors SaveToKbButton).
 *
 * Kicks off a one-shot daemon AI call (`/api/skills/prefill`) that distills the
 * assistant reply into {name, description, instructions}. The result is pushed
 * to skillPrefillStore; App.tsx subscribes and renders the confirmation modal.
 * The daemon endpoint always resolves (it sets `fallback: true` on any failure),
 * so the modal opens even when Claude isn't installed — the raw reply lands in
 * the instructions field for the user to edit.
 */
export function SaveAsSkillButton({ content }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleClick = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      const prefill = await api.prefillSkill(content);
      skillPrefillStore.setPendingPrefill(prefill);
    } catch {
      // Endpoint is designed to always resolve, but guard anyway: open the
      // modal with the raw reply so the user can still hand-author the skill.
      skillPrefillStore.setPendingPrefill({
        name: '未命名技能',
        description: '',
        instructions: content,
        fallback: true,
      });
    } finally {
      setLoading(false);
      setOpened(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setOpened(false), 2000);
    }
  }, [loading, content]);

  const tip = loading
    ? t('skills.saveAsSkill.loading')
    : t('skills.saveAsSkill');

  return (
    <button
      type="button"
      className={`icon-btn${opened ? ' copied' : ''}`}
      data-tip={tip}
      data-testid="msg-save-skill-btn"
      onClick={handleClick}
      disabled={loading}
      aria-label={tip}
    >
      {opened ? <CheckIcon size={15} /> : <SparkleIcon size={15} />}
    </button>
  );
}
