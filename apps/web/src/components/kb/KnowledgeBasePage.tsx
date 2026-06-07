/**
 * Knowledge Base page — assembles file panel, main content, wiki chat panel, and modals.
 */

import { useCallback, useRef, useState } from 'react';
import { useKnowledge } from '../../hooks/useKnowledge';
import { useWikiChat } from '../../hooks/useWikiChat';
import { KbFilePanel } from './KbFilePanel';
import { KbMainContent } from './KbMainContent';
import { WikiChatPanel } from './WikiChatPanel';
import { VaultManagerModal } from './VaultManager';
import { ImportModal, CoseInstallPrompt } from './KbModals';

interface KnowledgeBasePageProps {
  agentId: string | null;
}

export function KnowledgeBasePage({ agentId }: KnowledgeBasePageProps) {
  const kb = useKnowledge();
  const panelRef = useRef<HTMLDivElement>(null);
  const [showChatPanel, setShowChatPanel] = useState(false);

  // Wiki chat hook — refreshes tree on build completion
  const wikiChat = useWikiChat({
    vaultId: kb.activeVault?.id ?? null,
    agentId,
    onComplete: () => {
      // Refresh file tree and wiki status after a successful build
      kb.refreshTree();
    },
  });

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

  // Wiki operation handlers
  const handleBuildWiki = useCallback(() => {
    if (!agentId) return;
    setShowChatPanel(true);
    wikiChat.reset();
    // Defer to next tick so the panel is mounted before messages appear
    setTimeout(() => {
      wikiChat.startOperation('build', '开始构建 Wiki');
    }, 50);
  }, [agentId, wikiChat]);

  const handleIngestFile = useCallback((filePath: string) => {
    if (!agentId) return;
    setShowChatPanel(true);
    wikiChat.reset();
    setTimeout(() => {
      wikiChat.startOperation('ingest', `把 ${filePath} 加入 Wiki`, { filePath });
    }, 50);
  }, [agentId, wikiChat]);

  const handleLintWiki = useCallback(() => {
    if (!agentId) return;
    setShowChatPanel(true);
    wikiChat.reset();
    setTimeout(() => {
      wikiChat.startOperation('lint', '检查 Wiki 健康状况');
    }, 50);
  }, [agentId, wikiChat]);

  const handleCloseChat = useCallback(() => {
    setShowChatPanel(false);
    if (wikiChat.isRunning) {
      wikiChat.cancel();
    }
  }, [wikiChat]);

  const hasVault = !!kb.activeVault;

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
        onVaultClick={() => {
          console.log('Vault bar clicked, setting showVaultSwitcher to true');
          kb.setShowVaultSwitcher(true);
        }}
        onAddToWiki={hasVault ? handleIngestFile : undefined}
        onBuildWiki={hasVault && !kb.wikiInitialized ? handleBuildWiki : undefined}
        onLintWiki={hasVault && kb.wikiInitialized ? handleLintWiki : undefined}
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
        wikiInitialized={kb.wikiInitialized}
        onToggleTypeset={kb.toggleTypesetMode}
        onThemeConfigChange={kb.setThemeConfig}
        onContentChange={kb.setEditedContent}
        onCopy={kb.copyToClipboard}
        onPublish={kb.publishToChrome}
        onBuildWiki={handleBuildWiki}
      />

      {/* Wiki Chat Panel (right side) */}
      {showChatPanel && (
        <WikiChatPanel
          messages={wikiChat.messages}
          isRunning={wikiChat.isRunning}
          operationType={wikiChat.operationType}
          onSend={wikiChat.send}
          onCancel={wikiChat.cancel}
          onClose={handleCloseChat}
          onSubmitToolResult={wikiChat.submitToolResult}
        />
      )}

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

      {/* COSE extension install prompt */}
      <CoseInstallPrompt
        show={kb.showCoseInstallPrompt}
        onClose={() => kb.setShowCoseInstallPrompt(false)}
      />
    </div>
  );
}
