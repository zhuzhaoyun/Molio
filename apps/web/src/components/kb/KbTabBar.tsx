/**
 * 通用工作区标签栏组件（Obsidian-style）
 *
 * 布局：左箭头 + 可横向滚动的 tab 列表 + 右箭头 + 下拉 ▾ + 右侧固定全局操作区。
 * active tab 变化时自动滚入可见区。箭头与下拉在后续 task 接入逻辑。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { WorkspaceTab } from '../../hooks/useKbTabs';

interface KbTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  actions?: ReactNode;
}

function getTabIcon(type: string): string {
  switch (type) {
    case 'file':
      return '📄';
    default:
      return '📑';
  }
}

export function KbTabBar({ tabs, activeTabId, onActivate, onClose, actions }: KbTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Scroll the active tab into view whenever it changes or a tab is added.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeTabId, tabs.length]);

  if (tabs.length === 0 && !actions) return null;

  return (
    <div className="kb-workspace-tabs">
      <button
        type="button"
        className="kb-wtab-arrow"
        data-testid="kb-tab-arrow-left"
        hidden
        tabIndex={-1}
        aria-label="向左滚动"
      >‹</button>
      <div className="kb-wtab-scroll" ref={scrollRef}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={`kb-wtab ${isActive ? 'is-active' : ''}`}
              ref={isActive ? activeRef : null}
              onClick={() => onActivate(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              title={tab.title}
            >
              <span className="kb-wtab-icon">{getTabIcon(tab.type)}</span>
              <span className="kb-wtab-title">{tab.title}</span>
              <button
                type="button"
                className="kb-wtab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                title="关闭"
              >×</button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="kb-wtab-arrow"
        data-testid="kb-tab-arrow-right"
        hidden
        tabIndex={-1}
        aria-label="向右滚动"
      >›</button>
      <button
        type="button"
        className="kb-wtab-more"
        data-testid="kb-tab-more"
        hidden={tabs.length === 0}
        aria-label="全部标签"
      >▾</button>
      {actions && <div className="kb-wtab-actions">{actions}</div>}
    </div>
  );
}
