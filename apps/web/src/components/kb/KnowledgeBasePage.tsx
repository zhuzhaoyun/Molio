/**
 * Knowledge Base page — assembles file panel, main content, wiki chat panel, and modals.
 * Now with: workspace tab system + right-click context menu + inline rename.
 */

import { useCallback, useRef, useState } from 'react';
import type { TreeNode } from '@molio/contracts';
import { useKnowledge } from '../../hooks/useKnowledge';
import { useWikiChat } from '../../hooks/useWikiChat';
import { useKbTabs } from '../../hooks/useKbTabs';
import { KbFilePanel } from './KbFilePanel';
import { KbMainContent } from './KbMainContent';
import { WikiChatPanel } from './WikiChatPanel';
import { VaultManagerModal } from './VaultManager';
import { ImportModal, CoseInstallPrompt, InputDialog, ConfirmDialog } from './KbModals';
import { ContextMenu, type MenuItem } from './ContextMenu';

interface KnowledgeBasePageProps {
  agentId: string | null;
}

export function KnowledgeBasePage({ agentId }: KnowledgeBasePageProps) {
  const kb = useKnowledge();
  const tabs = useKbTabs();
  const [showChatPanel, setShowChatPanel] = useState(false);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null);

  // Inline rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Save toast state
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const saveToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Input dialog state (replaces window.prompt)
  const [inputDialog, setInputDialog] = useState<{
    show: boolean;
    title: string;
    label: string;
    defaultValue: string;
    placeholder?: string;
    confirmLabel?: string;
    onConfirm: (value: string) => void;
  }>({ show: false, title: '', label: '', defaultValue: '', onConfirm: () => {} });

  // Confirm dialog state (replaces window.confirm)
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
  }>({ show: false, title: '', message: '', onConfirm: () => {} });

  // Wiki chat hook — refreshes tree on build completion
  const wikiChat = useWikiChat({
    vaultId: kb.activeVault?.id ?? null,
    agentId,
    onComplete: () => {
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

  // ─── Save toast helper (defined early — used by callbacks below) ───

  const showToast = useCallback((msg: string) => {
    if (saveToastTimer.current) clearTimeout(saveToastTimer.current);
    setSaveToast(msg);
    saveToastTimer.current = setTimeout(() => setSaveToast(null), 2000);
  }, []);

  // ─── New file / folder flows (React dialogs instead of window.prompt) ───

  const handleNewFile = useCallback((parentPath?: string) => {
    if (!kb.activeVault) return;
    const prefix = parentPath ? `${parentPath}/` : '';
    setInputDialog({
      show: true,
      title: parentPath ? `在 ${parentPath} 下新建文件` : '新建文件',
      label: '文件名称（含扩展名，如 note.md）',
      defaultValue: 'untitled.md',
      confirmLabel: '创建',
      onConfirm: async (name) => {
        setInputDialog((prev) => ({ ...prev, show: false }));
        const fullPath = `${prefix}${name}`;
        const defaultContent = name.endsWith('.md') ? `# ${name.replace(/\.md$/, '')}\n\n` : '';
        try {
          await kb.createFile(fullPath, defaultContent);
          // Auto-enter typeset (edit) mode for new text files
          const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
          const isText = ['.md', '.txt', '.html', '.htm', '.json', '.yaml', '.yml'].includes(ext);
          if (isText) {
            kb.setTypesetMode(true);
          }
        } catch (err) {
          showToast(`创建文件失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
  }, [kb.activeVault, kb.createFile, kb.setTypesetMode, showToast]);

  const handleNewFolder = useCallback((parentPath?: string) => {
    if (!kb.activeVault) return;
    const prefix = parentPath ? `${parentPath}/` : '';
    setInputDialog({
      show: true,
      title: parentPath ? `在 ${parentPath} 下新建文件夹` : '新建文件夹',
      label: '文件夹名称',
      defaultValue: '新建文件夹',
      confirmLabel: '创建',
      onConfirm: async (name) => {
        setInputDialog((prev) => ({ ...prev, show: false }));
        const fullPath = `${prefix}${name}`;
        try {
          await kb.createFolder(fullPath);
        } catch (err) {
          showToast(`创建文件夹失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
  }, [kb.activeVault, kb.createFolder, showToast]);

  const handleCancelInputDialog = useCallback(() => {
    setInputDialog((prev) => ({ ...prev, show: false }));
  }, []);

  const handleCancelConfirmDialog = useCallback(() => {
    setConfirmDialog((prev) => ({ ...prev, show: false }));
  }, []);

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
    } else {
      // Directory: offer create file / subfolder inside
      items.push({
        label: '新建文件',
        onClick: () => handleNewFile(node.path),
      });
      items.push({
        label: '新建子文件夹',
        onClick: () => handleNewFolder(node.path),
      });
      items.push({ divider: true });
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
        onClick: () => {
          setConfirmDialog({
            show: true,
            title: '删除文件',
            message: `确定删除文件 "${node.name}"？`,
            confirmLabel: '删除',
            danger: true,
            onConfirm: async () => {
              setConfirmDialog((prev) => ({ ...prev, show: false }));
              try {
                await kb.deleteFile(node.path);
              } catch (err) {
                showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
              }
            },
          });
        },
      });
    } else {
      items.push({
        label: '删除文件夹',
        danger: true,
        onClick: () => {
          setConfirmDialog({
            show: true,
            title: '删除文件夹',
            message: `确定删除文件夹 "${node.name}" 及其所有内容？`,
            confirmLabel: '删除',
            danger: true,
            onConfirm: async () => {
              setConfirmDialog((prev) => ({ ...prev, show: false }));
              try {
                await kb.deleteFolder(node.path);
              } catch (err) {
                showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
              }
            },
          });
        },
      });
    }

    return items;
  }, [ctxMenu, kb, showToast, handleNewFile, handleNewFolder]);

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
      showToast(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [kb.renameFile, showToast]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // ─── Save edited content ───

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
    <div className="kb-shell">
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

      {/* Vault Manager Modal */}
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

      {/* Input dialog (replaces window.prompt) */}
      <InputDialog
        show={inputDialog.show}
        title={inputDialog.title}
        label={inputDialog.label}
        defaultValue={inputDialog.defaultValue}
        placeholder={inputDialog.placeholder}
        confirmLabel={inputDialog.confirmLabel}
        onConfirm={inputDialog.onConfirm}
        onCancel={handleCancelInputDialog}
      />

      {/* Confirm dialog (replaces window.confirm) */}
      <ConfirmDialog
        show={confirmDialog.show}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        danger={confirmDialog.danger}
        onConfirm={confirmDialog.onConfirm}
        onCancel={handleCancelConfirmDialog}
      />
    </div>
  );
}
