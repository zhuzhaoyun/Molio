import type { RunStatus } from '@kge/contracts';

interface Props {
  status: RunStatus;
}

const STATUS_STYLES: Record<RunStatus, { label: string; className: string }> = {
  pending: { label: 'Idle', className: 'badge-idle' },
  running: { label: 'Running', className: 'badge-running' },
  succeeded: { label: 'Done', className: 'badge-success' },
  failed: { label: 'Failed', className: 'badge-error' },
  canceled: { label: 'Canceled', className: 'badge-idle' },
};

export function StatusBadge({ status }: Props) {
  const { label, className } = STATUS_STYLES[status];
  return (
    <span className={`badge ${className}`}>
      {status === 'running' && <span className="pulse" />}
      {label}
    </span>
  );
}
