// apps/web/src/components/graph/useGraphSettings.ts

import { useState, useCallback, useEffect } from 'react';
import { DEFAULT_SETTINGS, type GraphSettings, type ForceParams } from './types';

const STORAGE_KEY = 'molio.graph.settings';

function loadSettings(): GraphSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    // Merge with defaults to handle new fields added in future versions
    return { ...DEFAULT_SETTINGS, ...parsed, forces: { ...DEFAULT_SETTINGS.forces, ...(parsed.forces ?? {}) } };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: GraphSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* quota exceeded — silently ignore */ }
}

export function useGraphSettings() {
  const [settings, setSettings] = useState<GraphSettings>(loadSettings);

  // Persist on every change
  useEffect(() => {
    saveSettings(settings);
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
