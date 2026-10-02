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
import { ConfirmDialog } from './KbModals';

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
  const [openError, setOpenError] = useState<string | null>(null);

  /**
   * Both "open" entry points (native picker + browser form) funnel here so a
   * daemon rejection surfaces in ONE place.
   *
   * Regression (2026-09): the Electron branch's cancel-handling catch also
   * wrapped the `onOpen` call, so a rejected path (e.g. a dot-directory like
   * `.claude`) was reported as "user cancelled" — silent no-op; and the browser
   * form awaited `onOpen` with no catch at all (unhandled rejection, no UI).
   * 「创建仓库」 always showed a message (CreateVaultForm catches), which is why
   * only the open path looked broken.
   */
  const handleOpen = useCallback(
    async (path: string) => {
      setCreating(true);
      try {
        await onOpen(path);
        setView('list');
      } catch (err) {
        setOpenError(err instanceof Error ? err.message : '打开仓库失败');
      } finally {
        setCreating(false);
      }
    },
    [onOpen]
  );

  /** Native picker (Electron) or the inline path form (browser). */
  const handlePickLocal = useCallback(async () => {
    if (!window.__electron__?.showDirectoryPicker) {
      // Browser: show inline path input form
      setView('open');
      return;
    }
    let pickedPath: string | null = null;
    try {
      pickedPath = await window.__electron__.showDirectoryPicker();
    } catch {
      return; // picker dismissed or failed — nothing to report to the user
    }
    if (pickedPath) await handleOpen(pickedPath);
  }, [handleOpen]);

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
              onOpenLocal={handlePickLocal}
            />
          ) : view === 'create' ? (
            <CreateVaultForm
              onCreate={handleCreate}
              onCancel={handleBackToList}
              isLoading={creating}
            />
          ) : (
            <OpenVaultForm
              onOpen={handleOpen}
              onCancel={handleBackToList}
              isLoading={creating}
            />
          )}
        </div>
      </div>

      {/* Sits outside the modal box but inside the overlay so it stacks above it. */}
      <ConfirmDialog
        show={!!openError}
        title="无法打开仓库"
        message={openError ?? ''}
        confirmLabel="知道了"
        hideCancel
        onConfirm={() => setOpenError(null)}
        onCancel={() => setOpenError(null)}
      />
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
