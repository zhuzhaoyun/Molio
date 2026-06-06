/**
 * Knowledge Base page — assembles file panel, main content, and modals.
 */

import { useCallback, useRef } from 'react';
import { useKnowledge } from '../../hooks/useKnowledge';
import { KbFilePanel } from './KbFilePanel';
import { KbMainContent } from './KbMainContent';
import { VaultManagerModal } from './VaultManager';
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
          console.log('Vault bar clicked, setting showVaultSwitcher to true');
          kb.setShowVaultSwitcher(true);
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
        onPublish={() => {/* TODO: publish flow */}}
      />

      {/* Vault Manager Modal (Obsidian-style) */}
      <VaultManagerModal
        show={kb.showVaultSwitcher}
        vaults={kb.vaults}
        activeVaultId={kb.activeVault?.id ?? null}
        onClose={() => kb.setShowVaultSwitcher(false)}
        onSelect={kb.selectVault}
        onCreate={kb.createVault}
        onOpen={kb.openVault}
        onDelete={kb.deleteVault}
      />

      {/* Import modal */}
      <ImportModal
        show={kb.showImport}
        vaultName={kb.activeVault?.name ?? ''}
        onClose={() => kb.setShowImport(false)}
      />
    </div>
  );
}
