/**
 * Create vault form — right panel of the vault manager.
 */

import { useState, useCallback } from 'react';

interface CreateVaultFormProps {
  onCreate: (name: string, path: string, description?: string) => Promise<void>;
  onCancel: () => void;
  isLoading: boolean;
}

/** Extract the last segment of a file path as a fallback vault name. */
function nameFromPath(p: string): string {
  const normalized = p.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || '';
}

export function CreateVaultForm({ onCreate, onCancel, isLoading }: CreateVaultFormProps) {
  const [name, setName] = useState('');
  const [vaultPath, setVaultPath] = useState('');
  const [description, setDescription] = useState('');
  // The desktop app exposes a native folder picker; in a browser
  // (Docker/NAS deploy) it does not, so we guide the user to type the
  // container-internal mount path instead.
  const isDesktop = Boolean(window.__electron__?.showDirectoryPicker);

  const handleBrowse = useCallback(async () => {
    if (!window.__electron__?.showDirectoryPicker) {
      alert('浏览功能仅在桌面客户端中可用，请手动输入路径。');
      return;
    }
    try {
      const picked = await window.__electron__.showDirectoryPicker();
      if (!picked) return;
      setVaultPath(picked);
      // Auto-derive name from folder if name is empty (Obsidian-style)
      if (!name.trim()) {
        setName(nameFromPath(picked));
      }
    } catch {
      // User cancelled or picker error — ignore silently
    }
  }, [name]);

  const handleSubmit = useCallback(async () => {
    // Name falls back to path's last segment when empty
    const vaultName = name.trim() || nameFromPath(vaultPath.trim());
    if (!vaultName || !vaultPath.trim()) return;
    try {
      await onCreate(vaultName, vaultPath.trim(), description.trim() || undefined);
    } catch (err) {
      alert(`创建失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [name, vaultPath, description, onCreate]);

  const effectiveName = name.trim() || nameFromPath(vaultPath.trim());
  const canSubmit = effectiveName && vaultPath.trim() && !isLoading;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canSubmit) {
      handleSubmit();
    }
  }, [canSubmit, handleSubmit]);

  return (
    <div className="vm-create-form">
      <button className="vm-back-btn" onClick={onCancel}>
        ← 返回
      </button>
      <h2 className="vm-create-title">创建本地仓库</h2>

      <div className="vm-form-group">
        <label className="vm-form-label">仓库名称</label>
        <input
          className="vm-form-input"
          type="text"
          placeholder="留空则自动使用文件夹名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className="vm-form-group">
        <label className="vm-form-label">仓库位置</label>
        <div className="vm-form-row">
          <input
            className="vm-form-input"
            type="text"
            placeholder={isDesktop ? '指定新仓库的存放位置' : '挂载进容器的路径，例如 /vaults/笔记'}
            value={vaultPath}
            onChange={(e) => setVaultPath(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="vm-browse-btn" type="button" onClick={handleBrowse}>
            浏览
          </button>
        </div>
        {!isDesktop && (
          <p className="vm-form-hint">
            服务器 / NAS 部署请填写挂载进容器的路径（如 <code>/vaults</code> 或{' '}
            <code>/vaults/笔记</code>），而不是 NAS 宿主机路径——否则文件会写进容器临时层，重建后丢失。
          </p>
        )}
      </div>

      <div className="vm-form-group">
        <label className="vm-form-label">描述（可选）</label>
        <input
          className="vm-form-input"
          type="text"
          placeholder="简短描述这个仓库"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className="vm-form-actions">
        <button className="vm-submit-btn" onClick={handleSubmit} disabled={!canSubmit}>
          {isLoading ? '创建中...' : '创建'}
        </button>
      </div>
    </div>
  );
}
