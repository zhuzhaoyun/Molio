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

export type KbTab = 'preview'; // Simplified - only preview tab now

interface UseKnowledgeReturn {
  // Data
  vaults: Vault[];
  activeVault: Vault | null;
  tree: TreeNode[];
  selectedFile: string | null;
  fileContent: FileContent | null;
  history: KbHistoryEntry[];
  activeTab: KbTab;

  // UI state
  panelWidth: number;
  searchQuery: string;
  loading: boolean;

  // Typeset mode state
  isTypesetMode: boolean;
  themeConfig: ThemeConfig;
  editedContent: string | null;

  // Modals
  showVaultSwitcher: boolean;
  showAddVault: boolean;
  showImport: boolean;

  // Actions
  selectVault: (id: string) => void;
  createVault: (name: string, path: string, description?: string) => Promise<void>;
  openVault: (path: string) => Promise<void>;
  deleteVault: (id: string) => Promise<void>;
  selectFile: (path: string) => void;
  refreshTree: () => void;
  setActiveTab: (tab: KbTab) => void;
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
}

export function useKnowledge(): UseKnowledgeReturn {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [history, setHistory] = useState<KbHistoryEntry[]>([]);
  const [activeTab, setActiveTab] = useState<KbTab>('preview');
  const [panelWidth, setPanelWidth] = useState(260);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);

  // Modals
  const [showVaultSwitcher, setShowVaultSwitcher] = useState(false);
  const [showAddVault, setShowAddVault] = useState(false);
  const [showImport, setShowImport] = useState(false);

  // Typeset mode state
  const [isTypesetMode, setIsTypesetMode] = useState(false);
  const [themeConfig, setThemeConfig] = useState<ThemeConfig>(defaultThemeConfig);
  const [editedContent, setEditedContent] = useState<string | null>(null);


  // Load vaults on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listVaults();
        if (cancelled) return;
        setVaults(list);
        if (list.length > 0 && !activeVaultId && list[0]) {
          setActiveVaultId(list[0].id);
        }
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

  // Load file content when file selected
  useEffect(() => {
    if (!activeVaultId || !selectedFile) return;
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

  // Load history when file or vault changes
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
  }, [activeVaultId, selectedFile]);

  const activeVault = vaults.find((v) => v.id === activeVaultId) ?? null;

  const selectVault = useCallback((id: string) => {
    setActiveVaultId(id);
    setShowVaultSwitcher(false);
  }, []);

  const createVault = useCallback(async (name: string, path: string, description?: string) => {
    const vault = await api.createVault({ name, path, description });
    setVaults((prev) => [vault, ...prev]);
    setActiveVaultId(vault.id);
    setShowAddVault(false);
  }, []);

  const openVault = useCallback(async (path: string) => {
    // Derive a name from the last path segment
    const name = path.split(/[\/]/).pop() || '未命名仓库';
    const vault = await api.createVault({ name, path, description: `从本地文件夹打开: ${path}` });
    setVaults((prev) => [vault, ...prev]);
    setActiveVaultId(vault.id);
  }, []);

  const deleteVault = useCallback(async (id: string) => {
    await api.deleteVault(id);
    setVaults((prev) => prev.filter((v) => v.id !== id));
    if (activeVaultId === id) {
      setActiveVaultId(null);
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
  }, [activeVaultId]);

  // Typeset mode actions
  const toggleTypesetMode = useCallback(() => {
    setIsTypesetMode((prev) => {
      // When exiting typeset mode, also close style panel
      return !prev;
    });
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

  return {
    vaults,
    activeVault,
    tree,
    selectedFile,
    fileContent,
    history,
    activeTab,
    panelWidth,
    searchQuery,
    loading,
    isTypesetMode,
    themeConfig,
    editedContent,
    showVaultSwitcher,
    showAddVault,
    showImport,
    selectVault,
    createVault,
    deleteVault,
    selectFile,
    refreshTree,
    setActiveTab,
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
  };
}
