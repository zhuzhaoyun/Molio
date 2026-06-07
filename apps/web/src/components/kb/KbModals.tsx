/**
 * Knowledge Base modals — Vault Switcher, Add Vault, Import Knowledge.
 */

import { useState, useCallback, useRef } from 'react';
import type { Vault } from '@molio/contracts';

// ═══════════════════════════════════════════
// Vault Switcher Modal
// ═══════════════════════════════════════════

interface VaultSwitcherModalProps {
  show: boolean;
  vaults: Vault[];
  activeVaultId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onAddVault: () => void;
  onImport: () => void;
}

export function VaultSwitcherModal({
  show,
  vaults,
  activeVaultId,
  onClose,
  onSelect,
  onAddVault,
  onImport,
}: VaultSwitcherModalProps) {
  if (!show) return null;

  return (
    <div className={`kb-overlay ${show ? 'show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kb-modal">
        <div className="kb-modal-header">
          <h2>Switch Knowledge Vault</h2>
          <button className="kb-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="kb-modal-body">
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Available Vaults
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {vaults.map((vault) => (
                <div
                  key={vault.id}
                  className={`kb-vault-option ${vault.id === activeVaultId ? 'is-active' : ''}`}
                  onClick={() => onSelect(vault.id)}
                >
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0, opacity: 0.6 }}>
                    <rect x="2" y="3" width="12" height="10" rx="1.5" />
                    <path d="M2 7h12" />
                    <circle cx="5" cy="10" r="0.8" fill="currentColor" />
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-strong)' }}>{vault.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {vault.path} &middot; {vault.fileCount} files
                    </div>
                  </div>
                  {vault.id === activeVaultId && (
                    <span style={{ color: 'var(--accent)', fontSize: 14 }}>✓</span>
                  )}
                </div>
              ))}
              {vaults.length === 0 && (
                <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  No vaults yet. Add one to get started.
                </div>
              )}
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', gap: 6 }}>
            <button className="kb-btn" onClick={() => { onClose(); onAddVault(); }} style={{ flex: 1, justifyContent: 'center' }}>
              <span style={{ fontSize: 15 }}>+</span> Add Vault...
            </button>
            <button className="kb-btn kb-btn-primary" onClick={() => { onClose(); onImport(); }} style={{ flex: 1, justifyContent: 'center' }}>
              ⤵ Import
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// COSE Extension Install Prompt
// ═══════════════════════════════════════════

interface CoseInstallPromptProps {
  show: boolean;
  onClose: () => void;
}

export function CoseInstallPrompt({ show, onClose }: CoseInstallPromptProps) {
  if (!show) return null;

  return (
    <div className={`kb-overlay ${show ? 'show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kb-modal" style={{ width: 420 }}>
        <div className="kb-modal-header">
          <h2>需要安装 COSE 扩展</h2>
          <button className="kb-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="kb-modal-body">
          <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 12 }}>
            发布功能依赖 <strong>COSE</strong> Chrome 扩展（全平台分发工具）。
            请先在 Chrome 浏览器中安装该扩展，然后重新点击发布按钮。
          </p>
          <div style={{ padding: '12px 14px', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 4 }}>
            <div style={{ marginBottom: 6 }}>📦 安装方式：</div>
            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
              <li>打开 Chrome 应用商店搜索 <strong>COSE</strong></li>
              <li>或访问 <a href="https://github.com/doocs/cose" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>github.com/doocs/cose</a></li>
              <li>安装后刷新本页面</li>
            </ol>
          </div>
        </div>
        <div className="kb-modal-footer">
          <button className="kb-btn kb-btn-primary" onClick={onClose} style={{ width: '100%', justifyContent: 'center' }}>
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// Add Vault Modal
// ═══════════════════════════════════════════

interface AddVaultModalProps {
  show: boolean;
  onClose: () => void;
  onCreate: (name: string, path: string, description?: string) => Promise<void>;
}

export function AddVaultModal({ show, onClose, onCreate }: AddVaultModalProps) {
  const [name, setName] = useState('');
  const [vaultPath, setVaultPath] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !vaultPath.trim()) return;
    setSaving(true);
    try {
      await onCreate(name.trim(), vaultPath.trim(), description.trim() || undefined);
      setName('');
      setVaultPath('');
      setDescription('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create vault');
    } finally {
      setSaving(false);
    }
  }, [name, vaultPath, description, onCreate]);

  if (!show) return null;

  return (
    <div className={`kb-overlay ${show ? 'show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kb-modal">
        <div className="kb-modal-header">
          <h2>Add Knowledge Vault</h2>
          <button className="kb-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="kb-modal-body">
          <div className="kb-form-field">
            <label htmlFor="vaultName">Vault Name</label>
            <input
              type="text"
              id="vaultName"
              placeholder="e.g., project-docs"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="kb-form-field">
            <label htmlFor="vaultPath">Folder Path</label>
            <div className="kb-form-row">
              <input
                type="text"
                id="vaultPath"
                placeholder="C:\Users\name\Documents\my-wiki"
                value={vaultPath}
                onChange={(e) => setVaultPath(e.target.value)}
              />
            </div>
            <div className="kb-form-hint">Select an existing folder or create a new one</div>
          </div>
          <div className="kb-form-field">
            <label htmlFor="vaultDesc">Description (optional)</label>
            <input
              type="text"
              id="vaultDesc"
              placeholder="Brief description of this vault"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <div className="kb-modal-footer">
          <button className="kb-btn kb-btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="kb-btn kb-btn-primary"
            onClick={handleSave}
            disabled={saving || !name.trim() || !vaultPath.trim()}
          >
            {saving ? 'Creating...' : 'Add Vault'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// Import Knowledge Modal
// ═══════════════════════════════════════════

interface ImportModalProps {
  show: boolean;
  vaultName: string;
  onClose: () => void;
}

interface ImportedFile {
  name: string;
  size: number;
}

export function ImportModal({ show, vaultName, onClose }: ImportModalProps) {
  const [files, setFiles] = useState<ImportedFile[]>([]);
  const [target, setTarget] = useState<'raw' | 'wiki'>('raw');
  const [autoIngest, setAutoIngest] = useState(true);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    const validExts = ['.md', '.pdf', '.txt', '.docx', '.html', '.htm'];
    const newFiles: ImportedFile[] = [];

    for (const file of Array.from(fileList)) {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      if (validExts.includes(ext) && !files.find((f) => f.name === file.name)) {
        newFiles.push({ name: file.name, size: file.size });
      }
    }

    setFiles((prev) => [...prev, ...newFiles]);
  }, [files]);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.add('kb-dropzone-active');
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.currentTarget.classList.remove('kb-dropzone-active');
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove('kb-dropzone-active');
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleImport = useCallback(async () => {
    if (files.length === 0) return;
    setImporting(true);
    // TODO: implement actual file upload via API
    // For now, just close after a brief delay
    setTimeout(() => {
      setImporting(false);
      setFiles([]);
      onClose();
    }, 500);
  }, [files, onClose]);

  if (!show) return null;

  return (
    <div className={`kb-overlay ${show ? 'show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kb-modal" style={{ width: 500 }}>
        <div className="kb-modal-header">
          <h2>Import Knowledge</h2>
          <button className="kb-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="kb-modal-body">
          {/* Drop zone */}
          <div
            className="kb-dropzone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.4 }}>📦</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>
              Drop files here or click to browse
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              Supports .md, .pdf, .txt, .docx, .html
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".md,.pdf,.txt,.docx,.html,.htm"
              style={{ display: 'none' }}
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>

          {/* Selected files */}
          {files.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                Selected Files
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 140, overflowY: 'auto' }}>
                {files.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: 'var(--bg-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 12.5 }}>
                    <span style={{ fontSize: 13 }}>📄</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{f.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>{(f.size / 1024).toFixed(1)} KB</span>
                    <button
                      onClick={() => removeFile(i)}
                      style={{ width: 18, height: 18, padding: 0, border: 'none', background: 'transparent', borderRadius: 4, color: 'var(--text-faint)', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Options */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Import Options
            </div>
            <div className="kb-form-field" style={{ marginBottom: 10 }}>
              <label>Target Folder</label>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value as 'raw' | 'wiki')}
                style={{ width: '100%', height: 34, padding: '0 8px', font: 'inherit', fontSize: 13, color: 'var(--text)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', outline: 'none', cursor: 'pointer' }}
              >
                <option value="raw">raw/ (unprocessed sources)</option>
                <option value="wiki">wiki/ (direct to knowledge)</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)' }}>
              <input
                type="checkbox"
                checked={autoIngest}
                onChange={(e) => setAutoIngest(e.target.checked)}
                style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
              <label style={{ cursor: 'pointer' }}>Auto-ingest with Claude Code after import</label>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 24, marginTop: 2 }}>
              Compile sources into structured wiki pages with cross-references
            </div>
          </div>
        </div>
        <div className="kb-modal-footer">
          <button className="kb-btn kb-btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="kb-btn kb-btn-primary"
            onClick={handleImport}
            disabled={files.length === 0 || importing}
          >
            {importing ? 'Importing...' : 'Import Files'}
          </button>
        </div>
      </div>
    </div>
  );
}
