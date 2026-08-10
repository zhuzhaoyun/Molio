/**
 * Knowledge Base page — assembles file panel, main content, wiki chat panel, and modals.
 * Now with: workspace tab system + right-click context menu + inline rename.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { TreeNode } from '@molio/contracts';
import { useKnowledge } from '../../hooks/useKnowledge';
import type { KbChatState } from '../../hooks/useKbChat';
import { useKbTabs, MAX_TABS, type WorkspaceTab } from '../../hooks/useKbTabs';
import { vaultStore } from '../../stores/vaultStore';
import { KbFilePanel, type KbFilePanelHandle } from './KbFilePanel';
import { KbTabBar } from './KbTabBar';
import { KbMainContent } from './KbMainContent';
import { KbChatPanel } from './KbChatPanel';
import { OutlinePanel } from './OutlinePanel';
import { SearchPanel } from './SearchPanel';
import { VaultManagerModal } from './VaultManager';
import { ImportModal, CoseInstallPrompt, InputDialog, ConfirmDialog } from './KbModals';
import { ImportConflictDialog } from './ImportConflictDialog';
import { ContextMenu, type MenuItem } from './ContextMenu';
import type { FileRef, PastedImage } from '../ChatComposer';
import { buildAttachmentPrefix } from '../ChatComposer';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';
import { openInNewWindow } from '../../utils/openWindow';

interface KnowledgeBasePageProps {
  agentId: string | null;
  // KB Chat — owned by App for navigation persistence
  kbChat: KbChatState;
  kbChatOpen: boolean;
  onKbChatOpenChange: (open: boolean) => void;
  registerKbChatOnComplete: (fn: () => void) => void;
  onOpenConversation?: (conversationId: string) => void;
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

/** Summarize import errors into a human-readable string for toasts. */
function summarizeErrors(errors: Array<{ file: string; reason: string }>): string {
  const counts: Record<string, number> = {};
  for (const e of errors) {
    counts[e.reason] = (counts[e.reason] || 0) + 1;
  }
  const parts: string[] = [];
  if (counts['unsupported_format']) parts.push(`${counts['unsupported_format']} 个格式不支持`);
  if (counts['file_too_large']) parts.push(`${counts['file_too_large']} 个超过 50MB 限制`);
  if (counts['illegal_chars']) parts.push(`${counts['illegal_chars']} 个文件名含非法字符`);
  if (counts['protected_dir']) parts.push(`${counts['protected_dir']} 个目标为受保护目录`);
  if (counts['rename_exhausted']) parts.push(`${counts['rename_exhausted']} 个重命名失败`);
  if (parts.length === 0) parts.push(`${errors.length} 个文件无法导入`);
  return parts.join('，');
}

/** Find a tree node by its path — searches the full (unfiltered) tree so we
 *  get the real children even when ctxMenu.node came from a filtered view. */
function findNodeByPath(tree: TreeNode[], targetPath: string): TreeNode | null {
  const stack: TreeNode[] = [...tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.path === targetPath) return n;
    if (n.type === 'directory' && n.children) stack.push(...n.children);
  }
  return null;
}

/** Walk the file tree to find a file whose name or path matches `needle` (case-insensitive).
 *  Wikilinks may be bare page names (`[[腾讯程序员]]`) or path-qualified (`[[写作/案例/放弃Dify爆款拆解]]`). */
function findFileByStem(nodes: TreeNode[], needle: string): string | null {
  for (const node of nodes) {
    if (node.type === 'directory' && node.children) {
      const found = findFileByStem(node.children, needle);
      if (found) return found;
    }
    if (node.type === 'file') {
      // Match against bare filename (stem only)
      const stem = node.name.replace(/\.[^.]+$/, '');
      if (stem.toLowerCase() === needle) return node.path;
      // Match against full relative path (for path-qualified wikilinks)
      const pathStem = node.path.replace(/\.[^.]+$/, '');
      if (pathStem.toLowerCase() === needle || pathStem.toLowerCase().endsWith(`/${needle}`)) return node.path;
    }
  }
  return null;
}

/** Count recursive descendants of a directory node — files and folders separately.
 *  The node itself is not counted. */
function countDescendants(node: TreeNode): { files: number; folders: number } {
  let files = 0;
  let folders = 0;
  const walk = (n: TreeNode) => {
    if (n.type === 'file') {
      files++;
    } else {
      folders++;
      n.children?.forEach(walk);
    }
  };
  node.children?.forEach(walk);
  return { files, folders };
}

/** Build a delete-confirmation message that surfaces the concrete file/folder
 *  counts inside the folder, instead of the opaque "及其所有内容". */
function buildFolderDeleteMessage(node: TreeNode, tree: TreeNode[]): string {
  const full = findNodeByPath(tree, node.path) ?? node;
  const { files, folders } = countDescendants(full);
  if (files > 0 && folders > 0) {
    return `确定删除文件夹 "${node.name}"？将一并删除 ${files} 个文件、${folders} 个子文件夹。`;
  }
  if (files > 0) {
    return `确定删除文件夹 "${node.name}"？将一并删除 ${files} 个文件。`;
  }
  if (folders > 0) {
    return `确定删除文件夹 "${node.name}"？将一并删除 ${folders} 个子文件夹。`;
  }
  return `确定删除空文件夹 "${node.name}"？`;
}

export function KnowledgeBasePage({ agentId, kbChat, kbChatOpen, onKbChatOpenChange, registerKbChatOnComplete, onOpenConversation }: KnowledgeBasePageProps) {
  const { t } = useI18n();
  const kb = useKnowledge();
  const tabs = useKbTabs(kb.activeVault?.id ?? null);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [qaSelectedText, setQaSelectedText] = useState<string | null>(null);
  const [pendingUrlNav, setPendingUrlNav] = useState<UrlFileNavigation | null>(null);
  const [showOutline, setShowOutline] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  // URL → store: the window's ?vault= is the per-window source of truth. Fresh
  // loads are handled by vaultStore module init; this catches in-app navigation
  // that carries a vault param (graph double-click, new-window clone, protocol nav).
  useEffect(() => {
    const urlVault = searchParams.get('vault');
    if (urlVault) vaultStore.setActiveVaultId(urlVault);
  }, [searchParams, setSearchParams]);

  // External file navigation (?vault=A&file=B): open the file, keep ?vault=,
  // drop the transient ?file= (it is held in pendingUrlNav state).
  useEffect(() => {
    const nav = resolveUrlFileNavigation(searchParams, kb);
    if (!nav) return;
    setPendingUrlNav(nav);
    setSearchParams({ vault: nav.vaultId }, { replace: true });
  }, [searchParams, kb.vaults, kb.activeVault?.id, setSearchParams]);

  // Store → URL mirror: whenever this window's active vault changes (switch,
  // create, import, delete), reflect it into ?vault= so the URL stays an
  // accurate serialization of the window. Must come AFTER the file-nav effect.
  useEffect(() => {
    if (!kb.activeVault?.id) return;
    setSearchParams({ vault: kb.activeVault.id }, { replace: true });
  }, [kb.activeVault?.id, setSearchParams]);

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

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null);

  // Inline rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Save toast state
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const saveToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref to KbFilePanel for imperative "reveal path" calls (post-move locate).
  const filePanelRef = useRef<KbFilePanelHandle>(null);

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
    tertiaryLabel?: string;
    onTertiary?: () => void;
    danger?: boolean;
    onConfirm: () => void;
  }>({ show: false, title: '', message: '', onConfirm: () => {} });

  // Register onComplete callback with App so wiki builds trigger tree refresh.
  // Cleanup resets to noop when this page unmounts.
  useEffect(() => {
    registerKbChatOnComplete(() => { kb.refreshTree(); });
    return () => registerKbChatOnComplete(() => {});
  }, [kb.refreshTree, registerKbChatOnComplete]);

  // Import conflict dialog state
  const [conflictDialog, setConflictDialog] = useState<{
    show: boolean;
    conflicts: Array<{ file: string }>;
  }>({ show: false, conflicts: [] });

  // Pending import files for conflict retry (replaces fragile `as any` function-property hack)
  const pendingImportRef = useRef<{ files: File[]; targetDir: string; oversizedCount: number } | null>(null);

  const handleOpenQa = useCallback(() => {
    if (!kb.selectedFile) return;
    setQaSelectedText(null);
    kbChat.openQa();
    onKbChatOpenChange(true);
  }, [kb.selectedFile, kbChat]);

  const handleAskAboutSelection = useCallback((selectedText: string) => {
    if (!kb.selectedFile) return;
    setQaSelectedText(selectedText);
    kbChat.openQa();
    onKbChatOpenChange(true);
  }, [kb.selectedFile, kbChat]);

  // ─── Save toast helper (used by file selection and other callbacks) ───

  const showToast = useCallback((msg: string) => {
    if (saveToastTimer.current) clearTimeout(saveToastTimer.current);
    setSaveToast(msg);
    saveToastTimer.current = setTimeout(() => setSaveToast(null), 2000);
  }, []);

  // ─── Tab-aware file selection ───

  /**
   * If the current document has unsaved edits, prompt before switching files;
   * otherwise run `action` immediately. Guards tab-switch / file-open paths so
   * multi-tab navigation doesn't silently discard edits.
   */
  const runOrConfirmDiscard = useCallback((action: () => void) => {
    if (kb.editedContent === null) {
      action();
      return;
    }
    setConfirmDialog({
      show: true,
      title: '放弃未保存的修改？',
      message: '当前文档有未保存的修改，切换后将丢弃这些修改。',
      confirmLabel: '放弃修改并切换',
      danger: true,
      onConfirm: () => {
        setConfirmDialog((prev) => ({ ...prev, show: false }));
        action();
      },
    });
  }, [kb.editedContent]);

  /**
   * Open a file: activate its tab if already open, otherwise open a new tab
   * (appended to the right of existing tabs). Never overwrites an existing tab.
   * Prompts before switching away from unsaved edits.
   */
  const handleSelectFile = useCallback((path: string) => {
    const action = () => {
      const fileName = path.split('/').pop() ?? path;
      const tabId = `file:${path}`;
      const existingTab = tabs.tabs.find(t => t.id === tabId);
      if (existingTab) {
        tabs.activateTab(tabId);
      } else {
        const res = tabs.openTab({ id: tabId, type: 'file', title: fileName, vaultId: kb.activeVault?.id });
        if (!res.opened && res.reason === 'limit') {
          // Defensive: pre-check below should have caught this; never switch
          // the viewed file or discard edits when blocked.
          showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
          return;
        }
      }
      kb.selectFile(path);
    };
    // Limit pre-check BEFORE the discard prompt: avoids confirming "discard
    // edits" only to have the open blocked by the cap. Re-opening an existing
    // tab is exempt (activate != new open).
    const tabId = `file:${path}`;
    const existingTab = tabs.tabs.find(t => t.id === tabId);
    if (!existingTab && tabs.tabs.length >= MAX_TABS) {
      showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
      return;
    }
    if (path === kb.selectedFile) {
      action();
      return;
    }
    runOrConfirmDiscard(action);
  }, [tabs, kb, runOrConfirmDiscard, showToast]);

  /** Open a file in a new tab — same semantics as handleSelectFile. */
  const handleOpenInNewTab = handleSelectFile;

  /** Navigate to a file by wikilink page name — opens in a new tab. */
  const handleNavigateToFile = useCallback((pageName: string) => {
    if (!kb.tree || !kb.treeVaultId) return;
    const needle = pageName.toLowerCase();
    const found = findFileByStem(kb.tree, needle);
    if (found) {
      handleSelectFile(found);
    }
  }, [kb.tree, kb.treeVaultId, handleSelectFile]);

  /** Switch to a tab and load its file. Prompts before discarding unsaved edits. */
  const handleActivateTab = useCallback((tabId: string) => {
    // Clicking the already-active tab is a no-op — don't prompt.
    if (tabId === tabs.activeTabId) return;
    runOrConfirmDiscard(() => {
      tabs.activateTab(tabId);
      if (tabId.startsWith('file:')) {
        kb.selectFile(tabId.slice(5));
      }
    });
  }, [tabs, kb, runOrConfirmDiscard]);

  /** Close a tab; if it was active, the store auto-activates an adjacent tab. */
  const handleCloseTab = useCallback((tabId: string) => {
    const wasActive = tabs.activeTabId === tabId;
    // Closing a non-active tab doesn't switch the viewed file — no prompt.
    if (!wasActive) {
      tabs.closeTab(tabId);
      return;
    }
    runOrConfirmDiscard(() => {
      tabs.closeTab(tabId);
      // After close, the store has already set a new activeTabId.
      // Sync selectedFile with the newly active tab.
      const newActive = tabs.getActiveTab();
      if (newActive && newActive.id.startsWith('file:')) {
        kb.selectFile(newActive.id.slice(5));
      } else {
        // No tabs left — clear selection
        kb.selectFile(null);
      }
    });
  }, [tabs, kb, runOrConfirmDiscard]);

  /** Open the tab's file in a new window (Electron IPC or browser popup). */
  const handleOpenInNewWindow = useCallback((tab: WorkspaceTab) => {
    const vaultId = kb.activeVault?.id;
    if (!vaultId) return;
    const filePath = tab.id.startsWith('file:') ? tab.id.slice(5) : undefined;
    const url = `/knowledge?vault=${vaultId}${filePath ? `&file=${encodeURIComponent(filePath)}` : ''}`;
    openInNewWindow(url);
  }, [kb.activeVault?.id]);

  // When URL navigation resolves, open in tab. The path from external
  // navigation (assistant links, molio://, graph) may omit the extension and/or
  // wiki/ prefix, so ask the daemon to canonicalize it before opening — this
  // keeps tab title, tree highlighting, and "在目录中定位" consistent with
  // opening from the directory tree.
  useEffect(() => {
    if (!pendingUrlNav) return;
    if (kb.activeVault?.id !== pendingUrlNav.vaultId) return;
    if (kb.treeVaultId !== pendingUrlNav.vaultId) return;
    if (kb.tree.length === 0) return;

    const controller = new AbortController();
    const { vaultId, filePath } = pendingUrlNav;
    api.resolveFilePath(vaultId, filePath)
      .then((canonical) => {
        if (controller.signal.aborted) return;
        handleSelectFile(canonical ?? filePath);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Daemon unreachable / resolve errored — degrade to raw path (pre-fix
        // behavior for this click; file may still open via readFile fallback).
        handleSelectFile(filePath);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPendingUrlNav(null);
      });
    return () => controller.abort();
  }, [pendingUrlNav, kb.activeVault?.id, kb.treeVaultId, kb.tree, handleSelectFile]);

  // Sync: on mount & vault/tab change, restore active tab's file into selectedFile.
  // This ensures that after navigating away and back, the persisted tab state
  // is reflected in useKnowledge's selectedFile so content loads and tabs work.
  useEffect(() => {
    if (!kb.activeVault) return;
    if (!tabs.activeTabId) return;
    const activeTab = tabs.tabs.find(t => t.id === tabs.activeTabId);
    if (activeTab && activeTab.id.startsWith('file:')) {
      // Don't restore a tab that belongs to a different vault: its file path
      // likely doesn't exist in the current vault, which would surface a 404
      // (e.g. switching from vault A with `wiki/entities/墨大夫.md` open to
      // vault B that lacks that file). The vault-switch tree effect already
      // cleared selectedFile; leaving it null shows an empty state instead.
      if (activeTab.vaultId && activeTab.vaultId !== kb.activeVault.id) return;
      const path = activeTab.id.slice(5);
      if (kb.selectedFile !== path) {
        kb.selectFile(path);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb.activeVault?.id, tabs.activeTabId]);

  // Reactive safety net: close tabs whose file no longer exists in the active vault's tree.
  // Triggers on tree refresh (external deletes via VaultWatcher) and vault switches.
  useEffect(() => {
    const av = kb.activeVault;
    if (!av || kb.treeVaultId !== av.id || kb.tree.length === 0) return;
    const paths = new Set<string>();
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file') paths.add(n.path);
        if (n.children) collect(n.children);
      }
    };
    collect(kb.tree);
    const staleIds = tabs.tabs
      .filter(t => t.vaultId === av.id && t.id.startsWith('file:') && !paths.has(t.id.slice(5)))
      .map(t => t.id);
    if (staleIds.length) {
      const staleSet = new Set(staleIds);
      tabs.removeWhere(t => staleSet.has(t.id));
      if (!tabs.activeTabId) kb.selectFile(null);
    }
  }, [kb.tree, kb.treeVaultId, kb.activeVault?.id, tabs.tabs, tabs.removeWhere, kb.selectFile]);

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
  // 3-button confirm for "run a wiki op while a task is running":
  // 中断并立即执行 / 排队等当前完成 / 取消。排队走 agent stdin 原生队列。
  const confirmRunningOp = useCallback((opts: {
    title: string;
    message: string;
    onInterrupt: () => void;
    onQueue: () => void;
  }) => {
    setConfirmDialog({
      show: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: '中断并立即执行',
      tertiaryLabel: '排队等当前完成',
      danger: true,
      onConfirm: () => {
        setConfirmDialog((prev) => ({ ...prev, show: false }));
        opts.onInterrupt();
      },
      onTertiary: () => {
        setConfirmDialog((prev) => ({ ...prev, show: false }));
        opts.onQueue();
      },
    });
  }, []);

  const handleOpenWikiOp = useCallback((type: 'build' | 'lint') => {
    const interrupt = () => { kbChat.openWikiOp(type); onKbChatOpenChange(true); };
    const queue = () => { kbChat.queueWikiOp(type); onKbChatOpenChange(true); };
    if (kbChat.isRunning) {
      confirmRunningOp({
        title: '当前任务进行中',
        message: type === 'build'
          ? '构建 Wiki 会作为新任务发送。选择如何处理当前正在运行的任务：'
          : 'Wiki 健康检查会作为新任务发送。选择如何处理当前正在运行的任务：',
        onInterrupt: interrupt,
        onQueue: queue,
      });
    } else {
      interrupt();
    }
  }, [kbChat, confirmRunningOp]);

  const handleIngestFile = useCallback((filePath: string, isDirectory = false) => {
    if (!agentId) return;
    const interrupt = () => { kbChat.openIngest(filePath, isDirectory); onKbChatOpenChange(true); };
    const queue = () => { kbChat.queueIngest(filePath, isDirectory); onKbChatOpenChange(true); };
    if (kbChat.isRunning) {
      confirmRunningOp({
        title: '当前任务进行中',
        message: `把 ${filePath} 加入 Wiki 会作为新任务发送。选择如何处理当前正在运行的任务：`,
        onInterrupt: interrupt,
        onQueue: queue,
      });
    } else {
      interrupt();
    }
  }, [agentId, kbChat, confirmRunningOp]);

  const handleCloseChat = useCallback(() => {
    kbChat.close();
    onKbChatOpenChange(false);
  }, [kbChat, onKbChatOpenChange]);

  // Wrap send to prepend selected text as context for QA mode
  const handleKbChatSend = useCallback(
    (text: string, fileRefs?: FileRef[], pastedImages?: PastedImage[]) => {
      const prefix = buildAttachmentPrefix(fileRefs ?? [], pastedImages ?? []);
      let message = text;
      if (prefix) {
        message = `${prefix}\n\n${message || t('home.fileContextFallback')}`;
      }
      if (qaSelectedText) {
        message = `${t('kb.fileChatContextPrefix')}\n> ${qaSelectedText}\n\n${message || t('kb.fileChatDefaultPrompt')}`;
        setQaSelectedText(null); // only prepend once
      }
      kbChat.send(message);
    },
    [qaSelectedText, kbChat, t],
  );

  // Ctrl/Cmd+F — 打开全文搜索（仅 KB 页面）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Ctrl/Cmd+K — open KB chat in QA mode for the current file
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        if (!kb.selectedFile) return;
        setQaSelectedText(null);
        kbChat.openQa();
        onKbChatOpenChange(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [kb.selectedFile, kbChat]);

  // Ctrl+L / Cmd+L — open file chat for current file (legacy shortcut, now opens QA)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger when focus is in an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (!kb.selectedFile) return;
        setQaSelectedText(null);
        kbChat.openQa();
        onKbChatOpenChange(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [kb.selectedFile, kbChat]);

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

  const handleDeleteFile = useCallback(async (filePath: string) => {
    try {
      await kb.deleteFile(filePath);
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    tabs.closeTab(`file:${filePath}`);
  }, [kb, tabs, showToast]);

  const handleDeleteFolder = useCallback(async (folderPath: string) => {
    try {
      await kb.deleteFolder(folderPath);
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const prefix = `file:${folderPath}/`;
    tabs.removeWhere(t => t.vaultId === kb.activeVault?.id && t.id.startsWith(prefix));
  }, [kb, tabs, showToast]);

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
        label: t('kb.askAboutFile'),
        onClick: () => {
          handleCloseCtxMenu();
          if (kb.selectedFile !== node.path) {
            handleSelectFile(node.path);
          }
          setQaSelectedText(null);
          kbChat.openQa();
          onKbChatOpenChange(true);
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
              await handleDeleteFile(node.path);
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
            message: buildFolderDeleteMessage(node, kb.tree),
            confirmLabel: '删除',
            danger: true,
            onConfirm: async () => {
              setConfirmDialog((prev) => ({ ...prev, show: false }));
              await handleDeleteFolder(node.path);
            },
          });
        },
      });
    }

    return items;
  }, [ctxMenu, kb, showToast, handleNewFile, handleNewFolder, handleSelectFile, handleOpenInNewTab, handleDeleteFile, handleDeleteFolder, kbChat]);

  // ─── Inline rename ───

  const handleRenameComplete = useCallback(async (oldPath: string, newName: string) => {
    setRenamingPath(null);
    // Compute new path: same parent directory, new name
    const lastSlash = oldPath.lastIndexOf('/');
    const newPath = lastSlash >= 0 ? `${oldPath.slice(0, lastSlash + 1)}${newName}` : newName;
    if (newPath === oldPath) return;
    try {
      await kb.renameFile(oldPath, newPath);
      const newFileName = newPath.split('/').pop() ?? newPath;
      const existingTabForNewPath = tabs.tabs.find(t => t.id === `file:${newPath}`);
      if (existingTabForNewPath) tabs.closeTab(`file:${newPath}`);
      tabs.updateTab(`file:${oldPath}`, { id: `file:${newPath}`, title: newFileName, vaultId: kb.activeVault?.id });
    } catch (err) {
      showToast(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [kb.renameFile, kb.activeVault?.id, tabs, showToast]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleMoveFile = useCallback(async (srcPath: string, destDir: string) => {
    // Read active vault from the synchronous store — the React `vaults` state
    // lags one render pass behind `vaultStore.setVaults`, so `kb.activeVault`
    // can still be null immediately after vault auto-selection even though the
    // store has the vault. Reading from the store avoids the stale closure.
    const activeVault = vaultStore.getActiveVault();
    if (!activeVault) return;
    const fileName = srcPath.split('/').pop() ?? srcPath;
    // destDir === '' means vault root — don't emit a leading '/'.
    const newPath = destDir ? `${destDir}/${fileName}` : fileName;
    const srcNode = findNodeByPath(kb.tree, srcPath);
    const isDirMove = srcNode?.type === 'directory';

    // Conflict: any entry (file or folder) already at target path.
    if (findNodeByPath(kb.tree, newPath)) {
      showToast(isDirMove ? '目标位置已存在同名文件夹' : '目标位置已存在同名文件');
      return;
    }

    try {
      await kb.renameFile(srcPath, newPath);
      if (!isDirMove) {
        // Single-file move: re-point the one tab whose id matches srcPath.
        const newFileName = newPath.split('/').pop() ?? newPath;
        const existingTabForNewPath = tabs.tabs.find(t => t.id === `file:${newPath}`);
        if (existingTabForNewPath) tabs.closeTab(`file:${newPath}`);
        tabs.updateTab(`file:${srcPath}`, { id: `file:${newPath}`, title: newFileName, vaultId: activeVault.id });
      } else {
        // Directory move: re-prefix every open tab whose id sits under srcPath/.
        const oldPrefix = `file:${srcPath}/`;
        const newPrefix = `file:${newPath}/`;
        const affectedTabs = tabs.tabs.filter(
          t => t.vaultId === activeVault.id && t.id.startsWith(oldPrefix),
        );
        for (const tab of affectedTabs) {
          const suffix = tab.id.slice(oldPrefix.length);
          const newId = `${newPrefix}${suffix}`;
          // Close any pre-existing tab at the new id (e.g. user previously
          // opened the destination path) before renaming — updateTab would
          // otherwise leave two tabs sharing the same id.
          const existing = tabs.tabs.find(t => t.id === newId && t.id !== tab.id);
          if (existing) tabs.closeTab(newId);
          tabs.updateTab(tab.id, { id: newId, vaultId: activeVault.id });
        }
      }
      // After the tree refreshes, expand ancestors of the new path + scroll the
      // node into view + briefly flash it. Delay lets VaultWatcher push the
      // updated tree to the client first.
      setTimeout(() => filePanelRef.current?.revealPath(newPath), 50);
    } catch (err) {
      showToast(`移动${isDirMove ? '文件夹' : '文件'}失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [kb.tree, kb.renameFile, tabs, showToast]);

  const handleImportFiles = useCallback(async (files: File[], targetDir: string) => {
    if (!kb.activeVault) return;

    // Reject folders
    const nonFiles = Array.from(files).filter((f) => f.type === '' && f.name.indexOf('.') === -1);
    if (nonFiles.length > 0 && nonFiles.length === files.length) {
      showToast('暂不支持导入文件夹');
      return;
    }

    // Pre-flight checks — filter out files that would fail before any network request.
    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    const oversized = Array.from(files).filter((f) => f.size > MAX_FILE_SIZE);
    const validFiles = Array.from(files).filter((f) => f.size <= MAX_FILE_SIZE);
    const preflightErrors: string[] = [];
    if (oversized.length > 0) {
      preflightErrors.push(`${oversized.length} 个超过 50MB 限制`);
    }
    if (validFiles.length === 0) {
      showToast(preflightErrors.join('，'));
      return;
    }

    // Progress toast for large imports
    if (validFiles.length > 20) {
      showToast(`正在导入 ${validFiles.length} 个文件...`);
    }

    try {
      const result = await api.importFiles(kb.activeVault.id, validFiles, targetDir, 'ask');

      // Build a consolidated message from pre-flight + daemon errors
      const allErrors = [...preflightErrors];
      if (result.errors.length > 0) {
        allErrors.push(summarizeErrors(result.errors));
      }

      // Handle conflict response — conflicts field is separate from validation errors
      if (result.conflicts && result.conflicts.length > 0) {
        pendingImportRef.current = { files: validFiles, targetDir, oversizedCount: oversized.length };
        setConflictDialog({ show: true, conflicts: result.conflicts });
        if (allErrors.length > 0) {
          showToast(`${allErrors.join('，')}，请处理文件冲突`);
        }
        return;
      }

      // Refresh tree
      await kb.refreshTree();

      // Show result toast
      const imported = result.imported.length;
      const renamed = result.renamed.length;
      const skipped = result.skipped.length;

      const parts: string[] = [];
      if (imported > 0) parts.push(`${imported} 个文件`);
      if (renamed > 0) parts.push(`${renamed} 个已重命名以保留原文件`);
      if (skipped > 0) parts.push(`${skipped} 个已跳过`);
      if (allErrors.length > 0) parts.push(allErrors.join('，'));

      if (parts.length > 0) {
        showToast(`导入完成：${parts.join('，')}`);
      }
    } catch (err) {
      showToast(`导入失败：${err instanceof Error ? err.message : '无法连接到服务'}`);
    }
  }, [kb.activeVault, kb.refreshTree, showToast]);

  const handleConflictContinue = useCallback(async (strategy: 'skip' | 'replace' | 'rename') => {
    setConflictDialog({ show: false, conflicts: [] });
    const pending = pendingImportRef.current;
    if (!pending || !kb.activeVault) return;
    const { files, targetDir, oversizedCount } = pending;
    pendingImportRef.current = null; // clear after reading

    try {
      const result = await api.importFiles(kb.activeVault.id, Array.from(files), targetDir ?? '', strategy);
      await kb.refreshTree();

      const imported = result.imported.length;
      const renamed = result.renamed.length;
      const skipped = result.skipped.length;

      const parts: string[] = [];
      if (imported + renamed > 0) parts.push(`成功导入 ${imported + renamed} 个文件`);
      if (skipped > 0) {
        parts.push(strategy === 'skip' ? `${skipped} 个冲突文件已跳过` : `${skipped} 个已跳过`);
      }
      // Pre-flight errors were shown in the first toast; carry forward only oversized
      // so the user sees what happened to those files too.
      if (oversizedCount > 0) parts.push(`${oversizedCount} 个超过 50MB 限制未导入`);

      if (parts.length > 0) {
        showToast(`导入完成：${parts.join('，')}`);
      }
    } catch (err) {
      showToast(`导入失败：${err instanceof Error ? err.message : '无法连接到服务'}`);
    }
  }, [kb.activeVault, kb.refreshTree, showToast]);

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
        ref={filePanelRef}
        width={kb.panelWidth}
        tree={kb.tree}
        selectedFile={kb.selectedFile}
        searchQuery={kb.searchQuery}
        vaultName={kb.activeVault?.name ?? ''}
        vaults={kb.vaults}
        onSearchChange={kb.setSearchQuery}
        onSelectFile={handleSelectFile}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onVaultClick={() => kb.setShowVaultSwitcher(true)}
        onAddToWiki={hasVault ? handleIngestFile : undefined}
        onContextMenu={handleContextMenu}
        renamingPath={renamingPath}
        onRenameComplete={handleRenameComplete}
        onRenameCancel={handleRenameCancel}
        onImportFiles={handleImportFiles}
        onMoveFile={handleMoveFile}
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
          onOpenInNewWindow={handleOpenInNewWindow}
          actions={
            <>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => handleOpenWikiOp('build')}
                disabled={!kb.activeVault}
                title={kb.activeVault ? t('kb.buildWiki') : t('kb.cmdNeedsVault')}
                data-testid="kb-btn-build-wiki"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => handleOpenWikiOp('lint')}
                disabled={!kb.activeVault || !kb.wikiInitialized}
                title={kb.activeVault && kb.wikiInitialized ? t('kb.lintWiki') : t('kb.cmdNeedsVault')}
                data-testid="kb-btn-lint-wiki"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => setShowSearch(true)}
                title={`${t('kb.moreMenuSearch')} (Ctrl/Cmd+F)`}
                data-testid="kb-btn-search"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
            </>
          }
        />
        <KbMainContent
          fileContent={kb.fileContent}
          selectedFile={kb.selectedFile}
          fileLoadError={kb.fileLoadError}
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
          onBuildWiki={() => handleOpenWikiOp('build')}
          onAskAboutSelection={handleAskAboutSelection}
          onOpenOutline={() => setShowOutline(true)}
          onAskAboutFile={kb.selectedFile ? handleOpenQa : undefined}
          showFileName={true}
          isEditMode={kb.isEditMode}
          onToggleEdit={kb.toggleEditMode}
          onForceLoad={kb.forceLoadFile}
          onCloseTab={() => {
            if (tabs.activeTabId) handleCloseTab(tabs.activeTabId);
          }}
          onNavigateToFile={handleNavigateToFile}
        />
      </div>

      {/* Unified KB Chat Panel (right side) */}
      {kbChatOpen && (
        <KbChatPanel
          composerKey="kb"
          mode={kbChat.mode}
          messages={kbChat.messages}
          isRunning={kbChat.isRunning}
          activity={kbChat.activity}
          filePath={kbChat.mode === 'qa' ? kb.selectedFile : null}
          vaultId={kb.activeVault?.id ?? null}
          selectedText={qaSelectedText}
          onSend={handleKbChatSend}
          onCancel={kbChat.cancel}
          onClose={handleCloseChat}
          onSubmitToolResult={kbChat.submitToolResult}
          onOpenConversation={onOpenConversation}
        />
      )}

      {/* Outline Panel */}
      {showOutline && (
        <OutlinePanel
          content={kb.fileContent?.content ?? ''}
          onClose={() => setShowOutline(false)}
        />
      )}

      {/* Full-text Search Panel */}
      {showSearch && kb.activeVault?.id && (
        <SearchPanel
          vaultId={kb.activeVault.id}
          onOpenFile={(p) => {
            setShowSearch(false);
            handleSelectFile(p);
          }}
          onClose={() => setShowSearch(false)}
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
        vaultId={kb.activeVault?.id ?? ''}
        onClose={() => kb.setShowImport(false)}
        onImportComplete={(result, importFiles, targetDir, oversizedCount = 0) => {
          kb.refreshTree();

          // Build pre-flight errors so they can be merged into toasts
          const preflightErrors: string[] = [];
          if (oversizedCount > 0) preflightErrors.push(`${oversizedCount} 个超过 50MB 限制`);

          // Check for conflicts — uses separate conflicts field (not mixed with errors)
          if (result.conflicts && result.conflicts.length > 0) {
            pendingImportRef.current = { files: importFiles, targetDir, oversizedCount };
            setConflictDialog({ show: true, conflicts: result.conflicts });
            const allErrors = [...preflightErrors];
            if (result.errors.length > 0) allErrors.push(summarizeErrors(result.errors));
            if (allErrors.length > 0) {
              showToast(`${allErrors.join('，')}，请处理文件冲突`);
            }
            return;
          }

          const imported = result.imported.length;
          const renamed = result.renamed.length;
          const skipped = result.skipped.length;
          const parts: string[] = [];
          if (imported + renamed > 0) parts.push(`成功导入 ${imported + renamed} 个文件`);
          if (skipped > 0) parts.push(`${skipped} 个已跳过`);
          if (preflightErrors.length > 0) parts.push(preflightErrors.join('，'));
          if (result.errors.length > 0) parts.push(summarizeErrors(result.errors));
          if (parts.length > 0) {
            showToast(`导入完成：${parts.join('，')}`);
          }
        }}
      />

      {/* Import conflict dialog */}
      <ImportConflictDialog
        show={conflictDialog.show}
        conflicts={conflictDialog.conflicts}
        onCancel={() => { setConflictDialog({ show: false, conflicts: [] }); pendingImportRef.current = null; }}
        onContinue={handleConflictContinue}
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
        <div className="kb-save-toast" data-testid="kb-notice">{saveToast}</div>
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
        tertiaryLabel={confirmDialog.tertiaryLabel}
        onTertiary={confirmDialog.onTertiary}
        danger={confirmDialog.danger}
        onConfirm={confirmDialog.onConfirm}
        onCancel={handleCancelConfirmDialog}
      />
    </div>
  );
}
