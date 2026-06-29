/**
 * 通用工作区标签栏组件（Obsidian-style）
 *
 * 布局：左侧可横向滚动的 tab 列表 + 右侧固定（不随 tab 溢出滚走）的全局操作区。
 * 当没有 tab 但传入了 actions 时仍渲染操作区，保证全局入口（如全文搜索）常驻可用。
 */

import type { ReactNode } from 'react';
import type { WorkspaceTab } from '../../hooks/useKbTabs';

interface KbTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 右侧尾部全局操作（vault 级，与当前文档解耦）。 */
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
  if (tabs.length === 0 && !actions) return null;

  return (
    <div className="kb-workspace-tabs">
      <div className="kb-wtab-list">
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
      {actions && <div className="kb-wtab-actions">{actions}</div>}
    </div>
  );
}
