// apps/web/src/components/graph/useGraphSettings.ts

import { useState, useCallback, useEffect } from 'react';
import { DEFAULT_SETTINGS, type GraphSettings, type ForceParams } from './types';

const STORAGE_KEY = 'molio.graph.settings';
const VERSION_KEY = 'molio.graph.settings.v';

// 力参数默认值的 schema 版本。当代码改了 DEFAULT_FORCE_PARAMS 且希望已缓存
// 的旧值被新默认覆盖时，bump 这个数。loadSettings 发现本地版本低于它，会把
// forces 整体重置为新 DEFAULT（其余设置如 theme/nodeScale 保留）。
// 注意：这会覆盖用户在力度面板手动调过的值——仅在确需"默认值升级"时 bump。
const SETTINGS_VERSION = 1;

function loadSettings(): GraphSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const storedVersion = Number(localStorage.getItem(VERSION_KEY) ?? 0);
    // 版本落后 → 默认值有重要更新，forces 用新 DEFAULT（不被旧缓存覆盖）；
    // 否则按旧逻辑用缓存 forces 覆盖 DEFAULT（尊重用户偏好）。
    const forces =
      storedVersion < SETTINGS_VERSION
        ? { ...DEFAULT_SETTINGS.forces }
        : { ...DEFAULT_SETTINGS.forces, ...(parsed.forces ?? {}) };
    return { ...DEFAULT_SETTINGS, ...parsed, forces };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: GraphSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    localStorage.setItem(VERSION_KEY, String(SETTINGS_VERSION));
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
