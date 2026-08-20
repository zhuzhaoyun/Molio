import { useState, useRef, useEffect } from 'react';
import type { GraphSettings, ForceParams, ThemeMode } from './types';
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS } from './types';

type Tab = 'filter' | 'appearance' | 'forces' | 'legend';

interface Props {
  settings: GraphSettings;
  onUpdateSettings: (patch: Partial<GraphSettings>) => void;
  onUpdateForce: (patch: Partial<ForceParams>) => void;
  onClose: () => void;
  // Node types present in the current graph data (for checkboxes)
  availableTypes: string[];
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'filter', label: '筛选' },
  { key: 'appearance', label: '外观' },
  { key: 'forces', label: '力度' },
  { key: 'legend', label: '图例' },
];

// Deduplicate and map type keys to labels
function getTypeOptions(availableTypes: string[]): { key: string; label: string }[] {
  const seen = new Set<string>();
  const result: { key: string; label: string }[] = [];
  for (const t of availableTypes) {
    if (seen.has(t)) continue;
    seen.add(t);
    result.push({ key: t, label: NODE_TYPE_LABELS[t] ?? t });
  }
  return result;
}

export function GraphSettingsPanel({ settings, onUpdateSettings, onUpdateForce, onClose, availableTypes }: Props) {
  const [tab, setTab] = useState<Tab>('filter');
  const panelRef = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't close when clicking the settings button — the button's own
      // click handler toggles the panel.  Intercepting it here would cause a
      // double-toggle (mousedown closes, click re-opens).
      if (target.closest('.graph-settings-btn')) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay registration to avoid the open-click itself triggering close
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  const typeOptions = getTypeOptions(availableTypes);

  const isTypeVisible = (type: string) =>
    settings.visibleTypes.length === 0 || settings.visibleTypes.includes(type);

  const toggleType = (type: string) => {
    if (isTypeVisible(type)) {
      // Hide this type
      if (settings.visibleTypes.length === 0) {
        // Currently showing all — build explicit list excluding this one
        onUpdateSettings({ visibleTypes: typeOptions.map(t => t.key).filter(k => k !== type) });
      } else {
        const next = settings.visibleTypes.filter(t => t !== type);
        onUpdateSettings({ visibleTypes: next });
      }
    } else {
      // Show this type
      const next = [...settings.visibleTypes, type];
      // If we now have all types, reset to empty (empty = show all)
      const allTypes = typeOptions.map(t => t.key);
      const hasAll = allTypes.every(t => next.includes(t));
      onUpdateSettings({ visibleTypes: hasAll ? [] : next });
    }
  };

  return (
    <div className="graph-settings-panel" ref={panelRef}>
      {/* Tab bar */}
      <div className="graph-settings__tabs">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            className={`graph-settings__tab ${tab === key ? 'is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="graph-settings__body">
        {/* ── Filter Tab ── */}
        {tab === 'filter' && (
          <div className="graph-settings__section">
            {typeOptions.length > 0 && (
              <div className="graph-settings__group">
                <div className="graph-settings__group-title">按类型筛选</div>
                {typeOptions.map(({ key, label }) => (
                  <label key={key} className="graph-settings__checkbox">
                    <input
                      type="checkbox"
                      checked={isTypeVisible(key)}
                      onChange={() => toggleType(key)}
                    />
                    <span className="graph-settings__checkbox-dot" style={{ background: NODE_TYPE_COLORS[key] ?? '#8899AA' }} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            )}

            <div className="graph-settings__group">
              <div className="graph-settings__group-title">其他</div>
              <label className="graph-settings__checkbox">
                <input
                  type="checkbox"
                  checked={settings.showOrphans}
                  onChange={() => onUpdateSettings({ showOrphans: !settings.showOrphans })}
                />
                <span>孤立节点</span>
              </label>
              <label className="graph-settings__checkbox">
                <input
                  type="checkbox"
                  checked={settings.showDeadLinks}
                  onChange={() => onUpdateSettings({ showDeadLinks: !settings.showDeadLinks })}
                />
                <span>死链接</span>
              </label>
            </div>
          </div>
        )}

        {/* ── Appearance Tab ── */}
        {tab === 'appearance' && (
          <div className="graph-settings__section">
            <div className="graph-settings__group">
              <label className="graph-settings__label">主题</label>
              <select
                className="graph-settings__select"
                value={settings.theme}
                onChange={(e) => onUpdateSettings({ theme: e.target.value as ThemeMode })}
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
                <option value="system">跟随系统</option>
              </select>
            </div>

            <div className="graph-settings__group">
              <label className="graph-settings__label">节点大小 ({settings.nodeScale.toFixed(1)}x)</label>
              <input
                className="graph-settings__range"
                type="range"
                min="0.5"
                max="3.0"
                step="0.1"
                value={settings.nodeScale}
                onChange={(e) => onUpdateSettings({ nodeScale: parseFloat(e.target.value) })}
              />
            </div>

            <div className="graph-settings__group">
              <label className="graph-settings__label">连线粗细 ({settings.edgeWidth.toFixed(1)})</label>
              <input
                className="graph-settings__range"
                type="range"
                min="0.3"
                max="3.0"
                step="0.1"
                value={settings.edgeWidth}
                onChange={(e) => onUpdateSettings({ edgeWidth: parseFloat(e.target.value) })}
              />
            </div>
          </div>
        )}

        {/* ── Forces Tab ── */}
        {tab === 'forces' && (
          <div className="graph-settings__section">
            <SliderControl
              label="向心力"
              min={0}
              max={1}
              step={0.01}
              value={settings.forces.centerStrength}
              onChange={(v) => onUpdateForce({ centerStrength: v })}
            />
            <SliderControl
              label="排斥力"
              min={-300}
              max={-10}
              step={1}
              value={settings.forces.repelStrength}
              onChange={(v) => onUpdateForce({ repelStrength: v })}
            />
            <SliderControl
              label="连线拉力"
              min={0}
              max={1}
              step={0.01}
              value={settings.forces.linkStrength}
              onChange={(v) => onUpdateForce({ linkStrength: v })}
              format={(v) => (v === 0 ? '自动' : v.toFixed(2))}
            />
            <SliderControl
              label="连线距离"
              min={20}
              max={500}
              step={1}
              value={settings.forces.linkDistance}
              onChange={(v) => onUpdateForce({ linkDistance: v })}
            />
          </div>
        )}

        {/* ── Legend Tab ── */}
        {tab === 'legend' && (
          <div className="graph-settings__section">
            <div className="graph-settings__group">
              <div className="graph-settings__group-title">节点颜色</div>
              <div className="graph-legend">
                <div className="graph-legend__item">
                  <span className="graph-legend__dot" style={{ background: NODE_TYPE_COLORS.document }} />
                  <span className="graph-legend__label">文档 / 源文件</span>
                </div>
                <div className="graph-legend__item">
                  <span className="graph-legend__dot" style={{ background: NODE_TYPE_COLORS.concept }} />
                  <span className="graph-legend__label">概念 / 实体</span>
                </div>
                <div className="graph-legend__item">
                  <span className="graph-legend__dot" style={{ background: NODE_TYPE_COLORS.comparison }} />
                  <span className="graph-legend__label">对比 / 问答</span>
                </div>
              </div>
            </div>
            <div className="graph-settings__group">
              <div className="graph-settings__group-title">操作</div>
              <div className="graph-info__hints">
                <div className="graph-hint">拖拽节点 · 邻居联动</div>
                <div className="graph-hint">单击选中 · 高亮关联</div>
                <div className="graph-hint">双击节点 · 打开文章</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Reusable labeled range slider for force parameters. */
function SliderControl({ label, min, max, step, value, onChange, format }: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  /** 自定义数值展示（如 linkStrength 的 0 = 自动） */
  format?: (v: number) => string;
}) {
  const display = format
    ? format(value)
    : (Number.isInteger(step) ? String(value) : value.toFixed(2));
  return (
    <div className="graph-settings__group">
      <label className="graph-settings__label">
        {label} ({display})
      </label>
      <input
        className="graph-settings__range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}
