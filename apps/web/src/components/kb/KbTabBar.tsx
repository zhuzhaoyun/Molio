/**
 * 通用工作区标签栏组件（Obsidian-style）
 *
 * 布局：左箭头 + 可横向滚动的 tab 列表 + 右箭头 + 下拉 ▾ + 右侧固定全局操作区。
 * active tab 变化时自动滚入可见区。箭头与下拉在后续 task 接入逻辑。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react';
import type { WorkspaceTab } from '../../hooks/useKbTabs';
import { useI18n } from '../../i18n';
import { ContextMenu } from './ContextMenu';
import type { MenuItem } from './ContextMenu';

interface KbTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** "+" button / 右键「新建标签页」— create a fresh blank tab. */
  onAddTab?: () => void;
  /** Double-click a tab or the its right-click menu → toggle pinned. */
  onTogglePin?: (id: string) => void;
  /** Right-click a tab → open it in a new window (Electron IPC or browser popup). */
  onOpenInNewWindow?: (tab: WorkspaceTab) => void;
  /** Right-click a FILE tab → split presets. mode: graph=图谱对照, file=文件对照, copy=左右分屏. */
  onSplit?: (tab: WorkspaceTab, mode: 'graph' | 'file' | 'copy') => void;
  actions?: ReactNode;
}

function tabDisplayTitle(tab: WorkspaceTab, allTabs: WorkspaceTab[]): { display: string; tooltip: string } {
  if (!tab.id.startsWith('file:')) {
    return { display: tab.title, tooltip: tab.title };
  }
  const relPath = tab.id.slice(5);
  const filename = relPath.split('/').pop() ?? relPath;
  const tooltip = relPath;
  const siblings = allTabs.filter(
    (t) => t.id.startsWith('file:') && (t.id.slice(5).split('/').pop() ?? '') === filename,
  );
  if (siblings.length <= 1) return { display: filename, tooltip };
  const slashIdx = relPath.lastIndexOf('/');
  const parentName = slashIdx > 0 ? relPath.slice(0, slashIdx).split('/').pop() : null;
  const candidate = parentName ? `${parentName}/${filename}` : filename;
  const stillCollide =
    siblings.filter((t) => {
      const p = t.id.slice(5);
      const si = p.lastIndexOf('/');
      const pn = si > 0 ? p.slice(0, si).split('/').pop() : null;
      return (pn ? `${pn}/${filename}` : filename) === candidate;
    }).length > 1;
  return { display: stillCollide ? relPath : candidate, tooltip };
}

export function KbTabBar({ tabs, activeTabId, onActivate, onClose, onAddTab, onTogglePin, onOpenInNewWindow, onSplit, actions }: KbTabBarProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ tab: WorkspaceTab; x: number; y: number } | null>(null);
  const [barCtxMenu, setBarCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Tabs currently animating out (close). Their store removal is deferred by
  // the exit transition; the width-collapse + sibling slide plays first.
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  // Track which tabs are genuinely NEW inserts (→ animate the grow-in entrance)
  // vs a rename-in-place (recycle a tab onto a new file — same length, so it
  // swaps content without re-animating). Init with the first tabs so a fresh
  // load of persisted tabs does NOT all animate in.
  const prevIdsRef = useRef<Set<string>>(new Set(tabs.map((t) => t.id)));
  const prevLenRef = useRef(tabs.length);
  useEffect(() => {
    prevIdsRef.current = new Set(tabs.map((t) => t.id));
    prevLenRef.current = tabs.length;
  }, [tabs]);
  const grew = tabs.length > prevLenRef.current;
  const enteredIds = grew
    ? new Set(tabs.filter((t) => !prevIdsRef.current.has(t.id)).map((t) => t.id))
    : new Set<string>();

  // Prune closing ids that no longer exist in the tab list (they were removed).
  useEffect(() => {
    setClosingIds((prev) => {
      const next = new Set([...prev].filter((id) => tabs.some((t) => t.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tabs]);

  // Animate the close: mark the tab as closing so CSS collapses it, then defer
  // the real store removal until the transition finishes. If the close ends up
  // showing a confirm dialog instead (dirty tab) and the tab survives, restore it.
  const requestClose = useCallback((id: string) => {
    setClosingIds((prev) => { const n = new Set(prev); n.add(id); return n; });
    window.setTimeout(() => {
      onClose(id);
      if (tabsRef.current.some((t) => t.id === id)) {
        setClosingIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      }
    }, 190);
  }, [onClose]);

  // Close dropdown on Esc or outside click (button + menu count as one unit).
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideMore = moreRef.current?.contains(target) ?? false;
      const insideDropdown = dropdownRef.current?.contains(target) ?? false;
      if (!insideMore && !insideDropdown) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [menuOpen]);

  const recompute = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 0);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  // Recompute overflow on mount, tab changes, and resize.
  useEffect(() => {
    recompute();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({
      left: dir * el.clientWidth * 0.8,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  };

  // Scroll the active tab into view whenever it changes or a tab is added.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeTabId, tabs.length]);

  // Right-click the tab bar's empty strip → create a new blank tab. Right-click
  // landing on a tab is handled by the tab itself (the event stops there).
  const handleBarContextMenu = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('.kb-wtab')) return;
    e.preventDefault();
    setBarCtxMenu({ x: e.clientX, y: e.clientY });
  };

  if (tabs.length === 0 && !actions) return null;

  return (
    <div className="kb-workspace-tabs">
      <button
        type="button"
        className="kb-wtab-arrow"
        data-testid="kb-tab-arrow-left"
        hidden={!canLeft}
        tabIndex={-1}
        aria-label="向左滚动"
        onClick={() => scrollBy(-1)}
      >‹</button>
      <div className="kb-wtab-scroll" ref={scrollRef} onScroll={recompute} onContextMenu={handleBarContextMenu}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isPinned = !!tab.pinned;
          const isClosing = closingIds.has(tab.id);
          const isEntering = enteredIds.has(tab.id);
          const { display, tooltip } = tabDisplayTitle(tab, tabs);
          return (
            <div
              key={tab.id}
              className={`kb-wtab ${isActive ? 'is-active' : ''} ${isPinned ? 'is-pinned' : ''} ${isClosing ? 'is-closing' : ''} ${isEntering ? 'kb-wtab-enter' : ''}`}
              data-testid={tab.id.startsWith('file:') ? undefined : `kb-wtab-${tab.id}`}
              ref={isActive ? activeRef : null}
              onClick={() => onActivate(tab.id)}
              onDoubleClick={() => onTogglePin?.(tab.id)}
              onContextMenu={(e) => {
                // Right-click on the close × shouldn't pop the tab's context menu.
                if ((e.target as HTMLElement).closest('.kb-wtab-close')) return;
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu({ tab, x: e.clientX, y: e.clientY });
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  requestClose(tab.id);
                }
              }}
              title={tooltip}
            >
              {tab.type === 'graph' && (
                <span className="kb-wtab-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                    <circle cx="6" cy="6" r="2" />
                    <circle cx="18" cy="6" r="2" />
                    <circle cx="12" cy="18" r="2" />
                    <line x1="7.5" y1="7.5" x2="10.5" y2="16.5" />
                    <line x1="16.5" y1="7.5" x2="13.5" y2="16.5" />
                    <line x1="6" y1="8" x2="18" y2="8" />
                  </svg>
                </span>
              )}
              <span className="kb-wtab-title">{display}</span>
              <button
                type="button"
                className="kb-wtab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(tab.id);
                }}
                title="关闭"
              >×</button>
            </div>
          );
        })}
        {/* New-tab button rides directly after the last tab in the scroll row. */}
        <button
          type="button"
          className="kb-wtab-add"
          data-testid="kb-tab-add"
          title={t('kb.newTab')}
          aria-label={t('kb.newTab')}
          onClick={() => onAddTab?.()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        className="kb-wtab-arrow"
        data-testid="kb-tab-arrow-right"
        hidden={!canRight}
        tabIndex={-1}
        aria-label="向右滚动"
        onClick={() => scrollBy(1)}
      >›</button>
      <button
        type="button"
        ref={moreRef}
        className="kb-wtab-more"
        data-testid="kb-tab-more"
        hidden={tabs.length === 0}
        aria-label="全部标签"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >▾</button>
      {menuOpen && (
        <div className="kb-tab-dropdown" data-testid="kb-tab-dropdown" ref={dropdownRef}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const { display, tooltip } = tabDisplayTitle(tab, tabs);
            return (
              <div
                key={tab.id}
                className={`kb-wtab-dropdown-item ${isActive ? 'is-active' : ''}`}
                data-testid="kb-tab-dropdown-item"
                onClick={() => { onActivate(tab.id); setMenuOpen(false); }}
                title={tooltip}
              >
                <span className="kb-wtab-dropdown-title">{display}</span>
                <button
                  type="button"
                  className="kb-wtab-dropdown-close"
                  onClick={(e) => { e.stopPropagation(); requestClose(tab.id); }}
                  title="关闭"
                >×</button>
              </div>
            );
          })}
        </div>
      )}
      {actions && <div className="kb-wtab-actions">{actions}</div>}
      {ctxMenu && (
        <ContextMenu
          items={(() => {
            const tab = ctxMenu.tab;
            const canPin = tab.type === 'file' || tab.type === 'blank';
            const items: MenuItem[] = [
              { label: t('kb.newTab'), testid: 'tab-new-blank', onClick: () => onAddTab?.() },
              { label: '在新窗口打开', testid: 'tab-open-in-new-window', onClick: () => onOpenInNewWindow?.(tab) },
            ];
            if (canPin) {
              items.push({
                label: tab.pinned ? t('kb.unpinTab') : t('kb.pinTab'),
                testid: 'tab-toggle-pin',
                onClick: () => onTogglePin?.(tab.id),
              });
            }
            if (tab.type === 'file') {
              items.push(
                { divider: true },
                { label: t('kb.splitGraph'), testid: 'tab-split-graph', disabled: !onSplit, onClick: () => onSplit?.(tab, 'graph') },
                { label: t('kb.splitFile'), testid: 'tab-split-file', disabled: !onSplit, onClick: () => onSplit?.(tab, 'file') },
                { label: t('kb.splitCopy'), testid: 'tab-split-copy', disabled: !onSplit, onClick: () => onSplit?.(tab, 'copy') },
              );
            }
            return items;
          })()}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {barCtxMenu && (
        <ContextMenu
          items={[{ label: t('kb.newTab'), testid: 'tab-bar-new-tab', onClick: () => onAddTab?.() }]}
          position={{ x: barCtxMenu.x, y: barCtxMenu.y }}
          onClose={() => setBarCtxMenu(null)}
        />
      )}
    </div>
  );
}
