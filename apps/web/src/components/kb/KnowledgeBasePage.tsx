/**
 * Knowledge Base page — assembles file panel, main content, wiki chat panel, and modals.
 * Now with: workspace tab system + right-click context menu + inline rename.
 */

import { useCallback, useRef, useState, useMemo, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useKnowledge } from '../../hooks/useKnowledge';
import { useWikiChat } from '../../hooks/useWikiChat';
import { useKbTabs } from '../../hooks/useKbTabs';
import { KbFilePanel } from './KbFilePanel';
import { KbMainContent } from './KbMainContent';
import { WikiChatPanel } from './WikiChatPanel';
import { VaultManagerModal } from './VaultManager';
import { ImportModal, CoseInstallPrompt } from './KbModals';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { KbTabBar } from './KbTabBar';
import { api } from '../../api/client';
import type { TreeNode } from '@molio/contracts';
import { createPortal } from 'react-dom';

interface KnowledgeBasePageProps {
  agentId: string | null;
}

export function KnowledgeBasePage({ agentId }: KnowledgeBasePageProps) {
  const kb = useKnowledge();
  const tabs = useKbTabs();
  const location = useLocation();
  const [showChatPanel, setShowChatPanel] = useState(false);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null);

  // Inline rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Auto-save timer ref
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Is Electron?
  const isElectron = !!window.__electron__;

  // Active tab drives selectedFile
  const activeTab = tabs.getActiveTab();
  const activeFilePath = activeTab?.type === 'file' ? (activeTab.data?.path as string) : null;
  const isEditMode = activeTab?.type === 'file' ? !!activeTab.data?.isEditMode : false;
  const selectedFile = activeFilePath ?? kb.selectedFile;

  // Close all tabs when vault changes (tabs are vault-specific)
  const prevVaultIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentVaultId = kb.activeVault?.id ?? null;
    if (prevVaultIdRef.current !== null && prevVaultIdRef.current !== currentVaultId) {
      // Vault switched — close all tabs
      tabs.tabs.forEach((t) => tabs.closeTab(t.id));
    }
    prevVaultIdRef.current = currentVaultId;
  }, [kb.activeVault?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync active tab path → kb.selectedFile so useKnowledge loads file content.
  // This fires on openTab, activateTab, and tab close (when activeTabId changes).
  useEffect(() => {
    if (activeFilePath && activeFilePath !== kb.selectedFile) {
      kb.selectFile(activeFilePath);
    }
  }, [activeFilePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle openFile navigation state (from GraphPage node click)
  useEffect(() => {
    const state = location.state as { openFile?: string } | null;
    if (state?.openFile && kb.activeVault) {
      const filePath = state.openFile;
      const tabId = `file:${filePath}`;
      // Only open if it's not already a tab
      if (!tabs.tabs.some((t) => t.id === tabId)) {
        const name = filePath.split('/').pop() || filePath;
        tabs.openTab({
          type: 'file',
          title: name,
          data: { path: filePath, vaultId: kb.activeVault.id },
          id: tabId,
        });
      } else {
        tabs.activateTab(tabId);
      }
      // Clear state so it doesn't re-trigger
      window.history.replaceState({}, '', '/knowledge');
    }
  }, [location.state, kb.activeVault]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ─── Right-click context menu ───

  const handleContextMenu = useCallback((node: TreeNode, event: React.MouseEvent) => {
    setCtxMenu({ node, x: event.clientX, y: event.clientY });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const contextMenuItems = useMemo<MenuItem[]>(() => {
    if (!ctxMenu) return [];
    const node = ctxMenu.node;
    const vault = kb.activeVault;
    const absPath = vault ? `${vault.path.replace(/[\\/]+$/, '')}/${node.path}` : '';

    const items: MenuItem[] = [
      {
        label: '在新标签页中打开',
        icon: '📑',
        onClick: () => {
          tabs.openTab({
            type: 'file',
            title: node.name,
            data: { path: node.path, vaultId: vault?.id },
            id: `file:${node.path}`,
          });
        },
      },
      {
        label: '复制路径',
        icon: '📋',
        onClick: () => {
          // 复制绝对路径
          const absolutePath = vault ? `${vault.path.replace(/[\\/]+$/, '')}/${node.path}` : node.path;
          navigator.clipboard.writeText(absolutePath);
        },
      },
    ];

    if (isElectron) {
      items.push(
        {
          label: '用外部程序打开',
          icon: '🔗',
          onClick: () => {
            if (absPath) window.__electron__!.openPath(absPath);
          },
        },
        {
          label: '在资源管理器中显示',
          icon: '📁',
          onClick: () => {
            if (absPath) window.__electron__!.showItemInFolder(absPath);
          },
        },
        {
          label: '重命名',
          icon: '✏️',
          onClick: () => {
            setRenamingPath(node.path);
            setRenameValue(node.name);
          },
        },
        {
          label: '删除',
          icon: '🗑️',
          danger: true,
          onClick: async () => {
            if (!vault) return;
            if (!confirm(`确定要删除 "${node.name}" 吗？`)) return;
            try {
              await api.deleteFile(vault.id, node.path);
              // Close tab if open
              const tabId = `file:${node.path}`;
              if (tabs.tabs.some((t) => t.id === tabId)) {
                tabs.closeTab(tabId);
              }
              kb.refreshTree();
            } catch (err) {
              console.error('Delete failed:', err);
            }
          },
        }
      );
    }

    return items;
  }, [ctxMenu, kb.activeVault, isElectron, tabs]);

  // ─── Rename handlers ───

  const handleRenameSubmit = useCallback(async (oldPath: string, newName: string) => {
    if (!newName || newName === oldPath.split('/').pop()) {
      setRenamingPath(null);
      return;
    }

    const vault = kb.activeVault;
    if (!vault) {
      setRenamingPath(null);
      return;
    }

    const dir = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/') + 1) : '';
    const newPath = dir + newName;
    const oldAbs = `${vault.path.replace(/[\\/]+$/, '')}/${oldPath}`;
    const newAbs = `${vault.path.replace(/[\\/]+$/, '')}/${newPath}`;

    if (isElectron) {
      try {
        await window.__electron__!.renameFile(oldAbs, newAbs);
        // 更新 tab
        const oldTabId = `file:${oldPath}`;
        if (tabs.tabs.some((t) => t.id === oldTabId)) {
          tabs.updateTab(oldTabId, { id: `file:${newPath}`, title: newName });
        }
        kb.refreshTree();
      } catch (err) {
        alert(`重命名失败: ${err instanceof Error ? err.message : '未知错误'}`);
      }
    }

    setRenamingPath(null);
  }, [kb.activeVault, isElectron, tabs, kb.refreshTree]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // ─── Auto-save on content change ───

  const handleContentChange = useCallback((content: string) => {
    // Update edited content state immediately
    kb.setEditedContent(content);

    // Debounced auto-save to local file (500ms delay)
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(async () => {
      const vault = kb.activeVault;
      const filePath = selectedFile;
      if (vault && filePath) {
        try {
          await api.writeFile(vault.id, filePath, content);
        } catch (err) {
          console.error('Auto-save failed:', err);
        }
      }
    }, 500);
  }, [kb.setEditedContent, kb.activeVault, selectedFile]);

  // Cleanup timer on file switch or unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [selectedFile]);

  // ─── Tab activation handler ───

  const handleActivateTab = useCallback((tabId: string) => {
    tabs.activateTab(tabId);
    // kb.selectFile sync is handled by the activeFilePath useEffect above
  }, [tabs]);

  // ─── Left-click file handler ───

  /** Find a file's display name from the tree */
  const findFileName = useCallback((nodes: typeof kb.tree, target: string): string | null => {
    for (const node of nodes) {
      if (node.path === target) return node.name;
      if (node.children) {
        const found = findFileName(node.children, target);
        if (found) return found;
      }
    }
    return null;
  }, [kb.tree]);

  const handleSelectFile = useCallback((path: string) => {
    const tabId = `file:${path}`;
    const existingTab = tabs.tabs.find((t) => t.id === tabId);

    if (existingTab) {
      // Tab already exists — just activate it
      tabs.activateTab(tabId);
    } else {
      // Create new tab
      const name = findFileName(kb.tree, path) || path.split('/').pop() || path;
      tabs.openTab({
        type: 'file',
        title: name,
        data: { path, vaultId: kb.activeVault?.id },
        id: tabId,
      });
    }
    // activeFilePath useEffect will sync kb.selectFile automatically
  }, [tabs, kb.activeVault, kb.tree, findFileName]);

  const hasVault = !!kb.activeVault;

  return (
    <div className="kb-shell">
      {/* File Panel */}
      <KbFilePanel
        width={kb.panelWidth}
        tree={kb.tree}
        selectedFile={selectedFile}
        searchQuery={kb.searchQuery}
        vaultName={kb.activeVault?.name ?? ''}
        onSearchChange={kb.setSearchQuery}
        onSelectFile={handleSelectFile}
        onNewFile={() => {/* TODO: new file flow */}}
        onNewFolder={() => {/* TODO: new folder flow */}}
        onVaultClick={() => kb.setShowVaultSwitcher(true)}
        onAddToWiki={hasVault ? handleIngestFile : undefined}
        onBuildWiki={hasVault && !kb.wikiInitialized ? handleBuildWiki : undefined}
        onLintWiki={hasVault && kb.wikiInitialized ? handleLintWiki : undefined}
        onContextMenu={handleContextMenu}
        renamingPath={renamingPath}
        renameValue={renameValue}
        onRenameChange={setRenameValue}
        onRenameSubmit={handleRenameSubmit}
        onRenameCancel={handleRenameCancel}
      >
        <div className="kb-resize-handle" onMouseDown={handleResizeStart} />
      </KbFilePanel>

      {/* Main Content */}
      <div className="kb-content-wrapper">
        {/* Workspace Tab Bar */}
        <KbTabBar
          tabs={tabs.tabs}
          activeTabId={tabs.activeTabId}
          onActivate={handleActivateTab}
          onClose={tabs.closeTab}
        />

        <KbMainContent
          fileContent={kb.fileContent}
          selectedFile={selectedFile}
          vaultId={kb.activeVault?.id ?? null}
          vaultPath={kb.activeVault?.path ?? null}
          isTypesetMode={kb.isTypesetMode}
          themeConfig={kb.themeConfig}
          wikiInitialized={kb.wikiInitialized}
          onToggleTypeset={kb.toggleTypesetMode}
          onThemeConfigChange={kb.setThemeConfig}
          onContentChange={handleContentChange}
          onCopy={kb.copyToClipboard}
          onPublish={kb.publishToChrome}
          onBuildWiki={handleBuildWiki}
          showFileName={tabs.tabs.length === 0}
          isEditMode={isEditMode}
          onToggleEdit={() => {
            if (activeTab) {
              tabs.updateTab(activeTab.id, {
                data: { ...activeTab.data, isEditMode: !isEditMode },
              });
            }
          }}
          editedContent={kb.editedContent}
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

      {/* Context Menu */}
      {ctxMenu &&
        createPortal(
          <ContextMenu items={contextMenuItems} position={{ x: ctxMenu.x, y: ctxMenu.y }} onClose={handleCloseContextMenu} />,
          document.body
        )}
    </div>
  );
}
