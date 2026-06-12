/**
 * Knowledge Base page — assembles file panel, main content, wiki chat panel, and modals.
 */

import { useCallback, useRef, useState } from 'react';
import type { TreeNode } from '@molio/contracts';
import { useKnowledge } from '../../hooks/useKnowledge';
import { useWikiChat } from '../../hooks/useWikiChat';
import { KbFilePanel } from './KbFilePanel';
import { KbMainContent } from './KbMainContent';
import { WikiChatPanel } from './WikiChatPanel';
import { VaultManagerModal } from './VaultManager';
import { ImportModal, CoseInstallPrompt } from './KbModals';
import { ContextMenu, type MenuItem } from './ContextMenu';

interface KnowledgeBasePageProps {
  agentId: string | null;
}

export function KnowledgeBasePage({ agentId }: KnowledgeBasePageProps) {
  const kb = useKnowledge();
  const panelRef = useRef<HTMLDivElement>(null);
  const [showChatPanel, setShowChatPanel] = useState(false);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null);

  // Inline rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Save toast state
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const saveToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ─── New file / folder flows ───

  const handleNewFile = useCallback(async () => {
    if (!kb.activeVault) return;
    const name = window.prompt('新建文件名称（含扩展名，如 note.md）：', 'untitled.md');
    if (!name?.trim()) return;
    const defaultContent = name.endsWith('.md') ? `# ${name.replace(/\.md$/, '')}\n\n` : '';
    try {
      await kb.createFile(name.trim(), defaultContent);
    } catch (err) {
      window.alert(`创建文件失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [kb.activeVault, kb.createFile]);

  const handleNewFolder = useCallback(async () => {
    if (!kb.activeVault) return;
    const name = window.prompt('新建文件夹名称：', '新建文件夹');
    if (!name?.trim()) return;
    try {
      await kb.createFolder(name.trim());
    } catch (err) {
      window.alert(`创建文件夹失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [kb.activeVault, kb.createFolder]);

  // ─── Context menu ───

  const handleContextMenu = useCallback((node: TreeNode, e: React.MouseEvent) => {
    setCtxMenu({ node, x: e.clientX, y: e.clientY });
  }, []);

  const handleCloseCtxMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const getContextMenuItems = useCallback((): MenuItem[] => {
    if (!ctxMenu) return [];
    const { node } = ctxMenu;
    const items: MenuItem[] = [];

    if (node.type === 'file') {
      items.push({
        label: '打开',
        onClick: () => kb.selectFile(node.path),
      });
    }

    items.push({
      label: '重命名',
      onClick: () => setRenamingPath(node.path),
    });

    items.push({ divider: true });

    if (node.type === 'file') {
      items.push({
        label: '删除',
        danger: true,
        onClick: async () => {
          if (window.confirm(`确定删除文件 "${node.name}"？`)) {
            try {
              await kb.deleteFile(node.path);
            } catch (err) {
              window.alert(`删除失败：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        },
      });
    } else {
      items.push({
        label: '删除文件夹',
        danger: true,
        onClick: async () => {
          if (window.confirm(`确定删除文件夹 "${node.name}" 及其所有内容？`)) {
            try {
              await kb.deleteFolder(node.path);
            } catch (err) {
              window.alert(`删除失败：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        },
      });
    }

    return items;
  }, [ctxMenu, kb]);

  // ─── Inline rename ───

  const handleRenameComplete = useCallback(async (oldPath: string, newName: string) => {
    setRenamingPath(null);
    // Compute new path: same parent directory, new name
    const lastSlash = oldPath.lastIndexOf('/');
    const newPath = lastSlash >= 0 ? `${oldPath.slice(0, lastSlash + 1)}${newName}` : newName;
    if (newPath === oldPath) return;
    try {
      await kb.renameFile(oldPath, newPath);
    } catch (err) {
      window.alert(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [kb.renameFile]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // ─── Save edited content ───

  const showToast = useCallback((msg: string) => {
    if (saveToastTimer.current) clearTimeout(saveToastTimer.current);
    setSaveToast(msg);
    saveToastTimer.current = setTimeout(() => setSaveToast(null), 2000);
  }, []);

  const handleSave = useCallback(async () => {
    if (!kb.selectedFile || kb.editedContent === null) return;
    try {
      await kb.saveFile(kb.selectedFile, kb.editedContent);
      showToast('已保存');
    } catch (err) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [kb.selectedFile, kb.editedContent, kb.saveFile, showToast]);

  const hasUnsavedChanges = kb.editedContent !== null;

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
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onVaultClick={() => kb.setShowVaultSwitcher(true)}
        onAddToWiki={hasVault ? handleIngestFile : undefined}
        onBuildWiki={hasVault && !kb.wikiInitialized ? handleBuildWiki : undefined}
        onLintWiki={hasVault && kb.wikiInitialized ? handleLintWiki : undefined}
        onContextMenu={handleContextMenu}
        renamingPath={renamingPath}
        onRenameComplete={handleRenameComplete}
        onRenameCancel={handleRenameCancel}
      >
        {/* Resize handle attached to panel */}
        <div className="kb-resize-handle" onMouseDown={handleResizeStart} />
      </KbFilePanel>

      {/* Main Content */}
      <KbMainContent
        fileContent={kb.fileContent}
        selectedFile={kb.selectedFile}
        vaultId={kb.activeVault?.id ?? null}
        vaultPath={kb.activeVault?.path ?? null}
        isTypesetMode={kb.isTypesetMode}
        themeConfig={kb.themeConfig}
        wikiInitialized={kb.wikiInitialized}
        hasUnsavedChanges={hasUnsavedChanges}
        onToggleTypeset={kb.toggleTypesetMode}
        onThemeConfigChange={kb.setThemeConfig}
        onContentChange={kb.setEditedContent}
        onSave={kb.isTypesetMode ? handleSave : undefined}
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

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          items={getContextMenuItems()}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={handleCloseCtxMenu}
        />
      )}

      {/* Save toast */}
      {saveToast && (
        <div className="kb-save-toast">{saveToast}</div>
      )}
    </div>
  );
}
