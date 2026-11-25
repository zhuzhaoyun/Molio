// apps/web/src/components/graph/useGraphSettings.ts

import { useState, useCallback, useEffect } from 'react';
import {
  DEFAULT_FORCE_PARAMS,
  SETTINGS_VERSION,
  defaultSettings,
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
 *   v6 → v7：新增 globalView（全局视图：枝干/全量，trunk 视图 T2）——力参语义未变，
 *            v6 升级只补字段、保留用户力参
 * forces 四个参数语义在 v1..v5 间随引擎变化，旧值直接套用会产生不可用布局，
 * 因此 version < 6 时重置 forces 为新默认值，其余偏好（含 v6+ 的力参）保留。
 */
export function migrateSettings(parsed: Partial<GraphSettings> | null | undefined): GraphSettings {
  if (!parsed || typeof parsed !== 'object') {
    return defaultSettings();
  }

  const base = defaultSettings();
  const merged: GraphSettings = {
    ...base,
    ...parsed,
    globalView: parsed.globalView === 'full' ? 'full' : 'trunk',
    forces: { ...base.forces, ...(parsed.forces ?? {}) },
  };

  if (parsed.version !== SETTINGS_VERSION) {
    if ((parsed.version ?? 0) < 6) {
      merged.forces = { ...DEFAULT_FORCE_PARAMS };
    }
    merged.version = SETTINGS_VERSION;
  }

  return merged;
}

type GlobalView = GraphSettings['globalView'];
const VIEW_COOKIE = 'molio.graph.globalView';

function loadSettings(desktopPanel: boolean): GraphSettings {
  let parsed: Partial<GraphSettings> | null = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch { /* A malformed preference falls back to defaults. */ }
  const settings = migrateSettings(parsed);
  if (desktopPanel) {
    // The sidecar has a new port each launch. Host cookies survive that origin change.
    const saved = document.cookie.split('; ').find(item => item.startsWith(VIEW_COOKIE + '='))?.split('=')[1];
    settings.globalView = saved === 'full' || saved === 'trunk' ? saved : parsed?.globalView === 'trunk' ? 'trunk' : 'full';
  }
  return settings;
}

function rememberView(view: GlobalView) {
  document.cookie = VIEW_COOKIE + '=' + view + '; Path=/knowledge; SameSite=Strict; Max-Age=31536000';
}

function saveSettings(s: GraphSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* quota exceeded — silently ignore */ }
}

export function useGraphSettings(desktopPanel = false) {
  const [settings, setSettings] = useState<GraphSettings>(() => loadSettings(desktopPanel));

  // Persist on every change (debounced to avoid excessive writes during slider drags)
  useEffect(() => {
    const timer = setTimeout(() => saveSettings(settings), 300);
    return () => clearTimeout(timer);
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<GraphSettings>) => {
    if (desktopPanel && patch.globalView) rememberView(patch.globalView);
    setSettings((prev) => ({ ...prev, ...patch }));
  }, [desktopPanel]);

  const updateForce = useCallback((patch: Partial<ForceParams>) => {
    setSettings((prev) => ({
      ...prev,
      forces: { ...prev.forces, ...patch },
    }));
  }, []);

  /** 恢复默认设置：筛选 / 外观 / 力度全部回出厂（取值见 defaultSettings()） */
  const resetSettings = useCallback(() => {
    const defaults = defaultSettings();
    if (desktopPanel) {
      defaults.globalView = 'full';
      rememberView(defaults.globalView);
    }
    setSettings(defaults);
  }, [desktopPanel]);

  return { settings, updateSettings, updateForce, resetSettings };
}
