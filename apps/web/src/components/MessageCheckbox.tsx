import { useIsSelected, messageSelectionStore } from '../stores/messageSelectionStore';
import { CheckIcon } from './icons';

interface Props {
  id: string;
}

/**
 * Checkbox badge shown on each bubble in selection mode. Per-bubble selector
 * so toggling one bubble only re-renders that bubble.
 */
export function MessageCheckbox({ id }: Props) {
  const selected = useIsSelected(id);
  return (
    <button
      type="button"
      className={`msg-checkbox${selected ? ' checked' : ''}`}
      data-testid="msg-checkbox"
      data-msg-id={id}
      onClick={(e) => { e.stopPropagation(); messageSelectionStore.toggle(id); }}
      aria-pressed={selected}
      aria-label={selected ? '取消选择' : '选择'}
    >
      {selected && <CheckIcon size={12} />}
    </button>
  );
}
