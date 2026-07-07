import { useSelectedCount } from '../stores/messageSelectionStore';

interface Props {
  onDelete: () => void;
  onCancel: () => void;
}

/**
 * Top floating bar shown in selection mode. Delete disabled when nothing is
 * selected (user can still cancel out).
 */
export function SelectionConfirmBar({ onDelete, onCancel }: Props) {
  const count = useSelectedCount();
  return (
    <div className="selection-confirm-bar" data-testid="selection-confirm-bar">
      <span className="selection-count">已选 {count} 条</span>
      <div className="selection-actions">
        <button
          type="button"
          className="selection-cancel"
          data-testid="selection-cancel-btn"
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="selection-delete"
          data-testid="selection-delete-btn"
          onClick={onDelete}
          disabled={count === 0}
        >
          删除
        </button>
      </div>
    </div>
  );
}
