/**
 * ActivityTree — live background subagent/workflow activity.
 *
 * Rendered while (and briefly after) a run has background workers, driven by
 * the daemon's transcript watcher (`activity` SSE events). This is what keeps
 * the chat alive after `turn_end`: the input unlocks, the parent stream is
 * silent, but a Workflow may keep spawning subagents for an hour — the tree
 * shows who's running and what each one is doing right now, mirroring the
 * Claude Code terminal's spinner tree.
 */
import { useState } from 'react';
import type { ActivityInfo } from '@molio/contracts';
import './ActivityTree.css';

interface Props {
  activity: ActivityInfo | null;
}

const MAX_ROWS = 50;

export function ActivityTree({ activity }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  if (!activity || activity.agents.length === 0) return null;

  const running = activity.agents.filter((a) => a.status === 'running').length;
  const done = activity.agents.length - running;
  const shown = activity.agents.slice(0, MAX_ROWS);

  return (
    <div className="activity-tree" data-testid="activity-tree">
      <button
        type="button"
        className="activity-tree-header"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className={`activity-tree-dot${activity.active ? ' active' : ''}`} />
        <span className="activity-tree-title">
          {activity.active ? `后台任务 · ${running} 个运行中` : '后台任务已完成'}
          {done > 0 && ` · ${done} 个完成`}
        </span>
        <span className="activity-tree-chevron">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <ul className="activity-tree-list">
          {shown.map((a) => (
            <li key={a.id} className={`activity-item ${a.status}`} data-testid="activity-item">
              <span className="activity-item-status">
                {a.status === 'running' ? '●' : a.status === 'error' ? '✗' : '✓'}
              </span>
              <span className="activity-item-label" title={a.label}>{a.label}</span>
              {a.lastAction && (
                <span className="activity-item-action" title={a.lastAction}>{a.lastAction}</span>
              )}
            </li>
          ))}
          {activity.agents.length > MAX_ROWS && (
            <li className="activity-item more">… 其余 {activity.agents.length - MAX_ROWS} 个</li>
          )}
        </ul>
      )}
    </div>
  );
}
