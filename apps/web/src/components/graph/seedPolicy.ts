/**
 * H3 播种精修档（docs/2026-11-25-graph-h3-seeded-positions-design.md §3.3 + builder check 裁定 4）。
 *
 * 引擎拿到布局种子后从什么温度起跑：
 * - 覆盖率 ≥ REFINE_COVERAGE 且用户力参=默认且 nodeScale=1 → 低温快衰减（α=0.1，
 *   实验曲线首帧 ~20px，「出生定形」档）；
 * - 有种子但覆盖不足（图刚改过/增量）→ 中温（α=0.3，实验 D2：10% 失配 52-85px）；
 * - 无种子、或用户改过力参/nodeScale≠1 → 现状档（α=1 + d3 默认衰减）。种子是按
 *   默认配方算的：改过配方后布局需要重新平衡，nodeScale 进 collide 半径——全局
 *   失配下低温精修会卡住，回退最安全（种子此时只是无害初值）。
 */

import {
  REFINE_ALPHA_FULL,
  REFINE_ALPHA_PARTIAL,
  REFINE_ALPHA_DECAY,
  REFINE_COVERAGE,
} from '@molio/contracts';
import { DEFAULT_FORCE_PARAMS, type ForceParams } from './types.ts';

/** d3-force 默认 alphaDecay（现状档原样）。 */
export const D3_DEFAULT_ALPHA_DECAY = 0.0228;

export function planSeedRefine(input: {
  seedCount: number;
  nodeCount: number;
  forces: ForceParams;
  nodeScale: number;
}): { alpha: number; alphaDecay: number } {
  const { seedCount, nodeCount, forces, nodeScale } = input;
  if (seedCount === 0 || nodeCount === 0) return { alpha: 1, alphaDecay: D3_DEFAULT_ALPHA_DECAY };

  const forcesAreDefault =
    forces.repelStrength === DEFAULT_FORCE_PARAMS.repelStrength &&
    forces.centerStrength === DEFAULT_FORCE_PARAMS.centerStrength &&
    forces.linkDistance === DEFAULT_FORCE_PARAMS.linkDistance &&
    forces.linkStrength === DEFAULT_FORCE_PARAMS.linkStrength;
  const recipeIntact = forcesAreDefault && nodeScale === 1;
  if (!recipeIntact) return { alpha: 1, alphaDecay: D3_DEFAULT_ALPHA_DECAY };

  if (seedCount / nodeCount >= REFINE_COVERAGE) return { alpha: REFINE_ALPHA_FULL, alphaDecay: REFINE_ALPHA_DECAY };
  return { alpha: REFINE_ALPHA_PARTIAL, alphaDecay: REFINE_ALPHA_DECAY };
}
