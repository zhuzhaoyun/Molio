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

interface UseKnowledgeReturn {
  // Data
  vaults: Vault[];
  activeVault: Vault | null;
  tree: TreeNode[];
  selectedFile: string | null;
  fileContent: FileContent | null;
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
  selectFile: (path: string) => void;
  refreshTree: () => void;
  checkWikiStatus: () => void;
  setPanelWidth: (w: number) => void;
  setSearchQuery: (q: string) => void;
  setShowVaultSwitcher: (show: boolean) => void;
  setShowAddVault: (show: boolean) => void;
  setShowImport: (show: boolean) => void;

  // Typeset actions
  toggleTypesetMode: () => void;
  setThemeConfig: (config: ThemeConfig) => void;
  setEditedContent: (content: string) => void;
  copyToClipboard: () => Promise<void>;
  publishToChrome: () => Promise<void>;
  setShowCoseInstallPrompt: (show: boolean) => void;
}

export function useKnowledge(): UseKnowledgeReturn {
  const [vaults, setVaults] = useState<Vault[]>([]);
  // Read active vault ID from the shared store so App.tsx stays in sync.
  const activeVaultId = useActiveVaultId();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
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

  // Wiki state
  const [wikiInitialized, setWikiInitialized] = useState(false);


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

  // Load tree when vault changes
  useEffect(() => {
    if (!activeVaultId) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const t = await api.getFileTree(activeVaultId);
        if (!cancelled) {
          setTree(t);
          setSelectedFile(null);
          setFileContent(null);
        }
      } catch {
        if (!cancelled) setTree([]);
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
    // Reset edited content when switching files
    setEditedContent(null);
    let cancelled = false;
    (async () => {
      try {
        const content = await api.readFile(activeVaultId, selectedFile);
        if (!cancelled) {
          setFileContent(content);
        }
      } catch {
        if (!cancelled) setFileContent(null);
      }
    })();
    return () => { cancelled = true; };
  }, [activeVaultId, selectedFile]);

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
      setSelectedFile(null);
      setFileContent(null);
    }
  }, [activeVaultId]);

  const selectFile = useCallback((path: string) => {
    setSelectedFile(path);
  }, []);

  const refreshTree = useCallback(() => {
    if (!activeVaultId) return;
    api.getFileTree(activeVaultId).then(setTree).catch(() => {});
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

  // Typeset mode actions
  const toggleTypesetMode = useCallback(() => {
    setIsTypesetMode((prev) => !prev);
  }, []);

  const handleEditedContentChange = useCallback((content: string) => {
    setEditedContent(content);
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

    // 1. Check COSE extension
    const { installed } = await api.checkCose();
    if (!installed) {
      setShowCoseInstallPrompt(true);
      return;
    }

    // 2. Get rendered HTML from #output
    const outputEl = document.querySelector('#output');
    const html = outputEl?.innerHTML ?? '';

    // 3. Get resolved theme CSS from <style id="md-theme">
    const themeStyleEl = document.getElementById('md-theme');
    const css = themeStyleEl?.textContent ?? '';

    // 4. Extract title from markdown (first heading)
    const headingMatch = markdownSource.match(/^#{1,6}\s+(.+)$/m);
    const title = headingMatch?.[1]?.trim() ?? selectedFile?.split('/').pop()?.replace(/\.md$/, '') ?? '';

    // 5. Start bridge server and open Chrome
    const { bridgeUrl } = await api.startPublish({ title, markdown: markdownSource, html, css });
    window.open(bridgeUrl, '_blank');
  }, [editedContent, fileContent, selectedFile]);

  return {
    vaults,
    activeVault,
    tree,
    selectedFile,
    fileContent,
    history,
    panelWidth,
    searchQuery,
    loading,
    wikiInitialized,
    isTypesetMode,
    themeConfig,
    editedContent,
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
    toggleTypesetMode,
    setThemeConfig,
    setEditedContent: handleEditedContentChange,
    copyToClipboard,
    publishToChrome,
    setShowCoseInstallPrompt,
  };
}
