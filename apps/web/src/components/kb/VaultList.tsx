/**
 * Left-side vault list panel — Obsidian-style.
 */

import { useState, useCallback } from 'react';
import type { Vault } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { authStore } from '../../stores/authStore';
import { loginIntentStore } from '../../stores/loginIntentStore';
import { ConfirmDialog } from './KbModals';
import { PublishWizard } from '../resources/PublishWizard';

interface VaultListProps {
  vaults: Vault[];
  activeVaultId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

export function VaultList({ vaults, activeVaultId, onSelect, onDelete }: VaultListProps) {
  const [deleteTarget, setDeleteTarget] = useState<Vault | null>(null);
  const [publishTarget, setPublishTarget] = useState<Vault | null>(null);
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

  // 发布到资源库：要求登录；未登录挂起登录意图，登录成功后续接打开发布向导
  const handlePublish = useCallback((e: React.MouseEvent, vault: Vault) => {
    e.stopPropagation();
    const status = authStore.getStatus();
    if (status && status.loggedIn) {
      setPublishTarget(vault);
      return;
    }
    loginIntentStore.requestLogin(() => setPublishTarget(vault));
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
              className="vm-vault-publish"
              onClick={(e) => handlePublish(e, vault)}
              title={t('vault.publish')}
              aria-label={t('vault.publish')}
            >
              📤
            </button>
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

      {publishTarget && (
        <PublishWizard
          vaultId={publishTarget.id}
          vaultName={publishTarget.name}
          onClose={() => setPublishTarget(null)}
          onPublished={() => {
            /* 资源页目录有 60s 缓存，下次进入可见更新，此处不主动刷新 */
          }}
        />
      )}
    </aside>
  );
}
