/**
 * Left-side vault list panel — Obsidian-style.
 */

import type { Vault } from '@molio/contracts';

interface VaultListProps {
  vaults: Vault[];
  activeVaultId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

export function VaultList({ vaults, activeVaultId, onSelect, onDelete }: VaultListProps) {
  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm('Delete this vault? This only removes it from the app.')) {
      await onDelete(id);
    }
  };

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
              onClick={(e) => handleDelete(e, vault.id)}
              title="Remove from app"
            >
              ⋯
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
