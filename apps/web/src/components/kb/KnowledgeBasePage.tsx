/**
 * Knowledge Base page — assembles file panel, main content, wiki chat panel, and modals.
 * Now with: workspace tab system + right-click context menu + inline rename.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { TreeNode } from '@molio/contracts';
import { useKnowledge } from '../../hooks/useKnowledge';
import { useChat } from '../../hooks/useChat';
import { useFileChat } from '../../hooks/useFileChat';
import { useKbTabs } from '../../hooks/useKbTabs';
import { kbTabsStore } from '../../stores/kbTabsStore';
import { vaultStore } from '../../stores/vaultStore';
import { KbFilePanel } from './KbFilePanel';
import { KbTabBar } from './KbTabBar';
import { KbMainContent } from './KbMainContent';
import { WikiChatPanel } from './WikiChatPanel';
import { FileChatPanel } from './FileChatPanel';
import { VaultManagerModal } from './VaultManager';
import { ImportModal, CoseInstallPrompt, InputDialog, ConfirmDialog } from './KbModals';
import { ContextMenu, type MenuItem } from './ContextMenu';

interface KnowledgeBasePageProps {
  agentId: string | null;
}

interface UrlFileNavigation {
  vaultId: string;
  filePath: string;
}

function resolveUrlFileNavigation(
  searchParams: URLSearchParams,
  kb: ReturnType<typeof useKnowledge>,
): UrlFileNavigation | null {
  const filePath = searchParams.get('file');
  if (!filePath || kb.vaults.length === 0) return null;

  const vaultId = searchParams.get('vault') || kb.activeVault?.id || kb.vaults[0]?.id || null;
  if (!vaultId) return null;

  return { vaultId, filePath };
}

export function KnowledgeBasePage({ agentId }: KnowledgeBasePageProps) {
  const kb = useKnowledge();
  const tabs = useKbTabs();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [showChatPanel, setShowChatPanel] = useState(false);
  const [fileChatOpen, setFileChatOpen] = useState(false);
  const [fileChatFilePath, setFileChatFilePath] = useState<string | null>(null);
  const [fileChatSelectedText, setFileChatSelectedText] = useState<string | null>(null);
  const [pendingUrlNav, setPendingUrlNav] = useState<UrlFileNavigation | null>(null);

  // Handle ?vault=<vaultId>&file=<filePath> query params for external navigation
  // (e.g. from molio:// protocol triggered by Chrome extension after clip save)
  useEffect(() => {
    const nav = resolveUrlFileNavigation(searchParams, kb);
    if (!nav) return;

    setPendingUrlNav(nav);
    vaultStore.setActiveVaultId(nav.vaultId);
    // Clear query params after handling (keeps URL clean)
    setSearchParams({}, { replace: true });
  }, [searchParams, kb.vaults, kb.activeVault?.id, setSearchParams]);

  // Handle location.state for in-app navigation (e.g., from graph double-click)
  useEffect(() => {
    const state = location.state as { openFile?: string; vaultId?: string } | null;
    if (!state?.openFile) return;
    if (kb.vaults.length === 0) return;

    const vaultId = state.vaultId || kb.activeVault?.id || kb.vaults[0]?.id;
    if (!vaultId) return;

    setPendingUrlNav({ vaultId, filePath: state.openFile });
    vaultStore.setActiveVaultId(vaultId);
    // Clear state to prevent re-processing on re-renders
    navigate('.', { replace: true, state: {} });
  }, [location.state, kb.vaults, kb.activeVault?.id, navigate]);

  useEffect(() => {
    if (!pendingUrlNav) return;
    if (kb.activeVault?.id !== pendingUrlNav.vaultId) return;
    if (kb.treeVaultId !== pendingUrlNav.vaultId) return;
    if (kb.tree.length === 0) return;

    kb.selectFile(pendingUrlNav.filePath);
    setPendingUrlNav(null);
  }, [pendingUrlNav, kb.activeVault?.id, kb.treeVaultId, kb.tree, kb.selectFile]);
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
  const wikiChat = useChat({
    agentId,
    cwd: kb.activeVault?.path ?? null,
    mode: 'wiki',
    vaultId: kb.activeVault?.id ?? null,
    onComplete: () => {
      kb.refreshTree();
    },
  });

  // File Q&A chat hook — independent conversation per file
  const fileChat = useFileChat({
    agentId,
    vaultPath: kb.activeVault?.path ?? null,
    filePath: fileChatFilePath,
  });

  const openFileChat = useCallback((filePath: string, selectedText?: string) => {
    setFileChatFilePath(filePath);
    setFileChatSelectedText(selectedText ?? null);
    setFileChatOpen(true);
  }, []);

  const handleAskAboutSelection = useCallback((selectedText: string) => {
    const currentFile = kb.selectedFile;
    if (currentFile) {
      openFileChat(currentFile, selectedText);
    }
  }, [kb.selectedFile, openFileChat]);

  // ─── Tab-aware file selection ───

  /** Open a file: reuse current tab if one exists, otherwise create a new tab. */
  const handleSelectFile = useCallback((path: string) => {
    const fileName = path.split('/').pop() ?? path;
    const tabId = `file:${path}`;
    const existingTab = tabs.tabs.find(t => t.id === tabId);
    if (existingTab) {
      // Already open in a tab — just activate it
      tabs.activateTab(tabId);
    } else if (tabs.tabs.length === 0) {
      // No tabs — create first one
      tabs.openTab({ id: tabId, type: 'file', title: fileName });
    } else {
      // Replace current active tab (reusing the slot)
      const activeTab = tabs.tabs.find(t => t.id === tabs.activeTabId);
      if (activeTab) {
        tabs.updateTab(activeTab.id, { id: tabId, type: 'file', title: fileName });
      } else {
        tabs.openTab({ id: tabId, type: 'file', title: fileName });
      }
    }
    kb.selectFile(path);
  }, [tabs, kb]);

  /** Open a file in a new tab (always creates a new tab). */
  const handleOpenInNewTab = useCallback((path: string) => {
    const fileName = path.split('/').pop() ?? path;
    const tabId = `file:${path}`;
    tabs.openTab({ id: tabId, type: 'file', title: fileName });
    kb.selectFile(path);
  }, [tabs, kb]);

  /** Switch to a tab and load its file */
  const handleActivateTab = useCallback((tabId: string) => {
    tabs.activateTab(tabId);
    if (tabId.startsWith('file:')) {
      const path = tabId.slice(5);
      kb.selectFile(path);
    }
  }, [tabs, kb]);

  /** Close a tab; if it was active, the store auto-activates an adjacent tab */
  const handleCloseTab = useCallback((tabId: string) => {
    const wasActive = tabs.activeTabId === tabId;
    tabs.closeTab(tabId);
    if (wasActive) {
      // After close, the store has already set a new activeTabId.
      // Sync selectedFile with the newly active tab.
      const newActive = kbTabsStore.getActiveTab();
      if (newActive && newActive.id.startsWith('file:')) {
        kb.selectFile(newActive.id.slice(5));
      } else {
        // No tabs left — clear selection
        kb.selectFile(null);
      }
    }
  }, [tabs, kb]);

  // Sync: when URL navigation resolves, open in tab
  useEffect(() => {
    if (!pendingUrlNav) return;
    if (kb.activeVault?.id !== pendingUrlNav.vaultId) return;
    if (kb.treeVaultId !== pendingUrlNav.vaultId) return;
    if (kb.tree.length === 0) return;

    handleSelectFile(pendingUrlNav.filePath);
    setPendingUrlNav(null);
  }, [pendingUrlNav, kb.activeVault?.id, kb.treeVaultId, kb.tree, handleSelectFile]);

  // Sync: on mount & vault/tab change, restore active tab's file into selectedFile.
  // This ensures that after navigating away and back, the persisted tab state
  // is reflected in useKnowledge's selectedFile so content loads and tabs work.
  useEffect(() => {
    if (!kb.activeVault) return;
    if (!tabs.activeTabId) return;
    const activeTab = tabs.tabs.find(t => t.id === tabs.activeTabId);
    if (activeTab && activeTab.id.startsWith('file:')) {
      const path = activeTab.id.slice(5);
      if (kb.selectedFile !== path) {
        kb.selectFile(path);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb.activeVault?.id, tabs.activeTabId]);

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
      wikiChat.startWikiOperation('build', '开始构建 Wiki');
    }, 50);
  }, [agentId, wikiChat]);

  const handleIngestFile = useCallback((filePath: string) => {
    if (!agentId) return;
    setShowChatPanel(true);
    wikiChat.reset();
    setTimeout(() => {
      wikiChat.startWikiOperation('ingest', `把 ${filePath} 加入 Wiki`, { filePath });
    }, 50);
  }, [agentId, wikiChat]);

  const handleLintWiki = useCallback(() => {
    if (!agentId) return;
    setShowChatPanel(true);
    wikiChat.reset();
    setTimeout(() => {
      wikiChat.startWikiOperation('lint', '检查 Wiki 健康状况');
    }, 50);
  }, [agentId, wikiChat]);

  const handleCloseChat = useCallback(() => {
    setShowChatPanel(false);
    if (wikiChat.isRunning) {
      wikiChat.cancel();
    }
  }, [wikiChat]);

  const handleCloseFileChat = useCallback(() => {
    setFileChatOpen(false);
    setFileChatSelectedText(null);
  }, []);

  // Wrap fileChat.send to prepend selected text as context
  const handleFileChatSend = useCallback((text: string) => {
    if (fileChatSelectedText) {
      const contextMsg = `关于文件中的以下选中内容：\n> ${fileChatSelectedText}\n\n${text || '请帮我分析以上选中内容。'}`;
      setFileChatSelectedText(null); // only prepend once
      fileChat.send(contextMsg);
    } else {
      fileChat.send(text);
    }
  }, [fileChatSelectedText, fileChat.send]);

  // Ctrl+L / Cmd+L — open file chat for current file
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger when focus is in an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        const activeTab = tabs.activeTabId
          ? kbTabsStore.getTabs().find(t => t.id === tabs.activeTabId)
          : null;
        if (activeTab?.id.startsWith('file:')) {
          const filePath = activeTab.id.slice(5);
          openFileChat(filePath);
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [tabs.activeTabId, openFileChat]);

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
      title: parentPath ? `在 ${parentPath} 下新建笔记` : '新建笔记',
      label: '笔记标题',
      defaultValue: '未命名笔记',
      confirmLabel: '创建',
      onConfirm: async (name) => {
        setInputDialog((prev) => ({ ...prev, show: false }));
        // Auto-append .md if user didn't include an extension
        const fileName = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
        const fullPath = `${prefix}${fileName}`;
        const title = fileName.replace(/\.md$/, '');
        const defaultContent = `# ${title}\n\n`;
        try {
          await kb.createFile(fullPath, defaultContent);
          kb.setTypesetMode(true);
        } catch (err) {
          showToast(`创建笔记失败：${err instanceof Error ? err.message : String(err)}`);
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
        onClick: () => handleSelectFile(node.path),
      });
      items.push({
        label: '在新标签页中打开',
        onClick: () => handleOpenInNewTab(node.path),
      });
      items.push({ divider: true });
      items.push({
        label: '询问此文件',
        onClick: () => {
          handleCloseCtxMenu();
          openFileChat(node.path);
        },
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

    // System actions: open in explorer + copy absolute path
    const vaultPath = kb.activeVault?.path;
    if (vaultPath) {
      const absolutePath = `${vaultPath.replace(/[\\/]+$/, '')}/${node.path}`;

      const showInFolder = window.__electron__?.showItemInFolder;
      if (showInFolder) {
        items.push({
          label: '在资源管理器中显示',
          onClick: () => showInFolder(absolutePath),
        });
      }

      items.push({
        label: '复制路径',
        onClick: () => {
          navigator.clipboard.writeText(absolutePath);
          showToast('已复制路径');
        },
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
  }, [ctxMenu, kb, showToast, handleNewFile, handleNewFolder, handleSelectFile, handleOpenInNewTab]);

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
        onSelectFile={handleSelectFile}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onVaultClick={() => kb.setShowVaultSwitcher(true)}
        onAddToWiki={hasVault ? handleIngestFile : undefined}
        onBuildWiki={hasVault ? handleBuildWiki : undefined}
        onLintWiki={hasVault && kb.wikiInitialized ? handleLintWiki : undefined}
        onContextMenu={handleContextMenu}
        renamingPath={renamingPath}
        onRenameComplete={handleRenameComplete}
        onRenameCancel={handleRenameCancel}
      >
        <div className="kb-resize-handle" onMouseDown={handleResizeStart} />
      </KbFilePanel>

      {/* Tab Bar + Main Content */}
      <div className="kb-main-wrapper">
        <KbTabBar
          tabs={tabs.tabs}
          activeTabId={tabs.activeTabId}
          onActivate={handleActivateTab}
          onClose={handleCloseTab}
        />
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
          onSave={handleSave}
          onCopy={kb.copyToClipboard}
          onPublish={kb.publishToChrome}
          onBuildWiki={handleBuildWiki}
          onAskAboutFile={openFileChat}
          onAskAboutSelection={handleAskAboutSelection}
          showFileName={true}
          isEditMode={kb.isEditMode}
          onToggleEdit={kb.toggleEditMode}
        />
      </div>

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

      {/* File Chat Panel (right side Q&A) */}
      {fileChatOpen && fileChatFilePath && (
        <FileChatPanel
          messages={fileChat.messages}
          isRunning={fileChat.isRunning}
          filePath={fileChatFilePath}
          onSend={handleFileChatSend}
          onCancel={fileChat.cancel}
          onClose={handleCloseFileChat}
          onSubmitToolResult={fileChat.onSubmitToolResult}
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
