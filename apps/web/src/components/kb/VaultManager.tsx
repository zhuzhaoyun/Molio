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

export type VaultManagerView = 'list' | 'create' | 'open';

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

        {/* Right: Action Panel / Create Form / Open Form */}
        <div className="vm-modal-right">
          {view === 'list' ? (
            <VaultActionPanel
              onCreate={() => setView('create')}
              onOpenLocal={async () => {
                // Electron: use native directory picker
                if (window.__electron__?.showDirectoryPicker) {
                  try {
                    const pickedPath = await window.__electron__.showDirectoryPicker();
                    if (pickedPath) {
                      await onOpen(pickedPath);
                      setView('list');
                    }
                  } catch { /* user cancelled */ }
                  return;
                }

                // Browser: show inline path input form
                setView('open');
              }}
            />
          ) : view === 'create' ? (
            <CreateVaultForm
              onCreate={handleCreate}
              onCancel={handleBackToList}
              isLoading={creating}
            />
          ) : (
            <OpenVaultForm
              onOpen={async (path: string) => {
                setCreating(true);
                try {
                  await onOpen(path);
                  setView('list');
                } finally {
                  setCreating(false);
                }
              }}
              onCancel={handleBackToList}
              isLoading={creating}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Open local vault form — inline path input for browser environments.
 */
function OpenVaultForm({
  onOpen,
  onCancel,
  isLoading,
}: {
  onOpen: (path: string) => Promise<void>;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const [vaultPath, setVaultPath] = useState('');

  const handleSubmit = useCallback(async () => {
    if (!vaultPath.trim()) return;
    await onOpen(vaultPath.trim());
  }, [vaultPath, onOpen]);

  const canSubmit = vaultPath.trim() && !isLoading;

  return (
    <div className="vm-create-form">
      <button className="vm-back-btn" onClick={onCancel}>
        ← 返回
      </button>
      <h2 className="vm-create-title">打开本地仓库</h2>

      <div className="vm-form-group">
        <label className="vm-form-label">文件夹路径</label>
        <input
          className="vm-form-input"
          type="text"
          placeholder="D:\work\my-vault"
          value={vaultPath}
          onChange={(e) => setVaultPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleSubmit()}
          autoFocus
        />
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          输入本地文件夹的完整路径，将该文件夹作为知识库打开
        </p>
      </div>

      <div className="vm-form-actions">
        <button className="vm-submit-btn" onClick={handleSubmit} disabled={!canSubmit}>
          {isLoading ? '打开中...' : '打开'}
        </button>
      </div>
    </div>
  );
}
