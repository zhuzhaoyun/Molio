/**
 * Obsidian-style Vault Manager — modal overlay.
 *
 * A full-screen modal that covers the entire page.
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

interface VaultManagerModalProps {
  show: boolean;
  vaults: Vault[];
  activeVaultId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: (name: string, path: string, description?: string) => Promise<void>;
  onOpen: (path: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function VaultManagerModal({
  show,
  vaults,
  activeVaultId,
  onClose,
  onSelect,
  onCreate,
  onOpen,
  onDelete,
}: VaultManagerModalProps) {
  const [view, setView] = useState<VaultManagerView>('list');
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(
    async (name: string, path: string, description?: string) => {
      setCreating(true);
      try {
        await onCreate(name, path, description);
        setView('list');
      } finally {
        setCreating(false);
      }
    },
    [onCreate]
  );

  const handleBackToList = useCallback(() => setView('list'), []);

  const handleSelect = useCallback(
    (id: string) => {
      setView('list');
      onSelect(id);
    },
    [onSelect]
  );

  console.log('VaultManagerModal render, show =', show);

  if (!show) return null;

  return (
    <div className="vm-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vm-modal">
        {/* Left: Vault List */}
        <div className="vm-modal-left">
          <VaultList
            vaults={vaults}
            activeVaultId={activeVaultId}
            onSelect={handleSelect}
            onDelete={onDelete}
          />
        </div>

        {/* Right: Action Panel or Create Form */}
        <div className="vm-modal-right">
          {view === 'list' ? (
            <VaultActionPanel
              onCreate={() => setView('create')}
              onOpenLocal={async () => {
                let pickedPath: string | null = null;

                // 1. Try Electron's native directory picker (desktop app)
                if (window.__electron__?.showDirectoryPicker) {
                  try {
                    pickedPath = await window.__electron__.showDirectoryPicker();
                  } catch { /* user cancelled */ }
                }

                // 2. Try browser's File System Access API (web)
                if (!pickedPath && 'showDirectoryPicker' in window) {
                  try {
                    // @ts-expect-error - File System Access API
                    const dirHandle = await window.showDirectoryPicker();
                    pickedPath = dirHandle.name;
                  } catch { /* user cancelled or not supported */ }
                }

                // 3. Fall back to manual path input
                if (!pickedPath) {
                  pickedPath = window.prompt('请输入本地文件夹路径：');
                }

                if (pickedPath) {
                  await onOpen(pickedPath);
                  setView('list');
                }
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
    </div>
  );
}
