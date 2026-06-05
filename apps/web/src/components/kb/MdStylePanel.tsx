/**
 * MdStylePanel — Theme and style configuration panel for doocs/md rendering.
 *
 * Embedded sidebar panel providing controls for:
 * - Theme selection (classic, graceful, simple)
 * - Font family, font size, primary color
 * - Code block theme (80+ highlight.js themes)
 * - Heading styles (per-level: h1-h6)
 * - Preview width (mobile 375px / desktop full)
 * - Legend display mode
 * - Toggle options (indent, justify, Mac code, line numbers, cite, count)
 */

import { useCallback } from 'react';
import type { IConfigOption } from '@molio/doocs-md/shared/types/common';
import {
  fontFamilyOptions,
  fontSizeOptions,
  colorOptions,
  widthOptions,
  codeBlockThemeOptions,
  headingLevelOptions,
  headingStyleOptions,
  legendOptions,
  type HeadingLevel,
  type HeadingStyleType,
  type HeadingStyles,
} from '@molio/doocs-md/shared/configs/style';

export type { HeadingLevel, HeadingStyleType, HeadingStyles };

export interface ThemeConfig {
  /** Theme name: 'default' | 'grace' | 'simple' */
  themeName: string;
  /** Primary accent color */
  primaryColor: string;
  /** Font family CSS value */
  fontFamily: string;
  /** Font size (px) */
  fontSize: string;
  /** Code block theme CSS URL */
  codeBlockTheme: string;
  /** Heading styles per level */
  headingStyles: HeadingStyles;
  /** Image legend display mode */
  legend: string;
  /** Preview width: mobile (375px) or desktop (full) */
  previewWidth: 'mobile' | 'desktop';
  /** Enable paragraph first-line indent */
  isUseIndent: boolean;
  /** Enable text justify */
  isUseJustify: boolean;
  /** Enable Mac-style code blocks */
  isMacCodeBlock: boolean;
  /** Show line numbers in code blocks */
  isShowLineNumber: boolean;
  /** Enable cite status */
  citeStatus: boolean;
  /** Enable count status */
  countStatus: boolean;
  /** Custom CSS (optional) */
  customCSS?: string;
}

export const defaultThemeConfig: ThemeConfig = {
  themeName: 'default',
  primaryColor: colorOptions[0]!.value,
  fontFamily: fontFamilyOptions[0]!.value,
  fontSize: fontSizeOptions[2]!.value,
  codeBlockTheme: codeBlockThemeOptions[23]!.value, // 'github'
  headingStyles: {},
  legend: legendOptions[0]!.value,
  previewWidth: 'mobile',
  isUseIndent: false,
  isUseJustify: true,
  isMacCodeBlock: true,
  isShowLineNumber: false,
  citeStatus: false,
  countStatus: false,
};

export interface MdStylePanelProps {
  /** Current theme configuration */
  config: ThemeConfig;
  /** Callback when config changes */
  onChange: (config: ThemeConfig) => void;
}

// Theme options
const THEMES = [
  { name: 'default', label: '经典', preview: '#fff' },
  { name: 'grace', label: '优雅', preview: '#faf9f6' },
  { name: 'simple', label: '简洁', preview: '#fff' },
];

export function MdStylePanel({ config, onChange }: MdStylePanelProps) {
  const updateConfig = useCallback(
    (updates: Partial<ThemeConfig>) => {
      onChange({ ...config, ...updates });
    },
    [config, onChange]
  );

  const updateHeadingStyle = useCallback(
    (level: HeadingLevel, style: HeadingStyleType) => {
      const newHeadingStyles = { ...config.headingStyles };
      if (style === 'default') {
        delete newHeadingStyles[level];
      } else {
        (newHeadingStyles as Record<string, string>)[level] = style;
      }
      updateConfig({ headingStyles: newHeadingStyles as HeadingStyles });
    },
    [config.headingStyles, updateConfig]
  );

  return (
    <aside className="kb-style-panel">
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

        {/* Font Family */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">字体</div>
          <div className="kb-font-list">
            {fontFamilyOptions.map((font) => (
              <div
                key={font.value}
                className={`kb-font-item ${config.fontFamily === font.value ? 'is-selected' : ''}`}
                onClick={() => updateConfig({ fontFamily: font.value })}
              >
                <span className="kb-font-label">{font.label}</span>
                <span className="kb-font-desc">{font.desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Font Size */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">字号</div>
          <div className="kb-size-list">
            {fontSizeOptions.map((size) => (
              <div
                key={size.value}
                className={`kb-size-item ${config.fontSize === size.value ? 'is-selected' : ''}`}
                onClick={() => updateConfig({ fontSize: size.value })}
              >
                <span className="kb-size-label">{size.label}</span>
                <span className="kb-size-desc">{size.desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Primary Color */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">主题色</div>
          <div className="kb-color-grid">
            {colorOptions.map((color) => (
              <div
                key={color.value}
                className={`kb-color-option ${config.primaryColor === color.value ? 'is-selected' : ''}`}
                style={{ background: color.value }}
                title={`${color.label} — ${color.desc}`}
                onClick={() => updateConfig({ primaryColor: color.value })}
              />
            ))}
          </div>
        </div>

        {/* Code Block Theme */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">代码块主题</div>
          <select
            className="kb-style-select"
            value={config.codeBlockTheme}
            onChange={(e) => updateConfig({ codeBlockTheme: e.target.value })}
          >
            {codeBlockThemeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Heading Styles */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">标题样式</div>
          <div className="kb-heading-styles">
            {headingLevelOptions.map((level) => {
              const currentStyle = (config.headingStyles as Record<string, string>)[level.value] ?? 'default';
              return (
                <div key={level.value} className="kb-heading-row">
                  <span className="kb-heading-level">{level.label}</span>
                  <select
                    className="kb-style-select kb-heading-select"
                    value={currentStyle}
                    onChange={(e) => updateHeadingStyle(level.value as HeadingLevel, e.target.value as HeadingStyleType)}
                  >
                    {headingStyleOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        {/* Legend */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">图片说明</div>
          <select
            className="kb-style-select"
            value={config.legend}
            onChange={(e) => updateConfig({ legend: e.target.value })}
          >
            {legendOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Preview Width */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">预览宽度</div>
          <div className="kb-width-list">
            {widthOptions.map((opt) => {
              const isMobile = opt.value === 'w-[375px]';
              const isSelected = isMobile
                ? config.previewWidth === 'mobile'
                : config.previewWidth === 'desktop';
              return (
                <div
                  key={opt.value}
                  className={`kb-width-item ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => updateConfig({ previewWidth: isMobile ? 'mobile' : 'desktop' })}
                >
                  <span className="kb-width-icon">{isMobile ? '📱' : '🖥️'}</span>
                  <span className="kb-width-label">{opt.label}</span>
                  <span className="kb-width-desc">{opt.desc}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Options */}
        <div className="kb-style-section">
          <div className="kb-style-section-title">排版选项</div>

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
          <ToggleOption
            label="引用状态"
            value={config.citeStatus}
            onChange={(v) => updateConfig({ citeStatus: v })}
          />
          <ToggleOption
            label="字数统计"
            value={config.countStatus}
            onChange={(v) => updateConfig({ countStatus: v })}
          />
        </div>
      </div>
    </aside>
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