/**
 * Create vault form — right panel of the vault manager.
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

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !vaultPath.trim()) return;
    await onCreate(name.trim(), vaultPath.trim(), description.trim() || undefined);
  }, [name, vaultPath, description, onCreate]);

  const canSubmit = name.trim() && vaultPath.trim() && !isLoading;

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
          placeholder="给新仓库起一个名字"
          value={name}
          onChange={(e) => setName(e.target.value)}
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
          />
          <button className="vm-browse-btn">浏览</button>
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
