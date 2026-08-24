// apps/web/src/components/graph/useGraphSettings.ts

import { useState, useCallback, useEffect } from 'react';
import {
  DEFAULT_SETTINGS,
  DEFAULT_FORCE_PARAMS,
  SETTINGS_VERSION,
  type GraphSettings,
  type ForceParams,
} from './types.ts';

const STORAGE_KEY = 'molio.graph.settings';

/**
 * 合并持久化设置与默认值，并处理版本迁移。
 *
 * 版本语义变更史：
 *   v1 → v2：Sigma + 逐节点弹簧 → 自研 Quartz 式 PixiJS + d3-force
 *   v2 → v3：力参数默认值对齐 Quartz v4 全局图配方（center 0.2/repel -50/link 30）
 *   v3 → v4：移除 radial 力（圆环布局根源），Obsidian 式有机布局
 *   v4 → v5：对齐 Obsidian graph.json 实测默认（repel -30 / distance 250），节点半径 2x
 *   v5 → v6：密集库放大叠团修复 —— repel -120 + 引擎内置 forceX/Y 约束与 collide 半径×5+4（spacingRatio 1.23 → ~5）
 * forces 四个参数语义随引擎变化，旧值直接套用会产生不可用布局，
 * 因此版本不匹配时重置 forces 为新默认值，其余偏好保留。
 */
export function migrateSettings(parsed: Partial<GraphSettings> | null | undefined): GraphSettings {
  if (!parsed || typeof parsed !== 'object') {
    return { ...DEFAULT_SETTINGS, forces: { ...DEFAULT_FORCE_PARAMS } };
  }

  const merged: GraphSettings = {
    ...DEFAULT_SETTINGS,
    ...parsed,
    forces: { ...DEFAULT_SETTINGS.forces, ...(parsed.forces ?? {}) },
  };

  if (parsed.version !== SETTINGS_VERSION) {
    merged.forces = { ...DEFAULT_FORCE_PARAMS };
    merged.version = SETTINGS_VERSION;
  }

  return merged;
}

function loadSettings(): GraphSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, forces: { ...DEFAULT_FORCE_PARAMS } };
    return migrateSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS, forces: { ...DEFAULT_FORCE_PARAMS } };
  }
}

function saveSettings(s: GraphSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* quota exceeded — silently ignore */ }
}

export function useGraphSettings() {
  const [settings, setSettings] = useState<GraphSettings>(loadSettings);

  // Persist on every change (debounced to avoid excessive writes during slider drags)
  useEffect(() => {
    const timer = setTimeout(() => saveSettings(settings), 300);
    return () => clearTimeout(timer);
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<GraphSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateForce = useCallback((patch: Partial<ForceParams>) => {
    setSettings((prev) => ({
      ...prev,
      forces: { ...prev.forces, ...patch },
    }));
  }, []);

  return { settings, updateSettings, updateForce };
}
