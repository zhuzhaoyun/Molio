/**
 * 图谱引擎类型定义。
 *
 * 引擎（ForceGraphEngine）与数据层（slicing.ts）共享这些类型。
 * 引擎输入由 GraphPage 从 contracts 的 GraphData 归一化而来。
 */

/** 引擎输入节点 —— GraphPage 从 contracts GraphNode 归一化而来 */
export interface EngineNodeInput {
  /** 唯一 id：vault 相对路径，或合成死链节点 `__dead__<name>` */
  key: string;
  /** 显示名（超 14 字符引擎侧截断加省略号） */
  label: string;
  /** 全图度数（daemon 口径），驱动节点半径与标签 LOD */
  linkCount: number;
  /** 决定填充色（NODE_TYPE_COLORS），缺省走调色板默认色 */
  nodeType?: string;
  /** 死链节点 → 空心虚线圆 */
  dead?: boolean;
  /**
   * 画布外隐藏邻居数：>0 时画扩展环（虚线）+ hover ⊕ 按钮。
   * 由 GraphPage 用全图邻接表算好传入（引擎不做数据推断）。
   * 全量画布且无截断时恒为 0；死链节点恒为 0。
   */
  hiddenNeighbors?: number;
}

export interface EngineEdgeInput {
  source: string;
  target: string;
}

export interface EngineData {
  nodes: EngineNodeInput[];
  edges: EngineEdgeInput[];
}

/** setData 的渲染选项 */
export interface RenderOpts {
  /** bloom 合并渲染：复用已有节点 x/y/vx/vy/pinned，不全图重排 */
  preserveLayout?: boolean;
  /** 新节点出生在 anchor 附近（±40px jitter），缺省画布中心 */
  anchorKey?: string;
  /** 渲染完成后选中/高亮该节点并 flyTo 居中（pivot / 搜索落点用） */
  focusKey?: string;
}

/** 引擎 → React 事件回调（构造时传入，可用 updateEvents 热替换） */
export interface EngineEvents {
  /** 去抖后的单击（220ms，双击会取消）→ 选中 + 高亮 + flyTo + 弹卡片 */
  onNodeClick?: (key: string) => void;
  /** 双击 → 打开文档（navigate /knowledge 契约） */
  onNodeDblClick?: (key: string) => void;
  /** Shift+单击 → bloom（GraphPage 在合并不带来新节点时回落 pivot） */
  onNodeShiftClick?: (key: string) => void;
  /** hover 出的 ⊕ 按钮点击 → bloom */
  onBloomRequest?: (key: string) => void;
  /** 选中变化（点背景清空时为 null）→ 驱动卡片显隐 */
  onSelectChange?: (key: string | null) => void;
  /** 背景点击（pan 位移 <5px 判定）→ 关卡片等 */
  onBackgroundClick?: () => void;
}

/** 与 components/graph/types.ts 的 ForceParams 同形（设置面板 4 滑块） */
export interface EngineForceParams {
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
}

/** 节点填充色调色板（hex）—— 明暗主题各一套，来自既有 LIGHT_THEME/DARK_THEME */
export interface NodePalette {
  /** 无类型节点的默认色 */
  node: string;
  /** 孤立节点（linkCount === 0） */
  isolated: string;
  /** 死链节点描边色 */
  dead: string;
  /** 选中态 activeRing / 描边 */
  selected: string;
}

export interface EngineOptions {
  events?: EngineEvents;
}
