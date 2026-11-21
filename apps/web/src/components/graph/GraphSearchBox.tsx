/**
 * GraphSearchBox — 图谱顶栏节点搜索框。
 *
 * 在当前可见节点（已过滤，尊重筛选设置）中按 label 模糊匹配，
 * 下拉候选支持键盘 ↑↓/Enter/Escape；选中后由 GraphPage 调
 * engine.focusNode(key) 平滑居中缩放并选中。
 *
 * 纯前端实现：数据来自 GraphPage 的 engineData，无额外请求。
 */

import { useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';

export interface SearchableNode {
  key: string;
  label: string;
  linkCount: number;
  dead?: boolean;
}

/** trunk 态的簇候选（T2）：命中簇名 → 高亮该簇（不切视图） */
export interface SearchableCluster {
  id: string;
  label: string;
  size: number;
}

interface Props {
  nodes: SearchableNode[];
  onSelect: (key: string, label: string) => void;
  /** trunk 态传入：候选合并簇名匹配（按 size 降序），选中走 onSelectCluster */
  clusters?: SearchableCluster[];
  onSelectCluster?: (id: string) => void;
  /** Focus the input on mount — used when the collapsed icon expands to the field. */
  autoFocus?: boolean;
}

interface SearchOption {
  kind: 'node' | 'cluster';
  key: string;
  label: string;
  /** 右侧元信息：节点=度数，簇=成员数 */
  meta: number;
  dead: boolean;
  prefixMatch: boolean;
  weight: number;
}

const MAX_RESULTS = 20;

export function GraphSearchBox({ nodes, onSelect, clusters, onSelectCluster, autoFocus }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // 延迟关闭定时器：onFocus 必须取消它——select() 触发 blur 后 120ms 内重新聚焦/输入时，
  // 残留定时器会把刚打开的下拉再关掉（慢机上「搜索→再搜」必现，CI 实抓）
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const results = useMemo<SearchOption[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const matched: SearchOption[] = [];
    for (const n of nodes) {
      // 死链接占位节点没有文件，不参与搜索
      if (n.dead) continue;
      if (n.label.toLowerCase().includes(q)) {
        matched.push({
          kind: 'node',
          key: n.key,
          label: n.label,
          meta: n.linkCount,
          dead: false,
          prefixMatch: n.label.toLowerCase().startsWith(q),
          weight: n.linkCount,
        });
      }
    }
    // trunk 态：簇名也参与匹配（节点优先，簇按成员数降序缀后）
    if (clusters) {
      for (const c of clusters) {
        if (c.label.toLowerCase().includes(q)) {
          matched.push({
            kind: 'cluster',
            key: c.id,
            label: c.label,
            meta: c.size,
            dead: false,
            prefixMatch: c.label.toLowerCase().startsWith(q),
            weight: c.size,
          });
        }
      }
    }
    // 排序：前缀匹配优先 > 权重降序（节点=度数、簇=成员数）；节点整体排在簇前
    matched.sort((a, b) => {
      if (a.prefixMatch !== b.prefixMatch) return a.prefixMatch ? -1 : 1;
      if (a.kind !== b.kind) return a.kind === 'node' ? -1 : 1;
      return b.weight - a.weight;
    });
    return matched.slice(0, MAX_RESULTS);
  }, [nodes, clusters, query]);

  const select = (opt: SearchOption) => {
    if (opt.kind === 'cluster') onSelectCluster?.(opt.key);
    else onSelect(opt.key, opt.label);
    setQuery(opt.label);
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || results.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % results.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + results.length) % results.length);
        break;
      case 'Enter': {
        e.preventDefault();
        const target = results[Math.min(activeIndex, results.length - 1)];
        if (target) select(target);
        break;
      }
    }
  };

  const showDropdown = open && query.trim() !== '';

  return (
    <div className="graph-search">
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        data-testid="graph-search-input"
        className="graph-search__input"
        type="text"
        value={query}
        placeholder={t('graph.searchPlaceholder')}
        role="combobox"
        aria-expanded={showDropdown}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onFocus={() => {
          cancelCloseTimer();
          setOpen(true);
        }}
        onBlur={() => {
          // 延迟关闭：让选项的 click 先触发（选项已用 mousedown preventDefault 保焦）
          cancelCloseTimer();
          closeTimerRef.current = setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={onKeyDown}
      />
      {showDropdown && (
        <div className="graph-search__results" data-testid="graph-search-results">
          {results.length === 0 ? (
            <div className="graph-search__empty" data-testid="graph-search-empty">
              {t('graph.searchNoResult')}
            </div>
          ) : (
            results.map((n, i) => (
              <button
                key={`${n.kind}:${n.key}`}
                type="button"
                data-testid="graph-search-option"
                data-kind={n.kind}
                data-key={n.key}
                className={`graph-search__option ${i === activeIndex ? 'is-active' : ''}`}
                // 阻止 input 失焦，保证 click 能触发选中
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => select(n)}
              >
                <span className="graph-search__option-label">
                  {n.kind === 'cluster' ? '◍ ' : ''}
                  {n.label}
                </span>
                <span className="graph-search__option-degree">{n.meta}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
