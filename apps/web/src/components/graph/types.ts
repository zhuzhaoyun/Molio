// apps/web/src/components/graph/types.ts

/**
 * 力参数语义（v6，Obsidian 式有机布局，无 radial 力；引擎内置 forceX/Y 约束与放大 collide）：
 * - centerStrength: forceCenter().strength()，整体居中（平移）
 * - repelStrength:  forceManyBody().strength()，负值排斥（Obsidian repel 10 的 d3 近似 ≈ -30）
 * - linkStrength:   forceLink().strength()，0 = 自动（d3 默认按度数加权，hub 连线自动变软）
 * - linkDistance:   forceLink().distance()，连线静息长度（Obsidian 默认 250）
 *
 * v1 Sigma + 逐节点弹簧；v2 自研 Quartz 式；v3 对齐 Quartz 默认；v4 移除 radial 力；
 * v5 对齐 Obsidian graph.json 实测默认（repel -30 / distance 250 / 节点半径 2x）。
 * 版本升级时旧 forces 值会被重置（见 useGraphSettings.migrateSettings）。
 */
export interface ForceParams {
  centerStrength: number;   // forceCenter strength, default 0.3
  repelStrength: number;    // forceManyBody strength, default -80
  linkStrength: number;     // forceLink strength, 0 = auto, default 0
  linkDistance: number;     // forceLink distance, default 50
}

export type ThemeMode = 'light' | 'dark' | 'system';

/** 持久化结构版本号，语义变更时递增以触发迁移 */
export const SETTINGS_VERSION = 6;

export interface GraphSettings {
  version: number;          // 持久化结构版本（SETTINGS_VERSION）
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

// Obsidian 式有机布局配方 v6（在史记等密集库上由离线 harness 标定）：\r
//   密集图（平均度数 ~10）里仅靠 charge 无法撑开局部间距（spacingRatio 1.23，放大即叠团）。\r
//   v6 = 中等排斥(-120) + forceX/Y 谐波约束(0.06，引擎内置) 控制整体范围 +\r
//   collide 半径 = 绘制半径×5+4（引擎内置）撑开局部 → spacingRatio ~5，\r
//   远看均布、放大后节点彼此分离，与 Obsidian 缩放行为一致。\r
// 节点半径 = (2 + sqrt(度数)) * 2 * nodeScale，collide iterations 3。\r
export const DEFAULT_FORCE_PARAMS: ForceParams = {
  centerStrength: 0.2,
  repelStrength: -120,
  linkStrength: 0,   // 0 = d3 默认（按度数加权）
  linkDistance: 250,
};

export const DEFAULT_SETTINGS: GraphSettings = {
  version: SETTINGS_VERSION,
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
  // Obsidian 淡边：~10% 不透明，让节点而非边成为视觉主体
  edge: 'rgba(0,0,0,0.10)',
  edgeHover: '#C4B5FD',
  edgeSelected: '#8B5CF6',
  label: '#6B6B6B',
  deadNode: '#D4D4D4',
  dimmed: 'rgba(0,0,0,0.04)',
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
 * 节点类型颜色（单一来源）：引擎渲染、设置面板图例/筛选色点共用。
 * 中性色=文档类，紫色=知识核心，琥珀=观点/对比。
 */
export const NODE_TYPE_COLORS: Record<string, string> = {
  // 中性色（文档类）
  document: '#8899AA',
  source: '#8899AA',
  wiki: '#7A8A99',
  // 知识核心（紫色强调）
  concept: '#8B5CF6',
  entity: '#8B5CF6',
  // 观点/对比（琥珀强调）
  comparison: '#D97706',
  question: '#D97706',
  // Legacy types
  tag: '#8B5CF6',
  agent: '#8B5CF6',
  project: '#8899AA',
  workflow: '#D97706',
  aiModel: '#D97706',
};

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
