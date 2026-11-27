import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPH_LAYOUT_RECIPE,
  collideRadiusValue,
  autoLinkStrength,
  REFINE_ALPHA_FULL,
  REFINE_ALPHA_PARTIAL,
  REFINE_ALPHA_DECAY,
  REFINE_COVERAGE,
  type GraphData,
  type GraphPositions,
} from '@molio/contracts';

/**
 * H3 Task 1：布局配方单一来源（contracts）。这些常量此前散在 web 引擎
 * （pixiGraphEngine 的 DISTANCE_MIN/CONTAIN_STRENGTH/…、graphUtils 的
 * COLLIDE_* 与 SUPER_HUB_DEGREE、types 的 DEFAULT_FORCE_PARAMS）——daemon 预跑
 * 要复用同款配方，漂移即种子失真，故提到 contracts 钉死。
 */

test('GRAPH_LAYOUT_RECIPE 常量与引擎现值逐字一致', () => {
  assert.equal(GRAPH_LAYOUT_RECIPE.repelStrength, -120);
  assert.equal(GRAPH_LAYOUT_RECIPE.centerStrength, 0.2);
  assert.equal(GRAPH_LAYOUT_RECIPE.linkDistance, 250);
  assert.equal(GRAPH_LAYOUT_RECIPE.linkStrength, 0);
  assert.equal(GRAPH_LAYOUT_RECIPE.distanceMin, 20);
  assert.equal(GRAPH_LAYOUT_RECIPE.containStrength, 0.06);
  assert.equal(GRAPH_LAYOUT_RECIPE.collideIterations, 3);
  assert.equal(GRAPH_LAYOUT_RECIPE.superHubDegree, 60);
  assert.equal(GRAPH_LAYOUT_RECIPE.collideMult, 5);
  assert.equal(GRAPH_LAYOUT_RECIPE.collidePad, 4);
  assert.equal(GRAPH_LAYOUT_RECIPE.collideMax, 100);
});

test('collideRadiusValue：×5+4 封顶 100', () => {
  assert.equal(collideRadiusValue(6), 34);
  assert.equal(collideRadiusValue(200), 100);
  assert.equal(collideRadiusValue(0), 4);
});

test('autoLinkStrength：super-hub 减弱 + 度数加权', () => {
  assert.equal(autoLinkStrength(5, 7), 1 / 5);
  assert.equal(autoLinkStrength(100, 3), 0.1); // hi=100 > 60 → 1/√100
  assert.equal(autoLinkStrength(60, 60), 1 / 60); // 恰在门槛上仍走 min 分支
  assert.equal(autoLinkStrength(1, 1), 1);
});

test('REFINE 精修档常量（设计 §3.3）', () => {
  assert.equal(REFINE_ALPHA_FULL, 0.1);
  assert.equal(REFINE_ALPHA_PARTIAL, 0.3);
  assert.equal(REFINE_ALPHA_DECAY, 0.06);
  assert.equal(REFINE_COVERAGE, 0.8);
});

test('GraphData 可携带 positions（[key, x, y] 三元组数组）', () => {
  const positions: GraphPositions = [
    ['a.md', 12.3, -45.6],
    ['b.md', 0, 1.5],
  ];
  const g: GraphData = { nodes: [], edges: [], deadLinks: [], positions };
  assert.deepEqual(g.positions, positions);
});

test('DEFAULT_FORCE_PARAMS 与 recipe 对应项一致（types.ts 漂移即红）', async () => {
  const { DEFAULT_FORCE_PARAMS } = await import('./types.ts');
  assert.equal(DEFAULT_FORCE_PARAMS.repelStrength, GRAPH_LAYOUT_RECIPE.repelStrength);
  assert.equal(DEFAULT_FORCE_PARAMS.centerStrength, GRAPH_LAYOUT_RECIPE.centerStrength);
  assert.equal(DEFAULT_FORCE_PARAMS.linkDistance, GRAPH_LAYOUT_RECIPE.linkDistance);
  assert.equal(DEFAULT_FORCE_PARAMS.linkStrength, GRAPH_LAYOUT_RECIPE.linkStrength);
});
