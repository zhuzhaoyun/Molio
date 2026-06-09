/**
 * 通用工作区标签栏组件（Obsidian-style）
 */

import type { WorkspaceTab } from '../../hooks/useKbTabs';

interface KbTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

function getTabIcon(type: string): string {
  switch (type) {
    case 'file':
      return '📄';
    default:
      return '📑';
  }
}

export function KbTabBar({ tabs, activeTabId, onActivate, onClose }: KbTabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="kb-workspace-tabs">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`kb-wtab ${isActive ? 'is-active' : ''}`}
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
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
