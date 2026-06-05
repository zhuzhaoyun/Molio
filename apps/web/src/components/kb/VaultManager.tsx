/**
 * Obsidian-style Vault Manager.
 *
 * Left side: list of existing vaults.
 * Right side: branding + actions (Create / Open local vault).
 *
 * State machine:
 *   'list'    → show vault list + action panel
 *   'create'  → show create vault form
 */

import { useState, useCallback } from 'react';
import type { Vault } from '@molio/contracts';
import { VaultList } from './VaultList';
import { VaultActionPanel } from './VaultActionPanel';
import { CreateVaultForm } from './CreateVaultForm';

export type VaultManagerView = 'list' | 'create';

interface VaultManagerProps {
  vaults: Vault[];
  activeVaultId: string | null;
  onSelectVault: (id: string) => void;
  onCreateVault: (name: string, path: string, description?: string) => Promise<void>;
  onDeleteVault: (id: string) => Promise<void>;
}

export function VaultManager({
  vaults,
  activeVaultId,
  onSelectVault,
  onCreateVault,
  onDeleteVault,
}: VaultManagerProps) {
  const [view, setView] = useState<VaultManagerView>('list');
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(
    async (name: string, path: string, description?: string) => {
      setCreating(true);
      try {
        await onCreateVault(name, path, description);
        setView('list');
      } finally {
        setCreating(false);
      }
    },
    [onCreateVault]
  );

  const handleBackToList = useCallback(() => setView('list'), []);

  // Wrap onSelectVault to reset view before selecting a vault
  const handleSelectVault = useCallback(
    (id: string) => {
      setView('list');
      onSelectVault(id);
    },
    [onSelectVault]
  );

  return (
    <div className="vm-shell">
      {/* Left: Vault List */}
      <VaultList
        vaults={vaults}
        activeVaultId={activeVaultId}
        onSelect={handleSelectVault}
        onDelete={onDeleteVault}
      />

      {/* Right: Action Panel or Create Form */}
      <div className="vm-panel">
        {view === 'list' ? (
          <VaultActionPanel
            onCreate={() => setView('create')}
            onOpenLocal={() => {
              /* TODO: open local folder dialog */
            }}
          />
        ) : (
          <CreateVaultForm
            onCreate={handleCreate}
            onCancel={handleBackToList}
            isLoading={creating}
          />
        )}
      </div>
    </div>
  );
}
