// apps/web/src/components/graph/types.ts

import type { NodePalette } from './engine/types.ts';

export interface ForceParams {
  centerStrength: number;   // forceX/forceY strength, default 0.004
  repelStrength: number;    // forceManyBody strength, default -60
  linkStrength: number;     // forceLink strength, default 0.15
  linkDistance: number;     // forceLink distance, default 100
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface GraphSettings {
  theme: ThemeMode;
  nodeScale: number;        // multiplier for nodeSize(), default 1.0
  edgeWidth: number;        // edge line width, default 0.8
  showOrphans: boolean;     // default true
  showDeadLinks: boolean;   // default true
  visibleTypes: string[];   // node types to show, empty = show all
  forces: ForceParams;
}

export interface ThemeColors {
  bg: string;
  node: string;
  isolated: string;
  hover: string;
  selected: string;
  selectedBorder: string;
  edge: string;
  edgeHover: string;
  edgeSelected: string;
  label: string;
  deadNode: string;
  dimmed: string;
}

export const DEFAULT_FORCE_PARAMS: ForceParams = {
  centerStrength: 0.004,
  repelStrength: -60,
  linkStrength: 0.15,
  linkDistance: 100,
};

export const DEFAULT_SETTINGS: GraphSettings = {
  theme: 'light',
  nodeScale: 1.0,
  edgeWidth: 0.8,
  showOrphans: true,
  showDeadLinks: true,
  visibleTypes: [],  // empty = all visible
  forces: { ...DEFAULT_FORCE_PARAMS },
};

export const LIGHT_THEME: ThemeColors = {
  bg: '#FAFAFA',
  node: '#5C5C5C',
  isolated: '#999999',
  hover: '#333333',
  selected: '#8B5CF6',
  selectedBorder: '#7C3AED',
  edge: '#D4D4D4',
  edgeHover: '#C4B5FD',
  edgeSelected: '#8B5CF6',
  label: '#6B6B6B',
  deadNode: '#D4D4D4',
  dimmed: '#F0F0F0',
};

export const DARK_THEME: ThemeColors = {
  bg: '#0F1117',
  node: '#9CA3AF',
  isolated: '#4A5360',
  hover: '#D1D5DB',
  selected: '#8B5CF6',
  selectedBorder: '#7C3AED',
  edge: 'rgba(255,255,255,0.08)',
  edgeHover: 'rgba(139,92,246,0.6)',
  edgeSelected: '#8B5CF6',
  label: '#9CA3AF',
  deadNode: '#4A5360',
  dimmed: '#1A1D2A',
};

/** Resolve theme mode to actual colors, respecting system preference. */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }
  return mode;
}

export function getThemeColors(mode: ThemeMode): ThemeColors {
  return resolveTheme(mode) === 'dark' ? DARK_THEME : LIGHT_THEME;
}

/**
 * 节点类型 → 填充色（单一来源；GraphPage 引擎与设置面板图例共用）。
 * 中性色（文档类）+ 紫色强调（知识核心）+ 琥珀强调（观点/对比）。
 */
export const NODE_TYPE_COLORS: Record<string, string> = {
  // 中性色（文档类）
  document:   '#8899AA',
  source:     '#8899AA',
  wiki:       '#7A8A99',
  // 知识核心（紫色强调）
  concept:    '#8B5CF6',
  entity:     '#8B5CF6',
  // 观点/对比（琥珀强调）
  comparison: '#D97706',
  question:   '#D97706',
  // Legacy types
  tag:        '#8B5CF6',
  agent:      '#8B5CF6',
  project:    '#8899AA',
  workflow:   '#D97706',
  aiModel:    '#D97706',
};

/** 引擎节点调色板（非类型色的兜底部分）按明暗主题取自既有 LIGHT/DARK_THEME 常量 */
export function nodePaletteFor(mode: 'light' | 'dark'): NodePalette {
  const t = mode === 'dark' ? DARK_THEME : LIGHT_THEME;
  return { node: t.node, isolated: t.isolated, dead: t.deadNode, selected: t.selected };
}

export const NODE_TYPE_LABELS: Record<string, string> = {
  document: '文档 / 源文件',
  source: '文档 / 源文件',
  wiki: '文档 / 源文件',
  concept: '概念 / 实体',
  entity: '概念 / 实体',
  comparison: '对比 / 问答',
  question: '对比 / 问答',
  tag: '概念 / 实体',
  agent: '概念 / 实体',
  project: '文档 / 源文件',
  workflow: '对比 / 问答',
  aiModel: '对比 / 问答',
};
