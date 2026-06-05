/**
 * MdStylePanel — Theme and style configuration panel for doocs/md rendering.
 *
 * Provides controls for:
 * - Theme selection (classic, graceful, simple)
 * - Font family
 * - Font size
 * - Primary color
 * - Display options (indent, justify, code styling)
 */

import { useCallback } from 'react';

export interface ThemeConfig {
  /** Theme name: 'default' | 'grace' | 'simple' */
  themeName: string;
  /** Primary accent color */
  primaryColor: string;
  /** Font family */
  fontFamily: string;
  /** Font size (px) */
  fontSize: string;
  /** Enable paragraph first-line indent */
  isUseIndent: boolean;
  /** Enable text justify */
  isUseJustify: boolean;
  /** Enable Mac-style code blocks */
  isMacCodeBlock: boolean;
  /** Show line numbers in code blocks */
  isShowLineNumber: boolean;
  /** Custom CSS (optional) */
  customCSS?: string;
}

export const defaultThemeConfig: ThemeConfig = {
  themeName: 'default',
  primaryColor: '#3b82f6',
  fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: '15px',
  isUseIndent: true,
  isUseJustify: true,
  isMacCodeBlock: true,
  isShowLineNumber: false,
};

export interface MdStylePanelProps {
  /** Current theme configuration */
  config: ThemeConfig;
  /** Callback when config changes */
  onChange: (config: ThemeConfig) => void;
  /** Whether panel is visible */
  visible: boolean;
  /** Close panel callback */
  onClose: () => void;
}

// Theme options
const THEMES = [
  { name: 'default', label: '经典', preview: '#fff' },
  { name: 'grace', label: '优雅', preview: '#faf9f6' },
  { name: 'simple', label: '简洁', preview: '#fff' },
];

// Font options
const FONTS = [
  { label: '无衬线 (Sans-serif)', value: '-apple-system, "Segoe UI", Roboto, sans-serif' },
  { label: '衬线 (Serif)', value: 'Georgia, "Songti SC", serif' },
  { label: '等宽 (Monospace)', value: '"SF Mono", "Fira Code", monospace' },
];

// Size options
const SIZES = [
  { label: '更小', value: '13px' },
  { label: '稍小', value: '14px' },
  { label: '推荐', value: '15px' },
  { label: '稍大', value: '16px' },
  { label: '更大', value: '17px' },
];

// Color options
const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
  '#d97744', '#6b7280',
];

export function MdStylePanel({ config, onChange, visible, onClose }: MdStylePanelProps) {
  const updateConfig = useCallback(
    (updates: Partial<ThemeConfig>) => {
      onChange({ ...config, ...updates });
    },
    [config, onChange]
  );

  if (!visible) return null;

  return (
    <div className="kb-style-panel">
      <div className="kb-style-panel-header">
        <span>样式设置</span>
        <button className="kb-style-close" onClick={onClose}>×</button>
      </div>

      <div className="kb-style-panel-content">
        {/* Theme Selection */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">主题风格</div>
          <div className="kb-theme-grid">
            {THEMES.map((theme) => (
              <div
                key={theme.name}
                className={`kb-theme-option ${config.themeName === theme.name ? 'is-selected' : ''}`}
                onClick={() => updateConfig({ themeName: theme.name })}
              >
                <div className="kb-theme-preview" style={{ background: theme.preview }} />
                <div className="kb-theme-name">{theme.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Font Selection */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">字体</div>
          <div className="kb-font-list">
            {FONTS.map((font) => (
              <div
                key={font.value}
                className={`kb-font-item ${config.fontFamily === font.value ? 'is-selected' : ''}`}
                onClick={() => updateConfig({ fontFamily: font.value })}
              >
                {font.label}
              </div>
            ))}
          </div>
        </div>

        {/* Font Size */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">字号</div>
          <div className="kb-size-list">
            {SIZES.map((size) => (
              <div
                key={size.value}
                className={`kb-size-item ${config.fontSize === size.value ? 'is-selected' : ''}`}
                onClick={() => updateConfig({ fontSize: size.value })}
              >
                {size.label}
              </div>
            ))}
          </div>
        </div>

        {/* Primary Color */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">主题色</div>
          <div className="kb-color-grid">
            {COLORS.map((color) => (
              <div
                key={color}
                className={`kb-color-option ${config.primaryColor === color ? 'is-selected' : ''}`}
                style={{ background: color }}
                onClick={() => updateConfig({ primaryColor: color })}
              />
            ))}
          </div>
        </div>

        {/* Options */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">选项</div>

          <ToggleOption
            label="段落首行缩进"
            value={config.isUseIndent}
            onChange={(v) => updateConfig({ isUseIndent: v })}
          />
          <ToggleOption
            label="段落两端对齐"
            value={config.isUseJustify}
            onChange={(v) => updateConfig({ isUseJustify: v })}
          />
          <ToggleOption
            label="Mac 代码块样式"
            value={config.isMacCodeBlock}
            onChange={(v) => updateConfig({ isMacCodeBlock: v })}
          />
          <ToggleOption
            label="代码块行号"
            value={config.isShowLineNumber}
            onChange={(v) => updateConfig({ isShowLineNumber: v })}
          />
        </div>
      </div>
    </div>
  );
}

// Toggle switch component
function ToggleOption({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="kb-toggle-option">
      <span className="kb-toggle-label">{label}</span>
      <div
        className={`kb-toggle-switch ${value ? 'is-on' : ''}`}
        onClick={() => onChange(!value)}
      />
    </div>
  );
}
