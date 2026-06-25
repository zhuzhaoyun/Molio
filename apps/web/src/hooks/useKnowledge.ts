/**
 * Knowledge Base state management hook.
 * Manages vaults, file tree, file content, and UI state.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { Vault, TreeNode, FileContent, KbHistoryEntry } from '@molio/contracts';
import { api } from '../api/client';
import type { ThemeConfig } from '../components/kb/MdStylePanel';
import { defaultThemeConfig } from '../components/kb/MdStylePanel';
import { copyHtml } from '@molio/doocs-md/shared/utils/clipboard';
import { vaultStore, useActiveVaultId } from '../stores/vaultStore';

const FILE_LOAD_RETRY_MS = 600;

/* [MOLIO] Convert ![[...]] wiki embed syntax to standard markdown image syntax */
export function preprocessWikiEmbeds(markdown: string, vaultId: string): string {
  // ![[image.png|300x200]] → ![image.png|300x200](raw-url)
  return markdown.replace(
    /!\[\[([^\]|]+)(?:\|(\d+)(?:x(\d+))?)?\]\]/g,
    (_m, file: string, w?: string, h?: string) => {
      const size = w ? (h ? `|${w}x${h}` : `|${w}`) : '';
      const encoded = encodeURIComponent(file.trim());
      const baseUrl = window.location.origin;
      return `![${file}${size}](${baseUrl}/api/knowledge/vaults/${vaultId}/raw/${encoded})`;
    },
  );
}

/* [MOLIO] Route external images/videos from anti-hotlinking hosts through daemon proxy */
export function proxyExternalImages(markdown: string): string {
  const proxyBase = `${window.location.origin}/api/proxy/image?url=`;

  function cleanAndEncode(rawUrl: string): string {
    // Decode HTML entities (&amp; → &) before encoding for the proxy
    const decoded = rawUrl.replace(/&amp;/g, '&');
    return encodeURIComponent(decoded);
  }

  // Markdown images: ![alt](url) on proxied hosts
  let result = markdown.replace(
    /!\[([^\]]*)\]\((https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|mpvideo\.qpic\.cn)[^)]+)\)/g,
    (_m, alt: string, url: string) =>
      `![${alt}](${proxyBase}${cleanAndEncode(url)})`,
  );

  // Raw HTML <video src="..."> or <source src="...">
  result = result.replace(
    /(<(?:video|source)\s[^>]*?)src="(https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|mpvideo\.qpic\.cn)[^"]*)"/g,
    (_m, prefix: string, url: string) =>
      `${prefix}src="${proxyBase}${cleanAndEncode(url)}"`,
  );

  return result;
}

/* [MOLIO] Strip WeChat tracking pixels (1×1 transparent SVG data URIs) */
export function stripTrackingPixels(markdown: string): string {
  return markdown.replace(
    /!\[[^\]]*\]\(data:image\/svg\+xml,[^)]*1px[^)]*\)/g,
    '',
  );
}

interface UseKnowledgeReturn {
  // Data
  vaults: Vault[];
  activeVault: Vault | null;
  treeVaultId: string | null;
  tree: TreeNode[];
  selectedFile: string | null;
  fileContent: FileContent | null;
  fileLoadError: string | null;
  history: KbHistoryEntry[];

  // UI state
  panelWidth: number;
  searchQuery: string;
  loading: boolean;

  // Wiki state
  wikiInitialized: boolean;

  // Typeset mode state
  isTypesetMode: boolean;
  themeConfig: ThemeConfig;
  editedContent: string | null;

  // Edit mode state
  isEditMode: boolean;

  // Modals
  showVaultSwitcher: boolean;
  showAddVault: boolean;
  showImport: boolean;
  showCoseInstallPrompt: boolean;

  // Actions
  selectVault: (id: string) => void;
  createVault: (name: string, path: string, description?: string) => Promise<void>;
  openVault: (path: string) => Promise<void>;
  deleteVault: (id: string) => Promise<void>;
  selectFile: (path: string | null) => void;
  refreshTree: () => void;
  checkWikiStatus: () => void;
  setPanelWidth: (w: number) => void;
  setSearchQuery: (q: string) => void;
  setShowVaultSwitcher: (show: boolean) => void;
  setShowAddVault: (show: boolean) => void;
  setShowImport: (show: boolean) => void;

  // File operations
  createFile: (relPath: string, content?: string) => Promise<void>;
  createFolder: (relPath: string) => Promise<void>;
  deleteFile: (relPath: string) => Promise<void>;
  deleteFolder: (relPath: string) => Promise<void>;
  renameFile: (oldPath: string, newPath: string) => Promise<void>;
  saveFile: (relPath: string, content: string) => Promise<void>;

  // Typeset actions
  toggleTypesetMode: () => void;
  setTypesetMode: (on: boolean) => void;
  setThemeConfig: (config: ThemeConfig) => void;
  setEditedContent: (content: string) => void;
  copyToClipboard: () => Promise<void>;
  publishToChrome: () => Promise<void>;
  setShowCoseInstallPrompt: (show: boolean) => void;

  // Edit mode actions
  toggleEditMode: () => void;
  setEditMode: (on: boolean) => void;
}

export function useKnowledge(): UseKnowledgeReturn {
  const [vaults, setVaults] = useState<Vault[]>([]);
  // Read active vault ID from the shared store so App.tsx stays in sync.
  const activeVaultId = useActiveVaultId();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeVaultId, setTreeVaultId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<KbHistoryEntry[]>([]);
  const [panelWidth, setPanelWidth] = useState(260);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);

  // Modals
  const [showVaultSwitcher, setShowVaultSwitcher] = useState(false);
  const [showAddVault, setShowAddVault] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCoseInstallPrompt, setShowCoseInstallPrompt] = useState(false);

  // Typeset mode state
  const [isTypesetMode, setIsTypesetMode] = useState(false);
  const [themeConfig, setThemeConfig] = useState<ThemeConfig>(defaultThemeConfig);
  const [editedContent, setEditedContent] = useState<string | null>(null);

  // Edit mode state
  const [isEditMode, setIsEditMode] = useState(false);

  // Wiki state
  const [wikiInitialized, setWikiInitialized] = useState(false);
  const fileLoadRetryRef = useRef<{ key: string; timer: ReturnType<typeof setTimeout> | null }>({ key: '', timer: null });

  const clearFileLoadRetry = useCallback(() => {
    if (fileLoadRetryRef.current.timer) {
      clearTimeout(fileLoadRetryRef.current.timer);
      fileLoadRetryRef.current.timer = null;
    }
  }, []);

  const scheduleFileLoadRetry = useCallback((vaultId: string, filePath: string, requestKey: string) => {
    if (fileLoadRetryRef.current.key === requestKey) return;
    fileLoadRetryRef.current.key = requestKey;
    fileLoadRetryRef.current.timer = setTimeout(() => {
      fileLoadRetryRef.current.timer = null;
      api.readFile(vaultId, filePath)
        .then((content) => setFileContent(content))
        .catch(() => {});
    }, FILE_LOAD_RETRY_MS);
  }, []);


  // Load vaults on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listVaults();
        if (cancelled) return;
        setVaults(list);
        vaultStore.setVaults(list); // shared store handles auto-selection
      } catch {
        // No vaults yet — fine
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Track previous vault ID to distinguish mount vs vault switch
  const prevVaultIdRef = useRef<string | null>(null);

  // Load tree when vault changes
  useEffect(() => {
    if (!activeVaultId) return;
    const isVaultSwitch = prevVaultIdRef.current !== null && prevVaultIdRef.current !== activeVaultId;
    prevVaultIdRef.current = activeVaultId;

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setTree([]);
        setTreeVaultId(null);
        const t = await api.getFileTree(activeVaultId);
        if (!cancelled) {
          setTree(t);
          setTreeVaultId(activeVaultId);
          // Only clear selection on explicit vault switch, not on mount/remount
          // (tab restore sets selectedFile via KnowledgeBasePage useEffect)
          if (isVaultSwitch) {
            setSelectedFile(null);
            setFileContent(null);
          }
        }
      } catch {
        if (!cancelled) {
          setTree([]);
          setTreeVaultId(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeVaultId]);

  // Check wiki status when vault changes
  useEffect(() => {
    if (!activeVaultId) {
      setWikiInitialized(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const status = await api.getWikiStatus(activeVaultId);
        if (!cancelled) setWikiInitialized(status.initialized);
      } catch {
        if (!cancelled) setWikiInitialized(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeVaultId]);

  // Refresh tree when window regains focus (detects external file changes)
  useEffect(() => {
    if (!activeVaultId) return;

    let lastFocusTime = Date.now();
    const MIN_INTERVAL = 1000; // Prevent rapid refreshes

    const handleFocus = async () => {
      const now = Date.now();
      if (now - lastFocusTime < MIN_INTERVAL) return;
      lastFocusTime = now;

      try {
        const t = await api.getFileTree(activeVaultId);
        setTree(t);
        setTreeVaultId(activeVaultId);
      } catch {
        // Ignore refresh errors
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [activeVaultId]);

  // Load file content when file selected
  useEffect(() => {
    if (!activeVaultId || !selectedFile) return;
    // Reset edited content and error when switching files
    setEditedContent(null);
    setFileLoadError(null);
    let cancelled = false;
    const requestKey = `${activeVaultId}:${selectedFile}`;

    clearFileLoadRetry();

    (async () => {
      try {
        const content = await api.readFile(activeVaultId, selectedFile);
        if (!cancelled) {
          setFileContent(content);
          setFileLoadError(null);
        }
      } catch (err) {
        if (cancelled) return;
        const is404 = err instanceof Error && err.message.includes('404');
        if (is404) {
          setFileContent(null);
          setFileLoadError(`文件未找到：${selectedFile}`);
        } else {
          setFileContent(null);
          scheduleFileLoadRetry(activeVaultId, selectedFile, requestKey);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeVaultId, selectedFile, clearFileLoadRetry, scheduleFileLoadRetry]);

  // Load history when vault changes
  useEffect(() => {
    if (!activeVaultId) return;
    let cancelled = false;
    (async () => {
      try {
        const h = await api.getKbHistory(activeVaultId);
        if (!cancelled) setHistory(h);
      } catch {
        if (!cancelled) setHistory([]);
      }
    })();
    return () => { cancelled = true; };
  }, [activeVaultId]);

  const activeVault = vaults.find((v) => v.id === activeVaultId) ?? null;

  const selectVault = useCallback((id: string) => {
    vaultStore.setActiveVaultId(id);
    setShowVaultSwitcher(false);
  }, []);

  const createVault = useCallback(async (name: string, path: string, description?: string) => {
    const vault = await api.createVault({ name, path, description });
    setVaults((prev) => {
      const next = [vault, ...prev];
      vaultStore.setVaults(next);
      return next;
    });
    vaultStore.setActiveVaultId(vault.id);
    setShowAddVault(false);
  }, []);

  const openVault = useCallback(async (path: string) => {
    // Derive a name from the last path segment
    const name = path.split(/[\/]/).pop() || '未命名仓库';
    const vault = await api.createVault({ name, path, description: `从本地文件夹打开: ${path}` });
    setVaults((prev) => {
      const next = [vault, ...prev];
      vaultStore.setVaults(next);
      return next;
    });
    vaultStore.setActiveVaultId(vault.id);
  }, []);

  const deleteVault = useCallback(async (id: string) => {
    await api.deleteVault(id);
    setVaults((prev) => {
      const next = prev.filter((v) => v.id !== id);
      vaultStore.setVaults(next);
      return next;
    });
    if (activeVaultId === id) {
      vaultStore.setActiveVaultId(null);
      setTree([]);
      setTreeVaultId(null);
      setSelectedFile(null);
      setFileContent(null);
    }
  }, [activeVaultId]);

  const selectFile = useCallback((path: string | null) => {
    setSelectedFile(path);
    // Reset edit mode when switching files
    setIsEditMode(false);
  }, []);

  const refreshTree = useCallback(() => {
    if (!activeVaultId) return;
    api.getFileTree(activeVaultId)
      .then((t) => {
        setTree(t);
        setTreeVaultId(activeVaultId);
      })
      .catch(() => {});
    // Re-check wiki status after tree refresh (build may have created INDEX.md)
    api.getWikiStatus(activeVaultId)
      .then((s) => setWikiInitialized(s.initialized))
      .catch(() => {});
  }, [activeVaultId]);

  const checkWikiStatus = useCallback(() => {
    if (!activeVaultId) return;
    api.getWikiStatus(activeVaultId)
      .then((s) => setWikiInitialized(s.initialized))
      .catch(() => {});
  }, [activeVaultId]);

  // File operations
  const createFile = useCallback(async (relPath: string, content = '') => {
    if (!activeVaultId) return;
    await api.writeFile(activeVaultId, relPath, content);
    // Refresh tree and select the new file
    const t = await api.getFileTree(activeVaultId);
    setTree(t);
    setSelectedFile(relPath);
  }, [activeVaultId]);

  const createFolder = useCallback(async (relPath: string) => {
    if (!activeVaultId) return;
    await api.createDirectory(activeVaultId, relPath);
    const t = await api.getFileTree(activeVaultId);
    setTree(t);
  }, [activeVaultId]);

  const deleteFile = useCallback(async (relPath: string) => {
    if (!activeVaultId) return;
    await api.deleteFile(activeVaultId, relPath);
    // If the deleted file is currently selected, clear it
    if (selectedFile === relPath) {
      setSelectedFile(null);
      setFileContent(null);
    }
    const t = await api.getFileTree(activeVaultId);
    setTree(t);
  }, [activeVaultId, selectedFile]);

  const deleteFolder = useCallback(async (relPath: string) => {
    if (!activeVaultId) return;
    await api.deleteDirectory(activeVaultId, relPath);
    // If the selected file is inside the deleted folder, clear it
    if (selectedFile && (selectedFile === relPath || selectedFile.startsWith(relPath + '/'))) {
      setSelectedFile(null);
      setFileContent(null);
    }
    const t = await api.getFileTree(activeVaultId);
    setTree(t);
  }, [activeVaultId, selectedFile]);

  const renameFile = useCallback(async (oldPath: string, newPath: string) => {
    if (!activeVaultId) return;
    await api.renameFile(activeVaultId, oldPath, newPath);
    // If the renamed file is currently selected, update selection
    if (selectedFile === oldPath) {
      setSelectedFile(newPath);
    }
    const t = await api.getFileTree(activeVaultId);
    setTree(t);
  }, [activeVaultId, selectedFile]);

  const saveFile = useCallback(async (relPath: string, content: string) => {
    if (!activeVaultId) return;
    await api.writeFile(activeVaultId, relPath, content);
    // Update the cached fileContent to reflect the saved state
    setFileContent((prev) => prev && prev.path === relPath
      ? { ...prev, content, modifiedAt: Date.now() }
      : prev);
    // Also clear the editedContent marker so the UI knows we're in sync
    setEditedContent(null);
  }, [activeVaultId]);

  // Typeset mode actions
  const toggleTypesetMode = useCallback(() => {
    setIsTypesetMode((prev) => !prev);
  }, []);

  const setTypesetMode = useCallback((on: boolean) => {
    setIsTypesetMode(on);
    if (!on) {
      // When exiting typeset mode, clear the edited content marker
      setEditedContent(null);
    }
  }, []);

  const handleEditedContentChange = useCallback((content: string) => {
    setEditedContent(content);
  }, []);

  const toggleEditMode = useCallback(() => {
    setIsEditMode((prev) => !prev);
  }, []);

  const setEditMode = useCallback((on: boolean) => {
    setIsEditMode(on);
  }, []);

  const copyToClipboard = useCallback(async () => {
    const markdownSource = editedContent ?? fileContent?.content ?? '';
    if (!markdownSource) return;

    // Get the rendered HTML from the preview container (#output)
    const outputEl = document.querySelector('#output');
    const html = outputEl?.innerHTML ?? '';

    if (html) {
      // Copy rich HTML + plain text fallback (for WeChat/paste targets)
      await copyHtml(html, markdownSource);
    } else {
      // Fallback: plain text only (no preview rendered yet)
      await copyHtml('', markdownSource);
    }
  }, [editedContent, fileContent]);

  const publishToChrome = useCallback(async () => {
    const markdownSource = editedContent ?? fileContent?.content ?? '';
    if (!markdownSource) return;

    // 1. Get rendered HTML from #output
    const outputEl = document.querySelector('#output');
    const html = outputEl?.innerHTML ?? '';

    // 2. Get resolved theme CSS from <style id="md-theme">
    const themeStyleEl = document.getElementById('md-theme');
    const css = themeStyleEl?.textContent ?? '';

    // 3. Extract title from markdown (first heading)
    const headingMatch = markdownSource.match(/^#{1,6}\s+(.+)$/m);
    const title = headingMatch?.[1]?.trim() ?? selectedFile?.split('/').pop()?.replace(/\.md$/, '') ?? '';

    // 4. Start bridge server and open in system browser
    //    Bridge page will detect window.$cose at runtime (works with both
    //    Chrome Store install and developer-mode sideload)
    const { bridgeUrl } = await api.startPublish({ title, markdown: markdownSource, html, css });
    window.open(bridgeUrl, '_blank');
  }, [editedContent, fileContent, selectedFile]);

  return {
    vaults,
    activeVault,
    treeVaultId,
    tree,
    selectedFile,
    fileContent,
    fileLoadError,
    history,
    panelWidth,
    searchQuery,
    loading,
    wikiInitialized,
    isTypesetMode,
    themeConfig,
    editedContent,
    isEditMode,
    showVaultSwitcher,
    showAddVault,
    showImport,
    showCoseInstallPrompt,
    selectVault,
    createVault,
    deleteVault,
    selectFile,
    refreshTree,
    checkWikiStatus,
    setPanelWidth,
    setSearchQuery,
    setShowVaultSwitcher,
    setShowAddVault,
    setShowImport,
    openVault,
    createFile,
    createFolder,
    deleteFile,
    deleteFolder,
    renameFile,
    saveFile,
    toggleTypesetMode,
    setTypesetMode,
    setThemeConfig,
    setEditedContent: handleEditedContentChange,
    copyToClipboard,
    publishToChrome,
    setShowCoseInstallPrompt,
    toggleEditMode,
    setEditMode,
  };
}
