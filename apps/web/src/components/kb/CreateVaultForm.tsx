/**
 * Create vault form — right panel of the vault manager.
 *
 * Provides a form for creating a new local vault with:
 * - Name input
 * - Path input with Electron directory picker ("浏览" button)
 * - Optional description
 * - Error feedback on creation failure
 */

import { useState, useCallback } from 'react';

interface CreateVaultFormProps {
  onCreate: (name: string, path: string, description?: string) => Promise<void>;
  onCancel: () => void;
  isLoading: boolean;
}

export function CreateVaultForm({ onCreate, onCancel, isLoading }: CreateVaultFormProps) {
  const [name, setName] = useState('');
  const [vaultPath, setVaultPath] = useState('');
  const [description, setDescription] = useState('');

  /** Derive a display name from a filesystem path's last segment. */
  const nameFromPath = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

  /** Browse for a directory using Electron's native dialog. */
  const handleBrowse = useCallback(async () => {
    if (!window.__electron__?.showDirectoryPicker) {
      alert('浏览功能仅在桌面客户端中可用。\n\n在浏览器中请手动输入文件夹路径，例如：\nD:\\Documents\\my-vault');
      return;
    }
    try {
      const picked = await window.__electron__.showDirectoryPicker();
      if (!picked) return; // user cancelled
      setVaultPath(picked);
      // If name is empty, auto-derive from the selected folder (Obsidian behavior)
      if (!name.trim()) {
        setName(nameFromPath(picked));
      }
    } catch {
      // dialog error or cancellation — ignore
    }
  }, [name]);

  const handleSubmit = useCallback(async () => {
    if (!vaultPath.trim()) return;
    // Name is optional — fall back to the last path segment (Obsidian behavior)
    const vaultName = name.trim() || nameFromPath(vaultPath.trim());
    try {
      await onCreate(vaultName, vaultPath.trim(), description.trim() || undefined);
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建仓库失败');
    }
  }, [name, vaultPath, description, onCreate]);

  const canSubmit = vaultPath.trim() && !isLoading;

  return (
    <div className="vm-create-form">
      <button className="vm-back-btn" onClick={onCancel}>
        ← 返回
      </button>
      <h2 className="vm-create-title">创建本地仓库</h2>

      <div className="vm-form-group">
        <label className="vm-form-label">仓库名称（可选）</label>
        <input
          className="vm-form-input"
          type="text"
          placeholder="留空则使用文件夹名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleSubmit()}
        />
      </div>

      <div className="vm-form-group">
        <label className="vm-form-label">仓库位置</label>
        <div className="vm-form-row">
          <input
            className="vm-form-input"
            type="text"
            placeholder="指定新仓库的存放位置"
            value={vaultPath}
            onChange={(e) => setVaultPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleSubmit()}
          />
          <button className="vm-browse-btn" type="button" onClick={handleBrowse}>
            浏览
          </button>
        </div>
      </div>

      <div className="vm-form-group">
        <label className="vm-form-label">描述（可选）</label>
        <input
          className="vm-form-input"
          type="text"
          placeholder="简短描述这个仓库"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleSubmit()}
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
