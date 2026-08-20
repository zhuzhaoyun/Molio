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

interface Props {
  nodes: SearchableNode[];
  onSelect: (key: string, label: string) => void;
}

const MAX_RESULTS = 20;

export function GraphSearchBox({ nodes, onSelect }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const matched: SearchableNode[] = [];
    for (const n of nodes) {
      // 死链接占位节点没有文件，不参与搜索
      if (n.dead) continue;
      if (n.label.toLowerCase().includes(q)) matched.push(n);
    }
    // 排序：前缀匹配优先 > 度数降序（高中心度节点更可能是目标）
    matched.sort((a, b) => {
      const pa = a.label.toLowerCase().startsWith(q) ? 0 : 1;
      const pb = b.label.toLowerCase().startsWith(q) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return b.linkCount - a.linkCount;
    });
    return matched.slice(0, MAX_RESULTS);
  }, [nodes, query]);

  const select = (key: string, label: string) => {
    onSelect(key, label);
    setQuery(label);
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
        if (target) select(target.key, target.label);
        break;
      }
    }
  };

  const showDropdown = open && query.trim() !== '';

  return (
    <div className="graph-search">
      <input
        ref={inputRef}
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
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // 延迟关闭：让选项的 click 先触发（选项已用 mousedown preventDefault 保焦）
          setTimeout(() => setOpen(false), 120);
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
                key={n.key}
                type="button"
                data-testid="graph-search-option"
                data-key={n.key}
                className={`graph-search__option ${i === activeIndex ? 'is-active' : ''}`}
                // 阻止 input 失焦，保证 click 能触发选中
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => select(n.key, n.label)}
              >
                <span className="graph-search__option-label">{n.label}</span>
                <span className="graph-search__option-degree">{n.linkCount}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
