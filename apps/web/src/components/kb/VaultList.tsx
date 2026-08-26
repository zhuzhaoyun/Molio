/**
 * Left-side vault list panel — Obsidian-style.
 */

import { useState, useCallback } from 'react';
import type { Vault } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { ConfirmDialog } from './KbModals';

interface VaultListProps {
  vaults: Vault[];
  activeVaultId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

export function VaultList({ vaults, activeVaultId, onSelect, onDelete }: VaultListProps) {
  const [deleteTarget, setDeleteTarget] = useState<Vault | null>(null);
  const { t } = useI18n();

  const handleDelete = useCallback((e: React.MouseEvent, vault: Vault) => {
    e.stopPropagation();
    setDeleteTarget(vault);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    await onDelete(id);
  }, [deleteTarget, onDelete]);

  const handleCancelDelete = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  return (
    <aside className="vm-list">
      <div className="vm-list-header">知识库仓库</div>
      <div className="vm-list-body">
        {vaults.length === 0 && (
          <div className="vm-list-empty">
            <div>📂</div>
            <p>还没有仓库</p>
          </div>
        )}
        {vaults.map((vault) => (
          <div
            key={vault.id}
            className={`vm-vault-item ${vault.id === activeVaultId ? 'is-active' : ''}`}
            onClick={() => onSelect(vault.id)}
          >
            <div className="vm-vault-name">{vault.name}</div>
            <div className="vm-vault-path">{vault.path}</div>
            <button
              className="vm-vault-delete"
              onClick={(e) => handleDelete(e, vault)}
              title="Remove from app"
            >
              ⋯
            </button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        show={!!deleteTarget}
        title="删除仓库"
        message={deleteTarget ? `确定删除仓库 "${deleteTarget.name}"？这只会从应用中移除，不会删除本地文件。` : ''}
        confirmLabel="删除"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />

    </aside>
  );
}
