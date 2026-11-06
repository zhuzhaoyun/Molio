/**
 * Left-side vault list panel — Obsidian-style.
 *
 * Row actions live behind the `⋯` trigger as a real MENU (the glyph means
 * "more options" everywhere else in this app — OverflowMenu, MessageToolbar —
 * so it must not jump straight to a destructive dialog). Regression (2026-09):
 * the trigger opened the delete confirmation directly, so users looking for
 * "options" got a scary dialog instead, and the hover-only reveal made the
 * control unreachable on touch devices.
 */

import { useCallback, useRef, useState } from 'react';
import type { Vault } from '@molio/contracts';
import { useI18n } from '../../i18n';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { ConfirmDialog } from './KbModals';
import { CopyIcon, FolderIcon, MoreIcon, TrashIcon } from '../icons';
import { isRevealAvailable, revealInFolder } from '../../utils/reveal';

interface VaultListProps {
  vaults: Vault[];
  activeVaultId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

/** Anchor a menu at the trigger's bottom-right corner. */
interface MenuAnchor {
  vault: Vault;
  x: number;
  y: number;
}

export function VaultList({ vaults, activeVaultId, onSelect, onDelete }: VaultListProps) {
  const [deleteTarget, setDeleteTarget] = useState<Vault | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [copyHint, setCopyHint] = useState(false);
  const copyHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useI18n();

  // Reveal needs the Electron bridge (window.__electron__.showItemInFolder);
  // the browser (dev / E2E / NAS remote) has no such API, so the item is not
  // rendered at all rather than shown-and-broken.
  const canReveal = isRevealAvailable();

  const openMenu = useCallback((e: React.MouseEvent, vault: Vault) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ vault, x: rect.right + 4, y: rect.bottom + 2 });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const copyVaultId = useCallback((vault: Vault) => {
    // navigator.clipboard is unavailable on insecure origins (plain-http NAS
    // access) — fall back to the legacy path so the action still works.
    const write = navigator.clipboard?.writeText(vault.id);
    if (write) {
      write.catch(() => {});
    } else {
      const el = document.createElement('textarea');
      el.value = vault.id;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopyHint(true);
    if (copyHintTimer.current) clearTimeout(copyHintTimer.current);
    copyHintTimer.current = setTimeout(() => setCopyHint(false), 1600);
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

  const menuItems = useCallback(
    (vault: Vault): MenuItem[] => [
      {
        label: t('vault.copyId'),
        testid: 'vault-menu-copy-id',
        icon: <CopyIcon size={15} />,
        onClick: () => copyVaultId(vault),
      },
      ...(canReveal
        ? [
            {
              label: t('vault.revealInFolder'),
              testid: 'vault-menu-reveal',
              icon: <FolderIcon size={15} />,
              onClick: () => revealInFolder(vault.path, vault.path),
            },
          ]
        : []),
      { divider: true },
      {
        label: t('vault.remove'),
        testid: 'vault-menu-remove',
        icon: <TrashIcon size={15} />,
        danger: true,
        onClick: () => setDeleteTarget(vault),
      },
    ],
    [t, canReveal, copyVaultId],
  );

  return (
    <aside className="vm-list">
      <div className="vm-list-header">{t('vault.listHeader')}</div>
      <div className="vm-list-body">
        {vaults.length === 0 && (
          <div className="vm-list-empty">
            <div>📂</div>
            <p>{t('vault.listEmpty')}</p>
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
              type="button"
              className="vm-vault-more"
              data-testid="vault-more-btn"
              aria-haspopup="menu"
              aria-label={t('vault.more')}
              title={t('vault.more')}
              onClick={(e) => openMenu(e, vault)}
            >
              <MoreIcon size={15} />
            </button>
          </div>
        ))}
      </div>

      {menu && (
        <ContextMenu items={menuItems(menu.vault)} position={{ x: menu.x, y: menu.y }} onClose={closeMenu} />
      )}

      {copyHint && (
        <div className="vm-copy-hint" role="status" data-testid="vault-copy-hint">
          {t('vault.idCopied')}
        </div>
      )}

      <ConfirmDialog
        show={!!deleteTarget}
        title={t('vault.removeTitle')}
        message={
          deleteTarget
            ? t('vault.removeMessage', { name: deleteTarget.name, path: deleteTarget.path })
            : ''
        }
        confirmLabel={t('vault.remove')}
        danger
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </aside>
  );
}
