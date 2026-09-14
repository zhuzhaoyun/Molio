/**
 * Right-side action panel for the vault manager.
 *
 * Two scopes share this panel and must not read as siblings:
 *   • app scope   — the collection-level actions (create / open a vault).
 *                   They don't apply to any one vault.
 *   • vault scope — external source roots, which belong to whichever vault is
 *                   highlighted in the left column.
 * A rule divides the two, and the second one opens with `当前仓库 · <name>` — so
 * the panel never leaves "which vault does this setting belong to?" unanswered.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ExternalRoot, Vault } from '@molio/contracts';
import { api } from '../../api/client';

interface VaultActionPanelProps {
  onCreate: () => void;
  onOpenLocal: () => void;
  /** Active vault — the external-roots section is per vault. */
  activeVault?: Vault | null;
  /** Whether any vault exists at all. Distinguishes "nothing selected yet"
   *  from first run, where there is nothing to select. */
  hasVaults?: boolean;
  /** Fired after a mount/unmount so the page can refresh the file tree and
   *  pick up (or drop) the `external/<label>` node. */
  onExternalRootsChanged?: () => void;
}

/**
 * Real app version from the Electron shell, or null in a plain browser
 * (dev / Docker deploy) — where we show nothing rather than a stale number.
 */
function readAppVersion(): string | null {
  try {
    return window.__electron__?.appInfo?.version ?? null;
  } catch {
    return null;
  }
}

export function VaultActionPanel({
  onCreate,
  onOpenLocal,
  activeVault,
  hasVaults,
  onExternalRootsChanged,
}: VaultActionPanelProps) {
  const appVersion = readAppVersion();

  return (
    <div className="vm-action-panel">
      <div className="vm-brand">
        <div className="vm-brand-logo" aria-hidden="true">
          📚
        </div>
        <div className="vm-brand-title">Molio 知识库</div>
        {appVersion && <div className="vm-brand-version">v{appVersion}</div>}
      </div>

      {/* App scope — nothing below this line depends on the left-column selection. */}
      <div className="vm-actions">
        <button
          type="button"
          className="vm-action-card"
          data-testid="vault-create-action"
          onClick={onCreate}
        >
          <span className="vm-action-text">
            <span className="vm-action-title">新建仓库</span>
            <span className="vm-action-desc">在指定文件夹下创建一个新的仓库。</span>
          </span>
          <span className="vm-action-go" aria-hidden="true">
            ›
          </span>
        </button>
        <button
          type="button"
          className="vm-action-card"
          data-testid="vault-open-action"
          onClick={onOpenLocal}
        >
          <span className="vm-action-text">
            <span className="vm-action-title">打开本地仓库</span>
            <span className="vm-action-desc">将一个本地文件夹作为仓库在 Molio 中打开。</span>
          </span>
          <span className="vm-action-go" aria-hidden="true">
            ›
          </span>
        </button>
      </div>

      {activeVault ? (
        <ExternalRootsSection vault={activeVault} onChanged={onExternalRootsChanged} />
      ) : (
        hasVaults && (
          // Distinct testid on purpose: `kb-external-roots.spec.ts` treats the
          // presence of `external-root-section` as "an active vault has
          // resolved", and re-selects one in the list when it hasn't.
          <section className="vm-roots is-idle" data-testid="external-root-idle">
            <p className="vm-roots-note">
              在左侧选中一个仓库，即可在这里为它挂载外部素材根。
            </p>
          </section>
        )
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
      // Desktop: one click → native folder picker → mount. `busy` is raised
      // around the picker too — otherwise a double click opens two dialogs
      // (mount() only sets it after the picker resolves).
      setBusy(true);
      try {
        const picked = await picker();
        if (picked) await mount(picked);
      } catch (err) {
        // Cancel resolves to null (desktop main.js), so a throw is a real
        // failure — surface it instead of dropping it on the floor.
        setError(`打开文件夹选择器失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
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
      {/* Vault scope — everything below belongs to `vault` alone. */}
      <div className="vm-scope">
        <div className="vm-scope-id">
          <span className="vm-scope-kicker">当前仓库</span>
          <span className="vm-scope-sep" aria-hidden="true">
            ·
          </span>
          <span className="vm-scope-name" data-testid="external-root-scope" title={vault.name}>
            {vault.name}
          </span>
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

      <p className="vm-roots-note">
        外部素材根 · 只读挂载本机文件夹，不复制、不可修改。
      </p>

      {formOpen && !isDesktop && (
        <div className="vm-roots-form">
          <input
            className="vm-form-input"
            type="text"
            value={target}
            placeholder="文件夹路径，例如 /data/素材"
            aria-label="外部文件夹路径"
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
