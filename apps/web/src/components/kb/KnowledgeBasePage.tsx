/**
 * Knowledge Base page — assembles file panel, main content, wiki chat panel, and modals.
 * Now with: workspace tab system + right-click context menu + inline rename.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { TreeNode, Vault } from '@molio/contracts';
import { useKnowledge } from '../../hooks/useKnowledge';
import { useKbTabs, MAX_TABS, type WorkspaceTab } from '../../hooks/useKbTabs';
import { vaultStore } from '../../stores/vaultStore';
import { kbChatSessionsStore } from '../../stores/kbChatSessionsStore';
import { navigationHistoryStore } from '../../stores/navigationHistoryStore';
import { useAuthStatus } from '../../stores/authStore';
import { KbFilePanel, type KbFilePanelHandle } from './KbFilePanel';
import { KbTabBar } from './KbTabBar';
import { KbMainContent } from './KbMainContent';
import type { KbChatSessionsPanelHandle } from './KbChatSessionsPanel';
import { OutlinePanel } from './OutlinePanel';
import { SearchPanel } from './SearchPanel';
import { VaultManagerModal } from './VaultManager';
import { PublishForm, type PublishFormData } from '../resources/PublishForm';
import { PUBLISH_TAB_ID, GRAPH_TAB_ID } from './kb-constants';
import { GraphPage } from '../graph/GraphPage';
import { graphViewStore } from '../../stores/graphViewStore';
import { ImportModal, CoseInstallPrompt, InputDialog, ConfirmDialog } from './KbModals';
import { ImportConflictDialog } from './ImportConflictDialog';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';
import { openInNewWindow } from '../../utils/openWindow';

/** 非管理员 / 未登录点「发布到资源库」的落地页：官网联系方式（顾问个人微信二维码）。 */
const PUBLISH_CONTACT_URL = 'https://molio.cn/enterprise.html#contact';

/**
 * 在系统默认浏览器打开联系页（不在应用内跳转）。
 * Electron 桌面端由 main.js 的 setWindowOpenHandler 统一转交
 * shell.openExternal；纯浏览器环境（dev / E2E）即新标签页。
 */
function openPublishContactPage(): void {
  // 注意：不带 windowFeatures 第三参——带 'noopener' 时部分 Chromium 场景下
  // 不产生可观测的新页/外部跳转；Electron 桌面端由 setWindowOpenHandler 统一
  // 转交系统浏览器，不依赖 opener 隔离。
  window.open(PUBLISH_CONTACT_URL, '_blank');
}

interface KnowledgeBasePageProps {
  agentId: string | null;
  /** App 层持有的悬浮面板句柄（KbChatSessionsPanel 常驻 App，ref 由 App 下发） */
  chatPanelRef?: React.RefObject<KbChatSessionsPanelHandle | null>;
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

export function KnowledgeBasePage({ agentId, chatPanelRef }: KnowledgeBasePageProps) {
  const { t } = useI18n();
  const kb = useKnowledge();
  const tabs = useKbTabs(kb.activeVault?.id ?? null);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  // 方案 D：面板移出 KB 页、常驻 App 层，ref 由 App 下发。这里别名成 panelRef，
  // 下方 panelRef.current?.openQa/runWikiOp 调用点一行不改。
  const panelRef = chatPanelRef ?? useRef<KbChatSessionsPanelHandle>(null);
  const [pendingUrlNav, setPendingUrlNav] = useState<UrlFileNavigation | null>(null);
  const [showOutline, setShowOutline] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  // 发布 tab 表单是否有已填内容（PublishForm 上报）——关 tab 前的放弃确认用
  const publishDirtyRef = useRef(false);

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
  const [ctxMenu, setCtxMenu] = useState<{ node: TreeNode | null; x: number; y: number } | null>(null);

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

  // vault 切换：清空所有会话的 @文件上下文（旧库引用失效）
  useEffect(() => {
    kbChatSessionsStore.clearFilePaths();
  }, [kb.activeVault?.id]);

  // wiki 任务完成 → 刷新文件树（方案 D：onWikiComplete 改 store 事件总线，KB 页挂载时订阅）
  useEffect(() => {
    const unsub = kbChatSessionsStore.subscribeWikiComplete(() => { void kb.refreshTree(); });
    return unsub;
  }, [kb.refreshTree]);

  // Import conflict dialog state
  const [conflictDialog, setConflictDialog] = useState<{
    show: boolean;
    conflicts: Array<{ file: string }>;
  }>({ show: false, conflicts: [] });

  // Pending import files for conflict retry (replaces fragile `as any` function-property hack)
  const pendingImportRef = useRef<{ files: File[]; targetDir: string; oversizedCount: number } | null>(null);

  const handleOpenQa = useCallback(() => {
    if (!kb.selectedFile) return;
    panelRef.current?.openQa({ filePath: kb.selectedFile, vaultId: kb.activeVault?.id ?? null, selectedText: null });
  }, [kb.selectedFile, kb.activeVault?.id]);

  const handleAskAboutSelection = useCallback((selectedText: string) => {
    if (!kb.selectedFile) return;
    panelRef.current?.openQa({ filePath: kb.selectedFile, vaultId: kb.activeVault?.id ?? null, selectedText });
  }, [kb.selectedFile, kb.activeVault?.id]);

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
   * Open a file by loading it into the CURRENT tab (recycle), unless that tab
   * is pinned (exempt) or a special tab (publish) — in which case it opens in a
   * fresh tab. A file already open just activates its tab. Never grows the tab
   * count from browsing alone. Prompts before switching away from unsaved edits.
   */
  const handleSelectFile = useCallback((path: string) => {
    const action = () => {
      const fileName = path.split('/').pop() ?? path;
      const tabId = `file:${path}`;
      const existingTab = tabs.tabs.find(t => t.id === tabId);
      if (existingTab) {
        tabs.activateTab(tabId);
        kb.selectFile(path);
        return;
      }
      const activeTab = tabs.getActiveTab();
      // Recycle the active tab in place iff it is a normal (file/blank) tab and
      // not pinned. Pinned tabs keep their document; special tabs are protected.
      const recyclable = activeTab && activeTab.pinned !== true && (activeTab.type === 'file' || activeTab.type === 'blank');
      if (recyclable) {
        tabs.updateTab(activeTab.id, { id: tabId, type: 'file', title: fileName, vaultId: kb.activeVault?.id, data: undefined, pinned: false });
        kb.selectFile(path);
        return;
      }
      const res = tabs.openTab({ id: tabId, type: 'file', title: fileName, vaultId: kb.activeVault?.id });
      if (!res.opened && res.reason === 'limit') {
        showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
        return;
      }
      kb.selectFile(path);
    };
    // Limit pre-check BEFORE the discard prompt: only the open-a-new-tab path
    // can grow the count, so skip the guard when we'll recycle instead.
    const tabId = `file:${path}`;
    const existingTab = tabs.tabs.find(t => t.id === tabId);
    const activeTab = tabs.getActiveTab();
    const willGrow = !existingTab && !(activeTab && activeTab.pinned !== true && (activeTab.type === 'file' || activeTab.type === 'blank'));
    if (willGrow && tabs.tabs.length >= MAX_TABS) {
      showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
      return;
    }
    if (path === kb.selectedFile) {
      action();
      return;
    }
    runOrConfirmDiscard(action);
  }, [tabs, kb, runOrConfirmDiscard, showToast]);

  /** Explicitly open a file in a brand-new tab (tree right-click「在新标签页中打开」). */
  const handleOpenInNewTab = useCallback((path: string) => {
    const fileName = path.split('/').pop() ?? path;
    const tabId = `file:${path}`;
    if (tabs.tabs.some(t => t.id === tabId)) {
      tabs.activateTab(tabId);
      kb.selectFile(path);
      return;
    }
    if (tabs.tabs.length >= MAX_TABS) {
      showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
      return;
    }
    const res = tabs.openTab({ id: tabId, type: 'file', title: fileName, vaultId: kb.activeVault?.id });
    if (!res.opened && res.reason === 'limit') {
      showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
      return;
    }
    kb.selectFile(path);
  }, [tabs, kb, showToast]);

  /** Create and activate a fresh blank tab (tab bar "+" / right-click 新建标签页). */
  const handleAddTab = useCallback(() => {
    if (tabs.tabs.length >= MAX_TABS) {
      showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
      return;
    }
    const id = `blank:${kb.activeVault?.id ?? 'vault'}:${Math.random().toString(36).slice(2, 8)}`;
    const res = tabs.openTab({ id, type: 'blank', title: t('kb.newTab'), vaultId: kb.activeVault?.id });
    if (!res.opened && res.reason === 'limit') {
      showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
      return;
    }
    kb.selectFile(null);
  }, [tabs, kb, showToast, t]);

  /** Open the graph tab: activate it if already open (per-vault singleton via
   *  the fixed GRAPH_TAB_ID), else open it. Clicking a file from the graph is a
   *  normal file open (a graph tab is never recycled, so it stays alive). */
  const openGraphTab = useCallback(() => {
    if (tabs.tabs.some((tb) => tb.id === GRAPH_TAB_ID)) {
      tabs.activateTab(GRAPH_TAB_ID);
    } else {
      const res = tabs.openTab({ id: GRAPH_TAB_ID, type: 'graph', title: t('nav.graph'), vaultId: kb.activeVault?.id });
      if (!res.opened && res.reason === 'limit') {
        showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
      }
    }
  }, [tabs, kb, t, showToast]);

  // NavRail「图谱」入口到来：URL 带 ?panel=graph → 打开/激活图谱标签，随后去掉该参数。
  useEffect(() => {
    if (searchParams.get('panel') !== 'graph') return;
    openGraphTab();
    const next = new URLSearchParams(searchParams);
    next.delete('panel');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, openGraphTab]);

  // ─── Navigation history: tab-scoped view history ───
  // Records the order of files the user has viewed. Subscribing to activeTabId
  // keeps it in sync with every activation (open file / recycle / click a tab;
  // a back/forward re-activation dedups against the current position).
  // back/forward re-open the target file via handleSelectFile, which activates
  // an existing tab, else recycles the current one — so navigating never grows
  // the tab count, and unsaved-edit discard prompts still apply.
  const handleSelectFileRef = useRef(handleSelectFile);
  handleSelectFileRef.current = handleSelectFile;
  useEffect(() => {
    navigationHistoryStore.registerOpenFile((filePath) => {
      handleSelectFileRef.current(filePath);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const active = tabs.activeTabId;
    if (active?.startsWith('file:')) {
      navigationHistoryStore.push(active.slice(5));
    }
  }, [tabs.activeTabId]);

  /** Navigate to a file by wikilink page name — opens in a new tab. */
  const handleNavigateToFile = useCallback((pageName: string) => {
    if (!kb.tree || !kb.treeVaultId) return;
    const needle = pageName.toLowerCase();
    const found = findFileByStem(kb.tree, needle);
    if (found) {
      handleSelectFile(found);
    }
  }, [kb.tree, kb.treeVaultId, handleSelectFile]);

  /** Switch to a tab and load its file. Prompts only when actually switching
   *  to a DIFFERENT file (切到非文件 tab / 切回同一文件不弹"放弃修改"). */
  const handleActivateTab = useCallback((tabId: string) => {
    // Clicking the already-active tab is a no-op — don't prompt.
    if (tabId === tabs.activeTabId) return;
    const targetPath = tabId.startsWith('file:') ? tabId.slice(5) : null;
    const tab = tabs.tabs.find(t => t.id === tabId);
    const willSwitchFile = targetPath !== null && kb.selectedFile !== targetPath;
    const run = () => {
      tabs.activateTab(tabId);
      if (targetPath !== null) kb.selectFile(targetPath);
      else if (tab?.type === 'blank') kb.selectFile(null);
    };
    if (willSwitchFile) runOrConfirmDiscard(run);
    else run();
  }, [tabs, kb, runOrConfirmDiscard]);

  /** Toggle a tab's pinned flag (double-click / right-click menu). */
  const handleTogglePin = useCallback((id: string) => {
    tabs.togglePin(id);
  }, [tabs]);

  /** Close a tab; if it was active, the store auto-activates an adjacent tab.
   *  publish tab 有已填内容时先弹「放弃未发布的填写」确认。 */
  const handleCloseTab = useCallback((tabId: string) => {
    const wasActive = tabs.activeTabId === tabId;
    const isPublishDirty = tabId === PUBLISH_TAB_ID && publishDirtyRef.current;
    const doClose = () => {
      if (tabId === PUBLISH_TAB_ID) publishDirtyRef.current = false;
      tabs.closeTab(tabId);
      if (!wasActive) return;
      // After close, the store has already set a new activeTabId.
      // Sync selectedFile with the newly active tab.
      const newActive = tabs.getActiveTab();
      if (newActive && newActive.id.startsWith('file:')) {
        kb.selectFile(newActive.id.slice(5));
      } else {
        // No file tabs left — clear selection
        kb.selectFile(null);
      }
    };
    if (isPublishDirty) {
      setConfirmDialog({
        show: true,
        title: '放弃未发布的填写？',
        message: '发布表单有已填写的内容，关闭标签将丢弃这些内容。',
        confirmLabel: '放弃并关闭',
        danger: true,
        onConfirm: () => {
          setConfirmDialog((prev) => ({ ...prev, show: false }));
          doClose();
        },
      });
      return;
    }
    // Closing a non-active tab doesn't switch the viewed file — no prompt.
    if (!wasActive) {
      doClose();
      return;
    }
    runOrConfirmDiscard(doClose);
  }, [tabs, kb, runOrConfirmDiscard]);

  /** Open the tab's file in a new window (Electron IPC or browser popup). */
  const handleOpenInNewWindow = useCallback((tab: WorkspaceTab) => {
    const vaultId = kb.activeVault?.id;
    if (!vaultId) return;
    const filePath = tab.id.startsWith('file:') ? tab.id.slice(5) : undefined;
    const url = `/knowledge?vault=${vaultId}${filePath ? `&file=${encodeURIComponent(filePath)}` : ''}`;
    openInNewWindow(url);
  }, [kb.activeVault?.id]);

  /**
   * Obsidian-like vault opening from the vault manager (bottom-left vault bar):
   * if this window is ALREADY pinned to a vault (?vault= in the URL), picking a
   * DIFFERENT vault opens it in a NEW window — the current vault stays open,
   * not replaced. Only when the window is not URL-pinned yet (fresh /knowledge,
   * even if a vault is persisted/auto-selected) does the pick load in place.
   * Note: must key on the URL, not kb.activeVault — activeVault falls back to
   * the persisted default, which would wrongly treat a first-open as cross-vault.
   */
  const handleVaultPick = useCallback((id: string) => {
    const pinnedVaultId = new URLSearchParams(window.location.search).get('vault');
    if (pinnedVaultId && pinnedVaultId !== id) {
      kb.setShowVaultSwitcher(false);
      openInNewWindow(`/knowledge?vault=${encodeURIComponent(id)}`);
    } else {
      kb.selectVault(id);
    }
  }, [kb.selectVault, kb.setShowVaultSwitcher]);

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
    } else if (activeTab?.type === 'blank') {
      // A blank tab has no file — clear any stale selection so the content
      // pane shows the "未选择文件" empty state instead of the previous file.
      if (kb.selectedFile !== null) kb.selectFile(null);
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

  // Wiki operation handlers — 通过 panel 的 runWikiOp 入口下发（互斥/排队在 panel 内部处理）
  const handleBuildWiki = useCallback(() => {
    if (!kb.activeVault) return;
    if (!agentId) return;
    panelRef.current?.runWikiOp({ mode: 'build' });
  }, [kb.activeVault, agentId]);
  const handleLintWiki = useCallback(() => {
    if (!kb.activeVault || !kb.wikiInitialized) return;
    if (!agentId) return;
    panelRef.current?.runWikiOp({ mode: 'lint' });
  }, [kb.activeVault, kb.wikiInitialized, agentId]);
  // 发布当前知识库到资源库：打开/激活页内 publish tab（store per-vault，
  // id 固定即天然单例）。要求登录；未登录挂起登录意图，登录成功后续接打开。
  const openPublishTab = useCallback((vault: Vault) => {
    const exists = tabs.tabs.some((tb) => tb.id === PUBLISH_TAB_ID);
    if (!exists && tabs.tabs.length >= MAX_TABS) {
      showToast(`已达 ${MAX_TABS} 个标签上限，请先关闭某个标签`);
      return;
    }
    publishDirtyRef.current = false; // 重开/激活时复位，防上次残留
    tabs.openTab({ id: PUBLISH_TAB_ID, type: 'publish', title: t('publish.tabTitle'), vaultId: vault.id });
  }, [tabs, showToast, t]);

  // 发布到资源库门禁（前端拦截，后端不设门槛）：仅管理员可打开发布 tab，未登录/
  // 非管理员在系统浏览器打开官网联系页（顾问微信上架，人工审核）。管理员身份在
  // 登录态变化时预取缓存——点击必须同步判定：window.open 在异步续体里会丢用户
  // 手势、被浏览器弹窗拦截器挡住。预取未决/失败时保守按非管理员处理。
  const auth = useAuthStatus();
  const loggedIn = auth?.loggedIn === true;
  const [isMarketAdmin, setIsMarketAdmin] = useState(false);
  useEffect(() => {
    if (!loggedIn) { setIsMarketAdmin(false); return; }
    let alive = true;
    fetch('/api/market/my')
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { isAdmin?: boolean } | null) => { if (alive) setIsMarketAdmin(m?.isAdmin === true); })
      .catch(() => { if (alive) setIsMarketAdmin(false); });
    return () => { alive = false; };
  }, [loggedIn]);

  const handlePublishActive = useCallback(() => {
    const vault = kb.activeVault;
    if (!vault) return;
    if (loggedIn && isMarketAdmin) openPublishTab(vault);
    else openPublishContactPage();
  }, [kb.activeVault, loggedIn, isMarketAdmin, openPublishTab]);
  const handleIngestFile = useCallback((filePath: string, isDirectory = false) => {
    if (!agentId) return;
    panelRef.current?.runWikiOp({ mode: 'ingest', filePath, isDirectory });
  }, [agentId]);

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
        panelRef.current?.openQa({ filePath: kb.selectedFile, vaultId: kb.activeVault?.id ?? null, selectedText: null });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [kb.selectedFile, kb.activeVault?.id]);

  // Ctrl+L / Cmd+L — open file chat for current file (legacy shortcut, now opens QA)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger when focus is in an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (!kb.selectedFile) return;
        panelRef.current?.openQa({ filePath: kb.selectedFile, vaultId: kb.activeVault?.id ?? null, selectedText: null });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [kb.selectedFile, kb.activeVault?.id]);

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

  /** Right-click on the tree's blank area → root-level create menu. */
  const handleBlankContextMenu = useCallback((e: React.MouseEvent) => {
    setCtxMenu({ node: null, x: e.clientX, y: e.clientY });
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

    // Right-click on the tree's blank area → create at the vault root.
    if (node === null) {
      return [
        {
          label: '新建文件',
          testid: 'kb-ctx-new-file-root',
          onClick: () => handleNewFile(),
        },
        {
          label: '新建文件夹',
          testid: 'kb-ctx-new-folder-root',
          onClick: () => handleNewFolder(),
        },
      ];
    }

    const items: MenuItem[] = [];

    if (node.type === 'file') {
      items.push({
        label: '打开',
        onClick: () => handleSelectFile(node.path),
      });
      items.push({
        label: '在新标签页中打开',
        testid: 'kb-ctx-open-in-new-tab',
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
          panelRef.current?.openQa({ filePath: node.path, vaultId: kb.activeVault?.id ?? null, selectedText: null });
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
  }, [ctxMenu, kb, showToast, handleNewFile, handleNewFolder, handleSelectFile, handleOpenInNewTab, handleDeleteFile, handleDeleteFolder]);

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

  // 发布 tab（页内 keep-alive）：tab 存在期间 PublishForm 常驻挂载，
  // 非激活仅 CSS 隐藏 + inert，切走再切回不丢已填内容。
  const publishTabOpen = tabs.tabs.some((tb) => tb.id === PUBLISH_TAB_ID);
  const publishActive = tabs.activeTabId === PUBLISH_TAB_ID;
  const publishTabData = (tabs.tabs.find((tb) => tb.id === PUBLISH_TAB_ID)?.data ?? undefined) as PublishFormData | undefined;

  // 图谱标签页 keep-alive：标签存在期间 GraphPage 常驻挂载，非激活仅 CSS 隐藏 + inert
  // （与 publish 同款），切走再切回不丢图谱状态；隐藏时通过 active 暂停引擎省 CPU。
  const graphTabOpen = tabs.tabs.some((tb) => tb.id === GRAPH_TAB_ID);
  const graphActive = tabs.activeTabId === GRAPH_TAB_ID;

  // 让 NavRail「图谱」在 view 图谱标签时高亮；离开 KB 时复位。
  useEffect(() => {
    graphViewStore.setActive(graphActive);
    return () => graphViewStore.setActive(false);
  }, [graphActive]);

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
        onSearchChange={kb.setSearchQuery}
        onSelectFile={handleSelectFile}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onVaultClick={() => kb.setShowVaultSwitcher(true)}
        onAddToWiki={hasVault ? handleIngestFile : undefined}
        onContextMenu={handleContextMenu}
        onBlankContextMenu={handleBlankContextMenu}
        renamingPath={renamingPath}
        onRenameComplete={handleRenameComplete}
        onRenameCancel={handleRenameCancel}
        onImportFiles={handleImportFiles}
        onMoveFile={handleMoveFile}
        onPublishVault={handlePublishActive}
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
          onAddTab={handleAddTab}
          onTogglePin={handleTogglePin}
          actions={
            <>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={handleBuildWiki}
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
                onClick={handleLintWiki}
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
        <div className="kb-main-panes">
          <div
            className={`kb-pane${publishActive || graphActive ? ' kb-pane--closed' : ''}`}
            inert={publishActive || graphActive}
            aria-hidden={publishActive || graphActive || undefined}
          >
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
              onBuildWiki={handleBuildWiki}
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
          {publishTabOpen && (
            <div
              className={`kb-pane${publishActive ? '' : ' kb-pane--closed'}`}
              inert={!publishActive}
              aria-hidden={!publishActive || undefined}
            >
              <PublishForm
                variant="page"
                vaultId={kb.activeVault?.id}
                vaultName={kb.activeVault?.name ?? ''}
                onClose={() => handleCloseTab(PUBLISH_TAB_ID)}
                onPublished={() => {
                  /* 资源页目录有 60s 缓存，下次进入可见更新，此处不主动刷新 */
                }}
                onDirtyChange={(d) => { publishDirtyRef.current = d; }}
                initialData={publishTabData}
                onDataChange={(data) => {
                  tabs.updateTab(PUBLISH_TAB_ID, { data: data as unknown as Record<string, unknown> });
                }}
              />
            </div>
          )}
          {graphTabOpen && (
            <div
              className={`kb-pane${graphActive ? '' : ' kb-pane--closed'}`}
              inert={!graphActive}
              aria-hidden={!graphActive || undefined}
            >
              <GraphPage active={graphActive} />
            </div>
          )}
        </div>
      </div>

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
        onSelect={handleVaultPick}
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
