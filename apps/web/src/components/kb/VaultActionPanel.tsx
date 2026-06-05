/**
 * Right-side action panel for the vault manager.
 * Branding + "Create vault" / "Open local vault" actions.
 */

interface VaultActionPanelProps {
  onCreate: () => void;
  onOpenLocal: () => void;
}

export function VaultActionPanel({ onCreate, onOpenLocal }: VaultActionPanelProps) {
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
    </div>
  );
}
