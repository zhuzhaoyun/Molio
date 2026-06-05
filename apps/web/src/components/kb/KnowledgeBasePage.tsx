/**
 * Knowledge Base page — assembles file panel, main content, and modals.
 *
 * When no vault is active (first-time user), shows the Obsidian-style
 * vault manager (VaultManager) instead of the file panel + content.
 */

import { useCallback, useRef } from 'react';
import { useKnowledge } from '../../hooks/useKnowledge';
import { KbFilePanel } from './KbFilePanel';
import { KbMainContent } from './KbMainContent';
import { VaultManager } from './VaultManager';
import { ImportModal } from './KbModals';

export function KnowledgeBasePage() {
  const kb = useKnowledge();
  const panelRef = useRef<HTMLDivElement>(null);

  // Panel resize drag handling
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = kb.panelWidth;
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.min(480, Math.max(180, startWidth + delta));
      kb.setPanelWidth(newWidth);
    };

    const onUp = () => {
      handle.classList.remove('is-dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [kb.panelWidth, kb.setPanelWidth]);

  // ── No active vault → show vault manager ──
  if (!kb.activeVault) {
    return (
      <div className="kb-shell" ref={panelRef}>
        <VaultManager
          vaults={kb.vaults}
          activeVaultId={null}
          onSelectVault={kb.selectVault}
          onCreateVault={kb.createVault}
          onDeleteVault={kb.deleteVault}
        />

        {/* Import modal (reused from existing flow) */}
        <ImportModal
          show={kb.showImport}
          vaultName=""
          onClose={() => kb.setShowImport(false)}
        />
      </div>
    );
  }

  // ── Active vault → show file panel + content ──
  return (
    <div className="kb-shell" ref={panelRef}>
      {/* File Panel */}
      <KbFilePanel
        width={kb.panelWidth}
        tree={kb.tree}
        selectedFile={kb.selectedFile}
        searchQuery={kb.searchQuery}
        vaultName={kb.activeVault?.name ?? ''}
        onSearchChange={kb.setSearchQuery}
        onSelectFile={kb.selectFile}
        onNewFile={() => {/* TODO: new file flow */}}
        onNewFolder={() => {/* TODO: new folder flow */}}
        onImport={() => kb.setShowImport(true)}
        onVaultClick={() => {
          // Deselect vault → show vault manager
          kb.selectVault('');
        }}
      >
        {/* Resize handle attached to panel */}
        <div className="kb-resize-handle" onMouseDown={handleResizeStart} />
      </KbFilePanel>

      {/* Main Content */}
      <KbMainContent
        fileContent={kb.fileContent}
        selectedFile={kb.selectedFile}
        isTypesetMode={kb.isTypesetMode}
        themeConfig={kb.themeConfig}
        onToggleTypeset={kb.toggleTypesetMode}
        onThemeConfigChange={kb.setThemeConfig}
        onContentChange={kb.setEditedContent}
        onCopy={kb.copyToClipboard}
        onPublish={kb.publishToChrome}
      />

      {/* Import modal */}
      <ImportModal
        show={kb.showImport}
        vaultName={kb.activeVault?.name ?? ''}
        onClose={() => kb.setShowImport(false)}
      />

      {/* COSE install prompt */}
      <CoseInstallModal
        show={kb.showCoseInstallPrompt}
        onClose={() => kb.setShowCoseInstallPrompt(false)}
      />
    </div>
  );
}

// ─── COSE Install Modal ───

const COSE_WEBSTORE_URL = 'https://chromewebstore.google.com/detail/ilhikcdphhpjofhlnbojifbihhfmmhfk';

function CoseInstallModal({ show, onClose }: { show: boolean; onClose: () => void }) {
  if (!show) return null;

  const handleInstall = () => {
    window.open(COSE_WEBSTORE_URL, '_blank');
    onClose();
  };

  return (
    <div className={`kb-overlay ${show ? 'show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kb-modal" style={{ maxWidth: 420 }}>
        <div className="kb-modal-header">
          <h2>安装 COSE 扩展</h2>
          <button className="kb-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="kb-modal-body" style={{ fontSize: 13, lineHeight: 1.7 }}>
          <p style={{ marginBottom: 12 }}>
            发布功能需要安装 <strong>COSE 文章同步助手</strong> 浏览器扩展。
          </p>
          <p style={{ marginBottom: 12, color: 'var(--text-muted, #888)' }}>
            COSE 支持将文章一键同步到微信公众号、知乎、掘金、CSDN 等 30+ 平台，完全本地运行，不收集用户信息。
          </p>
        </div>
        <div className="kb-modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="kb-btn" onClick={onClose}>取消</button>
          <button className="kb-btn kb-btn-primary" onClick={handleInstall}>安装扩展</button>
        </div>
      </div>
    </div>
  );
}
