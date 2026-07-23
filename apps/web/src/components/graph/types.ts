// apps/web/src/components/graph/types.ts

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
  centerStrength: 0.002,   // 全局向心引力（减弱，配合 rest→0）
  repelStrength: -100,     // 增强排斥力，节点更均匀散开
  linkStrength: 0.3,       // 边弹簧更硬：抵抗全局排斥，把相连节点拉近、簇内紧凑
  linkDistance: 55,        // 边自然长度缩短：对齐 Obsidian 的紧凑连接距离
};

/** Parameters for multi-level layout (Walshaw coarsening). */
export interface MultiLevelParams {
  /** Callback for progress reporting. phase: stage name, progress: 0-1. */
  onProgress?: (phase: string, progress: number) => void;
  /** Maximum coarsening rounds. Default 5. */
  maxLevels?: number;
  /** Stop when graph shrinks below this fraction. Default 0.05. */
  minSizeFraction?: number;
  /** Minimum node count to trigger ML. Below this uses regular d3-force. Default 50. */
  minNodes?: number;
  /** Refinement tick count on the original graph. Default 80. */
  refineTicks?: number;
}

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
  // 节点淡化色：可见的中灰（对齐 Obsidian「降饱和但保持可读」），不融于背景
  dimmed: '#C8C8C8',
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
  // 节点淡化色：可见的暗灰，不融于深色背景
  dimmed: '#3A3F4D',
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
