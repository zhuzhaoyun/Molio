/**
 * Right-side action panel for the vault manager.
 * Branding + "Create vault" / "Open local vault" actions, plus the
 * external source roots section for the active vault.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ExternalRoot, Vault } from '@molio/contracts';
import { api } from '../../api/client';

interface VaultActionPanelProps {
  onCreate: () => void;
  onOpenLocal: () => void;
  /** Active vault — the external-roots section is per vault. */
  activeVault?: Vault | null;
  /** Fired after a mount/unmount so the page can refresh the file tree and
   *  pick up (or drop) the `external/<label>` node. */
  onExternalRootsChanged?: () => void;
}

export function VaultActionPanel({
  onCreate,
  onOpenLocal,
  activeVault,
  onExternalRootsChanged,
}: VaultActionPanelProps) {
  return (
    <div className="vm-action-panel">
      {/* Branding */}
      <div className="vm-brand">
        <div className="vm-brand-logo">📚</div>
        <div className="vm-brand-title">Molio 知识库</div>
        <div className="vm-brand-version">版本 1.0</div>
      </div>

      {/* Actions */}
      <div className="vm-actions">
        <div className="vm-action-card">
          <div className="vm-action-text">
            <div className="vm-action-title">新建仓库</div>
            <div className="vm-action-desc">在指定文件夹下创建一个新的仓库。</div>
          </div>
          <button className="vm-action-btn vm-action-btn-primary" onClick={onCreate}>
            创建
          </button>
        </div>

        <div className="vm-action-card">
          <div className="vm-action-text">
            <div className="vm-action-title">打开本地仓库</div>
            <div className="vm-action-desc">将一个本地文件夹作为仓库在 Molio 中打开。</div>
          </div>
          <button className="vm-action-btn" onClick={onOpenLocal}>
            打开
          </button>
        </div>
      </div>

      {activeVault && (
        <ExternalRootsSection
          vault={activeVault}
          onChanged={onExternalRootsChanged}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// External source roots（外部素材根）
// ═══════════════════════════════════════════

/** Native folder picker — only present inside the Electron shell. */
function nativeDirectoryPicker(): (() => Promise<string | null>) | undefined {
  return window.__electron__?.showDirectoryPicker;
}

interface ExternalRootsSectionProps {
  vault: Vault;
  onChanged?: () => void;
}

/**
 * Read-only external source roots mounted under `<vault>/external/<label>`.
 *
 * Mounting is a link, not a copy — Molio does not own these folders, so nothing
 * mounted here is editable. The tree enforces the same rule (see KbFileTree's
 * read-only nodes); this section only manages the registry.
 */
function ExternalRootsSection({ vault, onChanged }: ExternalRootsSectionProps) {
  const [roots, setRoots] = useState<ExternalRoot[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vaultId = vault.id;

  const refresh = useCallback(async () => {
    try {
      setRoots(await api.listExternalRoots(vaultId));
    } catch (err) {
      setRoots([]);
      setError(`读取外部素材根失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [vaultId]);

  useEffect(() => {
    setError(null);
    setFormOpen(false);
    setTarget('');
    void refresh();
  }, [refresh]);

  const mount = useCallback(
    async (picked: string) => {
      const trimmed = picked.trim();
      if (!trimmed) return;
      setBusy(true);
      setError(null);
      try {
        await api.addExternalRoot(vaultId, { target: trimmed });
        setFormOpen(false);
        setTarget('');
        await refresh();
        onChanged?.();
      } catch (err) {
        setError(`挂载失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [vaultId, refresh, onChanged]
  );

  const handleAdd = useCallback(async () => {
    if (busy) return;
    setError(null);
    const picker = nativeDirectoryPicker();
    if (picker) {
      // Desktop: one click → native folder picker → mount.
      try {
        const picked = await picker();
        if (picked) await mount(picked);
      } catch {
        /* user cancelled or picker error — stay silent */
      }
      return;
    }
    // Browser / NAS deploy: no native picker, type the path instead.
    setFormOpen((open) => !open);
  }, [busy, mount]);

  const handleRemove = useCallback(
    async (rootId: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await api.removeExternalRoot(vaultId, rootId);
        await refresh();
        onChanged?.();
      } catch (err) {
        setError(`移除失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [vaultId, busy, refresh, onChanged]
  );

  const isDesktop = Boolean(nativeDirectoryPicker());

  return (
    <section className="vm-roots" data-testid="external-root-section">
      <div className="vm-roots-head">
        <div className="vm-action-text">
          <div className="vm-action-title">外部素材根</div>
          <div className="vm-action-desc">
            只读挂载本地文件夹作为素材来源，挂载内容不可新建 / 重命名 / 删除。
          </div>
        </div>
        <button
          type="button"
          className="vm-action-btn"
          data-testid="external-root-add"
          onClick={handleAdd}
          disabled={busy}
          title={isDesktop ? '选择要挂载的本地文件夹' : '输入要挂载的文件夹路径'}
        >
          添加外部文件夹
        </button>
      </div>

      {formOpen && !isDesktop && (
        <div className="vm-roots-form">
          <input
            className="vm-form-input"
            type="text"
            value={target}
            placeholder="文件夹路径，例如 /data/素材"
            data-testid="external-root-target"
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && target.trim()) void mount(target);
            }}
          />
          <button
            type="button"
            className="vm-action-btn"
            data-testid="external-root-add-confirm"
            onClick={() => void mount(target)}
            disabled={busy || !target.trim()}
          >
            添加
          </button>
          <button
            type="button"
            className="vm-action-btn"
            data-testid="external-root-add-cancel"
            disabled={busy}
            onClick={() => {
              setFormOpen(false);
              setTarget('');
            }}
          >
            取消
          </button>
        </div>
      )}

      <div className="vm-roots-list" data-testid="external-root-list">
        {roots.length === 0 && (
          <div className="vm-roots-empty" data-testid="external-root-empty">
            还没有挂载外部文件夹
          </div>
        )}
        {roots.map((root) => (
          <div
            key={root.id}
            className={`vm-root-item${root.valid ? '' : ' is-invalid'}`}
            data-testid="external-root-item"
            data-label={root.label}
            data-valid={root.valid ? 'true' : 'false'}
          >
            <div className="vm-root-text">
              <div className="vm-root-label">
                {root.label}
                {!root.valid && (
                  <span
                    className="vm-root-badge"
                    data-testid="external-root-invalid"
                    title="目标文件夹已移动或删除，源文件夹已不可读"
                  >
                    已失效
                  </span>
                )}
              </div>
              <div className="vm-root-target" title={root.target}>
                {root.target}
              </div>
            </div>
            <button
              type="button"
              className="vm-root-remove"
              data-testid="external-root-remove"
              disabled={busy}
              title={
                root.valid
                  ? '移除挂载（只解除挂载，不会删除源文件夹）'
                  : '目标已失效，可移除这条挂载记录'
              }
              onClick={() => void handleRemove(root.id)}
            >
              移除
            </button>
          </div>
        ))}
      </div>

      {error && (
        <div className="vm-roots-error" data-testid="external-root-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
