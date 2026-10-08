/**
 * Main content area — renders files based on type:
 * - Text (md/txt/html/json/yaml): doocs/md rendering with optional typeset mode
 * - Images (png/jpg/gif/svg/webp): inline <img> preview
 * - Binary (pdf/docx/pptx): file info card + "open with system app" button
 */

import { useEffect, useState, useRef, useMemo, useCallback, lazy, Suspense, type RefObject } from 'react';
import { MAX_ASK_SELECTION } from './kb-constants';
import type { FileContent } from '@molio/contracts';
import type { ThemeConfig } from './MdStylePanel';
import { MdRenderer } from './MdRenderer';
import { MdTypesetEditor } from './MdTypesetEditor';
import { MdEditor } from './MdEditor';
import { ContextMenu } from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import { TooLargeCard } from './TooLargeCard';
import { ViewerErrorBoundary } from './ViewerErrorBoundary';
import type { KbCodeMirrorViewerHandle } from './KbCodeMirrorViewer';
import { KbFrontmatterCard } from './KbFrontmatterCard';
import { formatFileSize } from '../../utils/format';
import { preprocessKbMarkdown } from '../../hooks/useKnowledge';
import { useScrollMemory, type ScrollIntent } from '../../hooks/useScrollMemory';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useNavigationHistory, navigationHistoryStore } from '../../stores/navigationHistoryStore';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import frontMatter from 'front-matter';

// Lazy-load the CodeMirror viewer (heavy CM bundle) only when a text file
// actually takes the CM path (non-md / large md). Named export → default shape.
const KbCodeMirrorViewer = lazy(() =>
  import('./KbCodeMirrorViewer').then((m) => ({ default: m.KbCodeMirrorViewer })),
);

import type { PdfViewerHandle } from './PdfViewer';

const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })));

/** .md files at or below this size still render via doocs/md. Above → source mode. */
const MD_RENDER_THRESHOLD = 1 * 1024 * 1024;
const MD_EXTS = new Set(['.md', '.markdown']);

/**
 * Lazy singleton HTML→Markdown converter. Used by the copy action to write a
 * Markdown `text/plain` slot alongside `text/html`, so pasting a table (or
 * any selection) into Obsidian / a Markdown editor / 记事本 yields Markdown
 * source instead of flat text or HTML. GFM plugin enables pipe-table support.
 */
let _turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!_turndown) {
    _turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
    _turndown.use(gfm);
  }
  return _turndown;
}

/** File categories for rendering strategy */
type FileCategory = 'text' | 'image' | 'video' | 'audio' | 'binary' | 'pdf';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg']);
const PDF_EXTS = new Set(['.pdf']);
const BINARY_EXTS = new Set(['.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls']);

function getFileCategory(fileName: string): FileCategory {
  const lastDot = fileName.lastIndexOf('.');
  const ext = lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (BINARY_EXTS.has(ext)) return 'binary';
  return 'text';
}

/** CJK character range + English word count. Returns "word count" (CJK each char = 1 + English word count). */
function countWords(text: string): number {
  const cjkMatches = text.match(/[一-鿿㐀-䶿]/g);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  // English words (strip CJK then split by non-alphanumeric)
  const stripped = text.replace(/[一-鿿㐀-䶿]/g, ' ');
  const enMatches = stripped.match(/[A-Za-z0-9]+/g);
  const en = enMatches ? enMatches.length : 0;
  return cjk + en;
}

function formatReadTime(words: number, suffix: string): string {
  const mins = Math.max(1, Math.ceil(words / 300));
  return `~${mins} ${suffix}`;
}

interface KbMainContentProps {
  fileContent: FileContent | null;
  selectedFile: string | null;
  vaultId: string | null;
  vaultPath: string | null;
  isTypesetMode: boolean;
  themeConfig: ThemeConfig;
  wikiInitialized: boolean;
  /** Non-null when file load failed (e.g. 404). */
  fileLoadError?: string | null;
  /** Whether the edited content has unsaved changes */
  hasUnsavedChanges?: boolean;
  onToggleTypeset: () => void;
  onThemeConfigChange: (config: ThemeConfig) => void;
  onContentChange: (content: string) => void;
  onSave?: () => void;
  onCopy: () => void;
  onPublish: () => void;
  onBuildWiki: () => void;
  /** Open the import dialog (file panel toolbar's 导入 按钮的双生入口)。 */
  onImport?: () => void;
  /** 打开知识库管理器（建库/打开已有库）。用于「一个库都没有」的空态。 */
  onOpenVaultManager?: () => void;
  /** vault 里有没有文件。false 时空库主 CTA 换成「导入文件」——
   *  空库推「构建 Wiki」是错的：没有素材，AI 无从扫起。 */
  hasFiles?: boolean;
  /** 当 tab bar 存在时，可选择隐藏 header 中的文件名 */
  showFileName?: boolean;
  /** 是否为编辑模式（仅文本文件） */
  isEditMode?: boolean;
  onToggleEdit?: () => void;
  /** Callback when user selects text and clicks the float "就此提问" button. */
  onAskAboutSelection?: (selectedText: string) => void;
  /** Open the document outline panel. */
  onOpenOutline?: () => void;
  /** Open the unified KB chat panel in QA mode for the current file. */
  onAskAboutFile?: () => void;
  /** 编辑后的内容（用于阅读模式显示未保存的更改） */
  editedContent?: string | null;
  /** Force-load a too-large file past the safe cap (wired to useKnowledge.forceLoadFile). */
  onForceLoad?: () => void;
  /** Close the active tab (wired from useKbTabs by KnowledgeBasePage). */
  onCloseTab?: () => void;
  /** Navigate to another file in the same vault (for [[wikilink]] clicks). */
  onNavigateToFile?: (filePath: string) => void;
  /** 只读副视图模式：隐藏头部全部动作按钮（副格由 CompanionHeader 承担关闭/标识）。
   *  (原注释保留) */
  companion?: boolean;
  /** 副视图（分屏）时头部右侧的关闭 ×（而非独立的副格标题栏）。 */
  onCloseCompanion?: () => void;
  /**
   * 本次导航的滚动落位意图（restore = 切回已开着的文档；fresh = 开进没有它的
   * 标签）。由 KnowledgeBasePage 在触发选择前**同步**写入（ref，不是 state；
   * 原因见 useScrollMemory 约束 5）。缺省 = restore。
   */
  scrollIntentRef?: RefObject<ScrollIntent>;
}

export function KbMainContent({
  fileContent,
  selectedFile,
  vaultId,
  vaultPath,
  isTypesetMode,
  themeConfig,
  wikiInitialized,
  fileLoadError,
  hasUnsavedChanges,
  onToggleTypeset,
  onContentChange,
  onSave,
  onCopy,
  onPublish,
  onBuildWiki,
  onImport,
  onOpenVaultManager,
  hasFiles,
  showFileName = true,
  isEditMode = false,
  onToggleEdit,
  onAskAboutSelection,
  onOpenOutline,
  onAskAboutFile,
  editedContent,
  onForceLoad,
  onCloseTab,
  onNavigateToFile,
  companion = false,
  onCloseCompanion,
  scrollIntentRef,
}: KbMainContentProps) {
  const { t } = useI18n();
  const { canGoBack, canGoForward } = useNavigationHistory();
  const contentRef = useRef<HTMLDivElement>(null);
  const cmRef = useRef<KbCodeMirrorViewerHandle>(null);
  const pdfRef = useRef<PdfViewerHandle>(null);
  // 头部缩放宽显示：PdfViewer 通过 onZoomChange 上报当前缩放比例；点击读数进入输入态
  const [pdfZoom, setPdfZoom] = useState(100);
  const [pdfZoomEditing, setPdfZoomEditing] = useState(false);
  const [pdfZoomInput, setPdfZoomInput] = useState('');

  const applyPdfZoom = useCallback(() => {
    setPdfZoomEditing(false);
    const v = Number(pdfZoomInput);
    if (Number.isFinite(v) && v > 0) pdfRef.current?.setZoom(v);
  }, [pdfZoomInput]);
  const [wrap, setWrap] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [fmExpanded, setFmExpanded] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; source: 'doocs' | 'codemirror' | 'pdf'; selectedText?: string } | null
  >(null);

  // Routing flags — computed from extension + size + tooLarge.
  const fileName = selectedFile ? (selectedFile.split('/').pop() ?? selectedFile) : '';
  const ext = fileName ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
  const isMarkdown = MD_EXTS.has(ext);
  const isLargeMd = isMarkdown && (fileContent?.size ?? 0) > MD_RENDER_THRESHOLD;
  const isSmallMd = isMarkdown && !isLargeMd;
  const category = fileName ? getFileCategory(fileName) : null;
  // CM path: text category, not too-large, and (large md OR non-markdown).
  const isCmPath = category === 'text' && !fileContent?.tooLarge && (isLargeMd || !isMarkdown);

  // Memoize the rendered markdown content so MdRenderer (wrapped in memo)
  // doesn't see a new string prop on unrelated re-renders. Preprocessing only
  // runs for the small-.md doocs path — never for the CM source view.
  const renderedContent = useMemo(
    () => isSmallMd
      ? preprocessKbMarkdown(editedContent ?? fileContent?.content ?? '', vaultId ?? undefined)
      : '',
    [editedContent, fileContent?.content, vaultId, isSmallMd],
  );

  // Raw text used by the CM viewer — NO doocs preprocessing (those transforms
  // mutate HTML/rendered markdown, not raw source).
  // （位置记忆的 CM 就绪判定要拿它比对，故声明在此处、滚动记忆之前。）
  const rawContent = useMemo(
    () => editedContent ?? fileContent?.content ?? '',
    [editedContent, fileContent?.content],
  );

  // 「已上屏的内容」——MdRenderer 渲染完一篇后回传的那一份内容串。
  // 位置记忆靠它判断容器里到底画的是哪一篇（见下 scrollMemoryReady）。
  const [mdRenderedSource, setMdRenderedSource] = useState<string | null>(null);

  // ── 阅读视窗位置记忆（小 .md 阅读路径 + 源码视图两条路） ──
  // key 带 pane 前缀：同一文档同时出现在主格与副格时两者位置互不覆盖。
  // vaultId + 相对路径 = 文档身份（文件 tab 的 id 本就是 `file:${path}`，等价）。
  // 源码视图额外加 `cm:` 段：同一篇文档在阅读视图与源码视图里是两套高度模型，
  // 位置不可互换。
  // 不在记忆范围的：PDF / 图片（容器是 PDF 阅读器 / 图片查看器，PDF 还得连页码和缩放
  // 一起记，另排期）、排版与编辑模式。这些路径 key 为 null，hook 整个让位。
  const isReadingPath = category === 'text' && isSmallMd && !isTypesetMode && !isEditMode && !!selectedFile;
  const isCmMemoryPath = isCmPath && !!selectedFile;
  const panePrefix = companion ? 'companion' : 'main';
  const scrollMemoryKey = isReadingPath
    ? `${panePrefix}:${vaultId ?? ''}:${selectedFile ?? ''}`
    : isCmMemoryPath
      ? `${panePrefix}:cm:${vaultId ?? ''}:${selectedFile ?? ''}`
      : null;

  // 指纹（size:modifiedAt）：文档被 AI/外部改写过则旧位置作废，回顶部。
  const scrollMemoryFp =
    fileContent != null ? `${fileContent.size}:${fileContent.modifiedAt}` : null;
  // 源码视图的滚动元素由 CM 自己交出（量过一遍之后，见 KbCodeMirrorViewer.onMeasured）。
  // 这里用 state 而不是 ref：容器到位那一刻要触发 hook 的 effect 重跑（挂监听 + 落位），
  // 而 ref 的 current 变化不会让任何 effect 重跑。故按元素身份造一个新的 ref 对象。
  const [cmScrollHost, setCmScrollHost] = useState<{ el: HTMLElement; source: string } | null>(null);
  const cmContainerRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({ current: cmScrollHost?.el ?? null }),
    [cmScrollHost],
  );
  const handleCmMeasured = useCallback((el: HTMLElement | null, source: string | null) => {
    setCmScrollHost(el && source != null ? { el, source } : null);
  }, []);

  // 内容已就绪 = ①手上这份 fileContent 正是当前选中的文件，且②它真的已经画到容器里了。
  // ②不能省：MdRenderer 把渲染结果放在自己的 state 里、在 effect 中异步写入
  // （见 MdRenderer「Render markdown content」），所以 fileContent 到手那一帧容器里
  // 还是上一篇——此时落位会被上一篇的 scrollHeight 截断（上一篇越短截得越狠，
  // 无滚动条的短文档直接截到 0，表现为「切回长文档却回到顶部」）。
  // 用「已上屏的内容串 === 当前要渲染的内容串」判定，字符串相等即同一篇，
  // 换文档自动失效，不会误判为就绪。
  // 源码视图同理，判据换成「CM 量过的那份内容 === 当前内容」（CM 侧不变量见 onMeasured）。
  const scrollMemoryReady = isCmMemoryPath
    ? cmScrollHost != null && cmScrollHost.source === rawContent
    : fileContent != null &&
      fileContent.path === selectedFile &&
      mdRenderedSource != null &&
      mdRenderedSource === renderedContent;
  const { scrollToTop } = useScrollMemory({
    containerRef: isCmMemoryPath ? cmContainerRef : contentRef,
    key: scrollMemoryKey,
    fingerprint: scrollMemoryFp,
    ready: scrollMemoryReady,
    intentRef: scrollIntentRef,
  });

  // Parse YAML frontmatter from the raw source for the property card.
  // Only meaningful for small .md files (doocs path).
  const frontmatterData = useMemo(() => {
    if (!isSmallMd) return {};
    const raw = editedContent ?? fileContent?.content ?? '';
    if (!raw) return {};
    try {
      const parsed = frontMatter(raw);
      return (parsed.attributes as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }, [rawContent, isSmallMd]);

  // Extract distilled badges (not raw frontmatter fields) for the collapsed header.
  // The collapsed bar should answer "what kind of document is this?" at a glance.
  const fmCollapsed = useMemo(() => {
    const fm = frontmatterData;
    if (Object.keys(fm).length === 0) return null;

    const tags: string[] = (() => {
      const raw = fm.tags;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw.map((t) => String(t)).filter(Boolean);
      if (typeof raw === 'string') return raw.split(/,\s*/).filter(Boolean);
      return [];
    })();

    const source: string | null = (() => {
      const raw = fm.source;
      if (!raw) return null;
      const s = String(raw);
      return /^https?:\/\//i.test(s) ? s : null;
    })();

    const author: string | null = (() => {
      const raw = fm.author;
      if (!raw) return null;
      if (Array.isArray(raw)) {
        return raw.map((a) => String(a).replace(/^\[\[|\]\]$/g, '').trim()).filter(Boolean).join(', ');
      }
      return String(raw);
    })();

    const wikiType = typeof fm.type === 'string' ? fm.type : null;

    const relatedCount = (() => {
      const raw = fm.related;
      if (!raw) return 0;
      if (Array.isArray(raw)) return raw.length;
      return 0;
    })();

    const isWeChat =
      tags.includes('clippings') ||
      (source !== null && source.includes('mp.weixin.qq.com'));

    // Derive the primary badge (icon + label) from frontmatter properties.
    interface Badge { icon: string; label: string; }
    let primaryBadge: Badge | null = null;
    let secondaryBadge: Badge | null = null;

    if (wikiType) {
      const typeBadges: Record<string, Badge> = {
        entity: { icon: '📌', label: '实体' },
        concept: { icon: '💡', label: '概念' },
        source: { icon: '📰', label: '数据源' },
        comparison: { icon: '⚖️', label: '对比' },
        question: { icon: '❓', label: '问答' },
      };
      primaryBadge = typeBadges[wikiType] ?? null;
      if (relatedCount > 0) {
        secondaryBadge = { icon: '🔗', label: `${relatedCount}` };
      }
    } else if (isWeChat) {
      primaryBadge = { icon: '📱', label: '微信' };
      if (author) secondaryBadge = { icon: '✍️', label: author };
    } else if (source) {
      primaryBadge = { icon: '📎', label: '剪藏' };
      if (author) secondaryBadge = { icon: '✍️', label: author };
    } else if (tags.length > 0) {
      primaryBadge = { icon: '📄', label: tags[0]! };
    }

    // Fallback: frontmatter exists but no badge pattern matched —
    // show a generic "文档" badge so the collapsed bar & expand button stay accessible.
    if (!primaryBadge) {
      primaryBadge = { icon: '📄', label: '文档' };
    }
    return { primaryBadge, secondaryBadge };
  }, [frontmatterData]);

  const handleFmCollapse = useCallback(() => setFmExpanded(false), []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, source: 'doocs' });
  }, []);

  const handleCmContextMenu = useCallback(
    (e: { x: number; y: number; selectedText: string; source: 'codemirror' }) => {
      setCtxMenu({ x: e.x, y: e.y, source: 'codemirror', selectedText: e.selectedText });
    },
    [],
  );

  const handlePdfContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, source: 'pdf' });
  }, []);

  const closeContextMenu = useCallback(() => setCtxMenu(null), []);

  const selectionText = useCallback(() => {
    const sel = window.getSelection();
    return sel ? sel.toString().trim() : '';
  }, []);

  // 这里曾有一段「selectedFile 变即 scrollTo 顶部」的 effect（#274）：它修掉了
  // 容器复用导致的 scrollTop 残留，但把「点标签切回」「后退回到刚才那篇」也一并
  // 顶回了顶部。现在滚动位置统一由 useScrollMemory 负责（见上方「阅读视窗位置
  // 记忆」）：新开文档回顶、切回已有标签/前进后退恢复，残留由它的无记录分支兜住。
  // 不要再把无条件回顶改回来——那会让恢复永远看不到效果。
  // （CM / 源码路径的滚动容器是 CodeMirror 自己的 .cm-scroller，不在 contentRef
  //   上，本 hook 对它 key 为 null、整体让位——那条路径的位置记忆尚未做。）

  // Capture-phase click handler: intercept wiki link clicks within the KB
  // shell. Prevents native <a href> navigation, checks if the file exists
  // via API, and either opens it (exists) or shows a toast (not found).
  // Scoped to .kb-shell so it doesn't interfere with wiki links in chat.
  useEffect(() => {
    if (!onNavigateToFile || !vaultId) return;
    const handler = (e: MouseEvent) => {
      // Only handle clicks inside the KB shell
      if (!(e.target as HTMLElement).closest('.kb-shell')) return;
      const link = (e.target as HTMLElement).closest('.kb-wiki-link') as HTMLAnchorElement | null;
      if (!link) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const filePath = link.getAttribute('data-file-path') || link.textContent?.trim();
      if (!filePath) return;

      const apiUrl = `/api/knowledge/vaults/${vaultId}/resolve/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
      fetch(apiUrl)
        .then((res) => {
          if (res.status === 404) throw new Error('NOT_FOUND');
          // File exists — strip .md extension for tree-stem search
          const searchPath = filePath.replace(/\.md$/i, '');
          onNavigateToFile(searchPath);
        })
        .catch((err) => {
          if (err.message === 'NOT_FOUND') {
            window.alert(`文件 "${filePath}" 不存在`);
            return;
          }
          // Other error — still try to open
          const searchPath = filePath.replace(/\.md$/i, '');
          onNavigateToFile(searchPath);
        });
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [onNavigateToFile, vaultId]);

  // Ctrl+S / Cmd+S to save
  useEffect(() => {
    if (!onSave) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onSave]);

  // Compute file metadata null-safe so the header can render in empty states
  // (search / more-menu stay visible even when no file is open).
  // Build absolute path for shell.openPath (Electron only)
  const absolutePath = vaultPath && selectedFile
    ? `${vaultPath.replace(/[\\/]+$/, '')}/${selectedFile}`
    : null;

  const handleOpenExternal = () => {
    if (absolutePath && window.__electron__?.openPath) {
      window.__electron__.openPath(absolutePath);
    }
  };

  const isElectron = !!window.__electron__?.openPath;

  /**
   * 空态的两颗动作按钮。两者互为「主/次」，在同一个 flex 行里按状态对调主次
   * （见下方 !wikiInitialized 分支）——所以用同一对构造器，避免两处样式漂移。
   *
   * primary=false 时「构建 Wiki」还会置灰：知识库里一个文件都没有时，AI 没有素材
   * 可读，这个动作根本不成立。置灰而非隐藏，是因为它顺带说明了「先导文件、再建 Wiki」
   * 这个先后关系——隐藏掉的话，用户永远不会知道这个知识库能产出 Wiki。
   */
  const buildWikiButton = (primary: boolean) => (
    <button
      type="button"
      className={primary ? 'wiki-cta-btn' : 'wiki-cta-btn wiki-cta-btn--outline'}
      data-testid="kb-empty-build-cta"
      onClick={onBuildWiki}
      disabled={!primary}
      title={primary ? undefined : t('kb.buildWikiNeedsFiles')}
    >
      {t('kb.buildWikiCta')}
    </button>
  );

  const importButton = (primary: boolean) =>
    onImport ? (
      <button
        type="button"
        className={primary ? 'wiki-cta-btn' : 'wiki-cta-btn wiki-cta-btn--outline'}
        data-testid="kb-empty-import-cta"
        onClick={onImport}
      >
        {t('kb.emptyImportCta')}
      </button>
    ) : null;

  /**
   * 是否把「导入文件」当成这屏的主推。没有文件才需要导入；但没有 onImport 调用方时
   * （对照分屏那份 KbMainContent 就不传）不能硬推——否则屏上只剩一颗置灰的
   * 「构建 Wiki」，正是这一整轮修复要消灭的死胡同。此时退回旧的「构建 Wiki 为主」。
   */
  const importFirst = !hasFiles && !!onImport;

  return (
    <main className="kb-main">
      {/* Header — always rendered so view actions (search / more-menu) stay
          visible even in empty states. File actions only render when a file is open. */}
      <div className="kb-main-header">
        {/* ── Back/forward (tab view history) — minimal chevrons, greyed when disabled.
            主格专属：副视图（分屏对照/镜像）复用同一份历史但自身不导览，隐藏该组
            以免「在右格点后退、左格却变了」的误导。 ── */}
        {!companion && (
          <div className="kb-nav-group" data-testid="kb-nav-navigation">
            <button
              type="button"
              className="kb-nav-btn"
              data-testid="nav-back"
              disabled={!canGoBack}
              onClick={() => navigationHistoryStore.back()}
              aria-label={t('nav.back')}
            >
              ‹
            </button>
            <button
              type="button"
              className="kb-nav-btn"
              data-testid="nav-forward"
              disabled={!canGoForward}
              onClick={() => navigationHistoryStore.forward()}
              aria-label={t('nav.forward')}
            >
              ›
            </button>
          </div>
        )}

        {/* ── Frontmatter property pill (wiki docs only) — badges + collapse toggle in one unit ── */}
        {!isTypesetMode && !isEditMode && isSmallMd && fmCollapsed && (
          <div className="kb-fm-pill">
            <span className="kb-fm-pill-title">{t('kb.frontmatter.properties')}</span>
            {fmCollapsed.primaryBadge && (
              <span className={'kb-fm-badge' + (fmExpanded ? ' kb-fm-badge-dimmed' : '')}>
                <span aria-hidden="true">{fmCollapsed.primaryBadge.icon}</span>
                <span>{fmCollapsed.primaryBadge.label}</span>
              </span>
            )}
            {fmCollapsed.secondaryBadge && (
              <span className={'kb-fm-badge kb-fm-badge-secondary' + (fmExpanded ? ' kb-fm-badge-dimmed' : '')}>
                <span aria-hidden="true">{fmCollapsed.secondaryBadge.icon}</span>
                <span>{fmCollapsed.secondaryBadge.label}</span>
              </span>
            )}
            <button
              type="button"
              className="kb-fm-pill-toggle"
              onClick={() => setFmExpanded((prev) => !prev)}
              title={fmExpanded ? t('kb.frontmatter.collapse') : t('kb.frontmatter.expand')}
            >
              {fmExpanded ? '▴' : '▾'}
            </button>
          </div>
        )}
        {showFileName && selectedFile && (
          <div className="kb-header-filename-center">
            <span>
              {fileName}
              {hasUnsavedChanges && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>●</span>}
            </span>
          </div>
        )}
        <div className="kb-header-actions">
          {!companion && (
            <>
          {/* ── File edit / output actions (text files only, small-.md doocs path) ── */}
          {category === 'text' && selectedFile && !isCmPath && (
            <>
              {/* 阅读路径的「回到顶部」—— 与 CM 路径的 kb-btn-top 同款同 testid
                  （两条路径互斥，不会同时渲染）。有了位置记忆后，这是「我想从头
                  重读」的显式逃逸口：CM 路径本来就有，阅读路径此前没有。 */}
              {isReadingPath && (
                <button
                  type="button"
                  className="kb-btn kb-btn-ghost"
                  onClick={scrollToTop}
                  title={t('kb.scrollToTop')}
                  data-testid="kb-btn-top"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}

              {/* Save — only in editing modes (read mode has nothing to save) */}
              {onSave && (isEditMode || isTypesetMode) && (
                <button type="button" className="kb-btn kb-btn-ghost" onClick={onSave} title={t('kb.save')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                </button>
              )}

              {/* Copy and Publish (typeset mode only) */}
              {isTypesetMode && (
                <>
                  <button type="button" className="kb-btn kb-btn-ghost" onClick={onCopy} title={t('kb.copy')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  <button type="button" className="kb-btn kb-btn-ghost" onClick={onPublish} title={t('kb.publish')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  </button>
                </>
              )}

              {/* Typeset toggle — signature action. Read mode: T icon + "排版"
                  label (entry, prominent). Typeset mode: exit icon only (leave). */}
              <button
                type="button"
                className={`kb-btn ${isTypesetMode ? 'is-active' : ''}`}
                onClick={onToggleTypeset}
                title={isTypesetMode ? t('kb.exitTypeset') : t('kb.typeset')}
                data-testid="kb-btn-typeset"
              >
                {isTypesetMode ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="M4 7V4h16v3" />
                    <path d="M9 20h6" />
                    <path d="M12 4v16" />
                  </svg>
                )}
                {!isTypesetMode && <span>{t('kb.typeset')}</span>}
              </button>
            </>
          )}

          {/* ── CodeMirror viewer actions (text files on the CM path only) ── */}
          {category === 'text' && selectedFile && isCmPath && (
            <>
              <button
                type="button"
                className={`kb-btn kb-btn-ghost ${wrap ? 'is-active' : ''}`}
                onClick={() => setWrap((w) => !w)}
                title={t('kb.wrap')}
                data-testid="kb-btn-wrap"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M4 7h11v4h-7" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => {
                  const n = Number(window.prompt(t('kb.gotoLine')));
                  if (n) cmRef.current?.gotoLine(n);
                }}
                title={t('kb.gotoLine')}
                data-testid="kb-btn-goto"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <circle cx="12" cy="12" r="7" />
                  <line x1="12" y1="5" x2="12" y2="9" />
                  <line x1="12" y1="15" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="9" y2="12" />
                  <line x1="15" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => cmRef.current?.scrollToTop()}
                title={t('kb.scrollToTop')}
                data-testid="kb-btn-top"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => cmRef.current?.scrollToBottom()}
                title={t('kb.scrollToBottom')}
                data-testid="kb-btn-bottom"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
              </button>
            </>
          )}

          {/* PDF viewer: 翻页 / 缩放 / 适配（命令式走 pdfRef） */}
          {category === 'pdf' && selectedFile && (
            <>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => pdfRef.current?.prevPage()}
                title={t('kb.pdf.prevPage')}
                data-testid="kb-btn-pdf-prev"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => pdfRef.current?.nextPage()}
                title={t('kb.pdf.nextPage')}
                data-testid="kb-btn-pdf-next"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <span className="kb-header-actions-divider" />
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => pdfRef.current?.zoomOut()}
                title={t('kb.pdf.zoomOut')}
                data-testid="kb-btn-pdf-zoom-out"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              {pdfZoomEditing ? (
                <input
                  className="pdf-zoom-input"
                  data-testid="pdf-zoom-input"
                  type="number"
                  min={25}
                  max={400}
                  value={pdfZoomInput}
                  autoFocus
                  onChange={(e) => setPdfZoomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyPdfZoom();
                    else if (e.key === 'Escape') setPdfZoomEditing(false);
                  }}
                  onBlur={applyPdfZoom}
                />
              ) : (
                <span
                  className="pdf-zoom-readout"
                  data-testid="pdf-zoom-readout"
                  role="button"
                  tabIndex={0}
                  title={t('kb.pdf.zoomInputHint')}
                  onClick={() => { setPdfZoomInput(String(pdfZoom)); setPdfZoomEditing(true); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      setPdfZoomInput(String(pdfZoom));
                      setPdfZoomEditing(true);
                    }
                  }}
                >{pdfZoom}%</span>
              )}
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => pdfRef.current?.zoomIn()}
                title={t('kb.pdf.zoomIn')}
                data-testid="kb-btn-pdf-zoom-in"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <span className="kb-header-actions-divider" />
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => pdfRef.current?.fitWidth()}
                title={t('kb.pdf.fitWidth')}
                data-testid="kb-btn-pdf-fit-width"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                  <polyline points="18 8 22 12 18 16" />
                  <polyline points="6 8 2 12 6 16" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => pdfRef.current?.fitPage()}
                title={t('kb.pdf.fitPage')}
                data-testid="kb-btn-pdf-fit-page"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
              </button>
              <span className="kb-header-actions-divider" />
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => pdfRef.current?.toggleSearch()}
                title={t('kb.pdf.search')}
                data-testid="kb-btn-pdf-search"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
              <button
                type="button"
                className="kb-btn kb-btn-ghost"
                onClick={() => pdfRef.current?.toggleSidebar()}
                title={t('kb.pdf.sidebar')}
                data-testid="kb-btn-pdf-sidebar"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </svg>
              </button>
            </>
          )}

          {/* Binary/PDF file: open with system app (Electron only) — icon-only, label 移到 tooltip，
              避免「用外部程序打开」宽文本把 header action 区顶宽、与居中的文件名重叠。 */}
          {(category === 'binary' || category === 'pdf') && isElectron && (
            <button
              type="button"
              className="kb-btn"
              onClick={handleOpenExternal}
              title={t('kb.openExternal')}
              data-testid="kb-btn-open-external"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          )}

          {/* Divider: file actions │ view / command actions */}
          {selectedFile && category && (onOpenOutline || onAskAboutFile) && (
            <span className="kb-header-actions-divider" />
          )}

          {/* ── View / command actions ── */}
          {/* Document outline (markdown 专属 —— PDF 大纲在侧边栏里，不重复显示) */}
          {category === 'text' && onOpenOutline && selectedFile && (
            <button
              type="button"
              className="kb-btn kb-btn-ghost"
              onClick={onOpenOutline}
              title={t('kb.moreMenuOutline')}
              data-testid="kb-btn-outline"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          )}

          {/* Edit / Read toggle — markdown 专属（PDF 不支持编辑，不显示） */}
          {category === 'text' && !isTypesetMode && !isCmPath && (
            <button
              type="button"
              className={`kb-btn kb-btn-ghost ${isEditMode ? 'is-active' : ''}`}
              onClick={onToggleEdit}
              title={isEditMode ? t('kb.readMode') : t('kb.editMode')}
              data-testid="kb-btn-edit"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                {isEditMode ? (
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                ) : (
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                )}
                {isEditMode && <circle cx="12" cy="12" r="3" />}
              </svg>
            </button>
          )}

          {/* 💬 Ask about this file — document-scoped, direct (one click) */}
          {onAskAboutFile && selectedFile && (
            <button
              type="button"
              className="kb-btn kb-btn-ghost"
              onClick={onAskAboutFile}
              title={t('kb.askButton')}
              data-testid="kb-btn-ask"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}
            </>
          )}
          {/* 副视图（分屏）关闭 × —— 放入视图自身 header，而非独立副格标题栏 */}
          {onCloseCompanion && (
            <button
              type="button"
              className="kb-btn kb-btn-ghost"
              onClick={onCloseCompanion}
              title={t('kb.close')}
              aria-label={t('kb.close')}
              data-testid="companion-close"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Body: empty states / error / content ── */}
      {!selectedFile ? (
        !vaultId ? (
          <div className="kb-empty-state">
            <div className="kb-empty-icon">📚</div>
            <h3>{t('kb.welcomeTitle')}</h3>
            <p>{t('kb.welcomeBody')}</p>
            <p className="kb-empty-hint">{t('kb.welcomeHint')}</p>
            {/* 原来这段只有说明没按钮——从导航点进来的人到此为止，无路可走 */}
            {onOpenVaultManager && (
              <button
                type="button"
                className="wiki-cta-btn"
                data-testid="kb-empty-create-vault-cta"
                onClick={onOpenVaultManager}
              >
                {t('kb.createVaultCta')}
              </button>
            )}
          </div>
        ) : !wikiInitialized ? (
          /* 未建 Wiki 的两个状态合成一处：同一套结构、同一组按钮，只对调主次。
             没有文件时构建 Wiki 是死路（AI 没有素材可读），所以它不是「次要选项」，
             而是「还不成立的动作」——置灰并在 title 里说明前置条件，让「先导文件、
             再建 Wiki」这个先后关系本身成为引导。

             原先这两态是两段各写各的硬编码中文，英文用户看到的是中文；
             现在共用一份 i18n 文案，也对齐了「这一屏属于同一个页面」的观感。 */
          <div className="kb-empty-state">
            <div className="kb-empty-icon">{importFirst ? '📥' : '🏗'}</div>
            <h3>{importFirst ? t('kb.emptyImportTitle') : t('kb.buildWikiTitle')}</h3>
            <p>{importFirst ? t('kb.emptyImportBody') : t('kb.buildWikiBody')}</p>

            <div className="kb-empty-actions">
              {importFirst
                ? [importButton(true), buildWikiButton(false)]
                : [buildWikiButton(true), importButton(false)]}
            </div>

            {/* 库级问答 CTA —— 不建 Wiki 也能直接对话 */}
            {onAskAboutFile && (
              <button
                type="button"
                className="wiki-cta-btn wiki-cta-btn--ghost"
                data-testid="kb-empty-ask-cta"
                onClick={onAskAboutFile}
              >
                💬 {t('kb.askVault')}
              </button>
            )}
          </div>
        ) : (
          <div className="kb-empty-state">
            <div className="kb-empty-icon">📄</div>
            <h3>{t('kb.noFileTitle')}</h3>
            <p>{t('kb.noFileBody')}</p>
            {/* 库级问答 CTA —— 未打开文件时也能对话（样式复用「开始构建 Wiki」） */}
            {onAskAboutFile && (
              <button type="button" className="wiki-cta-btn" data-testid="kb-empty-ask-cta" onClick={onAskAboutFile}>
                💬 {t('kb.askVault')}
              </button>
            )}
          </div>
        )
      ) : fileLoadError ? (
        <div className="kb-load-error">
          <div className="kb-load-error-icon">⚠</div>
          <p className="kb-load-error-title">{t('kb.cannotOpen')}</p>
          <p className="kb-load-error-path">{selectedFile}</p>
          <p className="kb-load-error-hint">{t('kb.fileNotFound')}</p>
        </div>
      ) : category === 'text' && fileContent?.tooLarge ? (
        <TooLargeCard
          fileName={fileName}
          size={fileContent.size}
          encoding={fileContent.encoding}
          canForce={fileContent.size <= 256 * 1024 * 1024}
          onForce={() => onForceLoad?.()}
          onOpenExternal={isElectron ? handleOpenExternal : undefined}
          onCloseTab={() => onCloseTab?.()}
        />
      ) : category === 'text' && isSmallMd && isTypesetMode ? (
        <MdTypesetEditor
          key={selectedFile}
          initialContent={fileContent?.content ?? ''}
          onContentChange={onContentChange}
          vaultId={vaultId ?? ''}
          selectedFile={selectedFile}
          onNavigateToFile={onNavigateToFile}
        />
      ) : category === 'text' && isSmallMd && isEditMode ? (
        // Edit mode: Milkdown WYSIWYG Markdown editor
        <MdEditor
          initialContent={fileContent?.content ?? ''}
          onContentChange={onContentChange}
          selectedFile={selectedFile}
        />
      ) : category === 'text' && isSmallMd ? (
        <>
          {fmExpanded && (
            <KbFrontmatterCard
              data={frontmatterData}
              onNavigate={onNavigateToFile}
              onCollapse={handleFmCollapse}
            />
          )}
          <div className="kb-content-area" ref={contentRef} onContextMenu={handleContextMenu}>
            {fileContent ? (
              // 优先使用编辑后的内容（未保存的更改），否则使用原始文件内容
              <MdRenderer
                content={renderedContent}
                themeConfig={themeConfig}
                onRendered={setMdRenderedSource}
              />
            ) : (
              <div className="kb-empty-state"><p>Loading...</p></div>
            )}
          </div>
        </>
      ) : category === 'text' && isCmPath ? (
        <div className="kb-content-area kb-cm-area" ref={contentRef}>
          <ViewerErrorBoundary
            key={retryNonce}
            onRetry={() => { setRetryNonce((n) => n + 1); onForceLoad?.(); }}
            onOpenExternal={isElectron ? handleOpenExternal : undefined}
          >
            {isLargeMd && (
              <div className="kb-source-mode-notice">
                {t('kb.largeFileSourceMode', { name: fileName, size: formatFileSize(fileContent?.size ?? 0) })}
              </div>
            )}
            {fileContent?.encoding && fileContent.encoding !== 'utf-8' && (
              <div className="kb-encoding-notice">
                {t('kb.encodingDetected', { encoding: fileContent.encoding })}
              </div>
            )}
            <Suspense fallback={<div className="kb-empty-state"><p>Loading...</p></div>}>
              <KbCodeMirrorViewer
                ref={cmRef}
                content={rawContent}
                fileName={fileName}
                wrap={wrap}
                onRequestContextMenu={handleCmContextMenu}
                onMeasured={handleCmMeasured}
              />
            </Suspense>
          </ViewerErrorBoundary>
        </div>
      ) : category === 'image' && vaultId ? (
        <div className="kb-content-area kb-image-viewer">
          <img
            src={api.rawFileUrl(vaultId, selectedFile)}
            alt={fileName}
          />
        </div>
      ) : category === 'video' && vaultId ? (
        <div className="kb-content-area kb-media-viewer">
          <video
            controls
            preload="metadata"
            src={api.rawFileUrl(vaultId, selectedFile)}
          >
            Your browser does not support video playback.
          </video>
        </div>
      ) : category === 'audio' && vaultId ? (
        <div className="kb-content-area kb-media-viewer">
          <audio
            controls
            preload="metadata"
            src={api.rawFileUrl(vaultId, selectedFile)}
          >
            Your browser does not support audio playback.
          </audio>
        </div>
      ) : category === 'pdf' && vaultId ? (
        <div className="kb-content-area kb-pdf-area" onContextMenu={handlePdfContextMenu}>
          <ViewerErrorBoundary
            key={retryNonce}
            onRetry={() => { setRetryNonce((n) => n + 1); onForceLoad?.(); }}
            onOpenExternal={isElectron ? handleOpenExternal : undefined}
          >
            <Suspense fallback={<div className="kb-empty-state"><p>Loading...</p></div>}>
              <PdfViewer
                ref={pdfRef}
                url={api.rawFileUrl(vaultId, selectedFile)}
                fileName={fileName}
                fileSize={fileContent?.size}
                onOpenExternal={isElectron ? handleOpenExternal : undefined}
                onZoomChange={setPdfZoom}
              />
            </Suspense>
          </ViewerErrorBoundary>
        </div>
      ) : category === 'binary' ? (
        <div className="kb-content-area">
          <div className="kb-file-card">
            <div className="kb-file-card-icon">
              {fileName.endsWith('.pdf') ? '📄' : fileName.match(/\.docx?$/i) ? '📝' : '📁'}
            </div>
            <div className="kb-file-card-info">
              <h3>{fileName}</h3>
              <p>{fileContent ? formatFileSize(fileContent.size) : '—'}</p>
            </div>
            {isElectron && (
              <button type="button" className="kb-file-card-open" onClick={handleOpenExternal}>
                用外部程序打开
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="kb-content-area">
          <div className="kb-empty-state"><p>Loading...</p></div>
        </div>
      )}

      {ctxMenu && (
        <ContextMenu
          items={(() => {
            // CM source: selection text captured at contextmenu-event time
            // (stored in ctxMenu.selectedText). doocs/pdf source: read live
            // window.getSelection() at menu-open.
            const isCmSource = ctxMenu.source === 'codemirror';
            const isPdfSource = ctxMenu.source === 'pdf';
            const sel = isCmSource ? (ctxMenu.selectedText ?? '') : selectionText();
            // Rich triple-slot copy (text/html + text/plain markdown) only for
            // the doocs source — CM has raw text, no rendered HTML to convert.
            // PDF 文本层 span 透明 + transform：复制必须纯文本，禁止 rich HTML 三槽路径。
            const selHtml = isCmSource || isPdfSource ? '' : (() => {
              const s = window.getSelection();
              if (!s || s.rangeCount === 0) return '';
              const div = document.createElement('div');
              div.appendChild(s.getRangeAt(0).cloneContents());
              // doocs/md injects <style> blocks inside #output; strip them so
              // their CSS text doesn't leak into the copied markdown/html.
              div.querySelectorAll('style, script').forEach((el) => el.remove());
              return div.innerHTML;
            })();
            const selMd = (() => {
              if (!selHtml) return sel;
              try {
                const md = getTurndown().turndown(selHtml);
                return md || sel;
              } catch {
                return sel;
              }
            })();
            const items: MenuItem[] = [
              {
                label: t('kb.copy'),
                disabled: !sel,
                onClick: async () => {
                  if (!sel) return;
                  // doocs path: triple-slot copy (text/plain = Markdown +
                  // text/html = rich). CM path: plain text only.
                  if (!isCmSource && selHtml) {
                    try {
                      const item = new ClipboardItem({
                        'text/plain': new Blob([selMd], { type: 'text/plain' }),
                        'text/html': new Blob([selHtml], { type: 'text/html' }),
                      });
                      await navigator.clipboard.write([item]);
                      return;
                    } catch { /* ClipboardItem/write unavailable — fall back */ }
                  }
                  try {
                    await navigator.clipboard.writeText(sel);
                  } catch {
                    // 回退：用遗留命令复制
                    try {
                      const ta = document.createElement('textarea');
                      ta.value = sel;
                      document.body.appendChild(ta);
                      ta.select();
                      document.execCommand('copy');
                      ta.remove();
                    } catch { /* 静默 */ }
                  }
                },
              },
              {
                label: t('kb.ctxSelectAll'),
                onClick: () => {
                  if (isCmSource) {
                    cmRef.current?.selectAll();
                    return;
                  }
                  if (isPdfSource) {
                    pdfRef.current?.selectAll();
                    return;
                  }
                  const out = contentRef.current?.querySelector('#output');
                  if (!out) return;
                  const range = document.createRange();
                  range.selectNodeContents(out);
                  const s = window.getSelection();
                  if (!s) return;
                  s.removeAllRanges();
                  s.addRange(range);
                },
              },
              { divider: true },
              {
                label: t('kb.askSelection'),
                disabled: !sel || sel.length > MAX_ASK_SELECTION,
                title: sel.length > MAX_ASK_SELECTION ? t('kb.selectionTooLarge') : undefined,
                onClick: () => {
                  if (sel && sel.length <= MAX_ASK_SELECTION) onAskAboutSelection?.(sel);
                },
              },
            ];
            return items;
          })()}
          position={ctxMenu}
          onClose={closeContextMenu}
        />
      )}

      {/* Status bar: word count / char count / read time (small-.md doocs path).
          CM path shows size/chars/encoding only — countWords would freeze on a
          15MB document. */}
      {category === 'text' && (
        <div className="kb-status-bar" data-testid="kb-status-bar">
          {(() => {
            const text = editedContent ?? fileContent?.content ?? '';
            if (isCmPath || text.length > 1_000_000) {
              return (
                <>
                  <span>{t('kb.statsChars')}: {text.length.toLocaleString()}</span>
                  <span className="kb-status-sep">/</span>
                  <span>{formatFileSize(text.length)}</span>
                  {fileContent?.encoding && fileContent.encoding !== 'utf-8' && (
                    <>
                      <span className="kb-status-sep">/</span>
                      <span>{fileContent.encoding}</span>
                    </>
                  )}
                </>
              );
            }
            const words = countWords(text);
            return (
              <>
                <span>{t('kb.statsWords')}: {words.toLocaleString()}</span>
                <span className="kb-status-sep">/</span>
                <span>{t('kb.statsChars')}: {text.length.toLocaleString()}</span>
                <span className="kb-status-sep">/</span>
                <span>{t('kb.statsReadTime')}: {formatReadTime(words, t('kb.statsReadTimeSuffix'))}</span>
              </>
            );
          })()}
        </div>
      )}
    </main>
  );
}
