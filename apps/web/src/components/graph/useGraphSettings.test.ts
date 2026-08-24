import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_FORCE_PARAMS,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  LIGHT_THEME,
  DARK_THEME,
  resolveTheme,
  getThemeColors,
  NODE_TYPE_LABELS,
  type ForceParams,
  type GraphSettings,
  type ThemeColors,
} from './types.ts';
import { migrateSettings } from './useGraphSettings.ts';

/**
 * Unit tests for graph settings type definitions, helpers, and migration.
 *
 * v2 engine (Quartz-style PixiJS + d3-force) changed force parameter
 * semantics — migration tests guard against stale persisted values
 * producing broken layouts.
 */

// ── Constants ──

describe('DEFAULT_FORCE_PARAMS (v6 Obsidian-style recipe)', () => {
  it('should have correct default force values', () => {
    assert.strictEqual(DEFAULT_FORCE_PARAMS.centerStrength, 0.2);
    assert.strictEqual(DEFAULT_FORCE_PARAMS.repelStrength, -120);
    assert.strictEqual(DEFAULT_FORCE_PARAMS.linkStrength, 0); // 0 = auto
    assert.strictEqual(DEFAULT_FORCE_PARAMS.linkDistance, 250);
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('should have correct default settings', () => {
    assert.strictEqual(DEFAULT_SETTINGS.version, SETTINGS_VERSION);
    assert.strictEqual(DEFAULT_SETTINGS.theme, 'light');
    assert.strictEqual(DEFAULT_SETTINGS.nodeScale, 1.0);
    assert.strictEqual(DEFAULT_SETTINGS.edgeWidth, 0.8);
    assert.strictEqual(DEFAULT_SETTINGS.showOrphans, true);
    assert.strictEqual(DEFAULT_SETTINGS.showDeadLinks, true);
    assert.deepStrictEqual(DEFAULT_SETTINGS.visibleTypes, []);
  });

  it('should have a deep copy of DEFAULT_FORCE_PARAMS', () => {
    // Same values
    assert.strictEqual(DEFAULT_SETTINGS.forces.centerStrength, DEFAULT_FORCE_PARAMS.centerStrength);
    assert.strictEqual(DEFAULT_SETTINGS.forces.repelStrength, DEFAULT_FORCE_PARAMS.repelStrength);
    assert.strictEqual(DEFAULT_SETTINGS.forces.linkStrength, DEFAULT_FORCE_PARAMS.linkStrength);
    assert.strictEqual(DEFAULT_SETTINGS.forces.linkDistance, DEFAULT_FORCE_PARAMS.linkDistance);
    // Different reference (deep copy via spread)
    assert.notStrictEqual(DEFAULT_SETTINGS.forces, DEFAULT_FORCE_PARAMS);
  });
});

// ── Migration ──

describe('migrateSettings', () => {
  it('should return defaults for null/undefined input', () => {
    const s = migrateSettings(null);
    assert.deepStrictEqual(s.forces, DEFAULT_FORCE_PARAMS);
    assert.strictEqual(s.version, SETTINGS_VERSION);
  });

  it('should keep current-version settings intact', () => {
    const input: GraphSettings = {
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      nodeScale: 1.5,
      forces: { centerStrength: 0.6, repelStrength: -80, linkStrength: 0.4, linkDistance: 45 },
    };
    const s = migrateSettings(input);
    assert.strictEqual(s.theme, 'dark');
    assert.strictEqual(s.nodeScale, 1.5);
    assert.deepStrictEqual(s.forces, input.forces);
  });

  it('should reset forces when upgrading from v1 (Sigma semantics)', () => {
    // v1 persisted settings: no version field, forces in old semantics
    const v1 = {
      theme: 'dark',
      nodeScale: 2.0,
      edgeWidth: 1.2,
      showOrphans: false,
      showDeadLinks: false,
      visibleTypes: ['concept'],
      forces: { centerStrength: 0.004, repelStrength: -60, linkStrength: 0.15, linkDistance: 100 },
    };
    const s = migrateSettings(v1 as Partial<GraphSettings>);
    // Forces must be reset to new-model defaults — old values are unusable
    assert.deepStrictEqual(s.forces, DEFAULT_FORCE_PARAMS);
    assert.strictEqual(s.version, SETTINGS_VERSION);
    // Non-force preferences are preserved
    assert.strictEqual(s.theme, 'dark');
    assert.strictEqual(s.nodeScale, 2.0);
    assert.strictEqual(s.edgeWidth, 1.2);
    assert.strictEqual(s.showOrphans, false);
    assert.deepStrictEqual(s.visibleTypes, ['concept']);
  });

  it('should fill missing fields with defaults', () => {
    const s = migrateSettings({ version: SETTINGS_VERSION });
    assert.strictEqual(s.theme, DEFAULT_SETTINGS.theme);
    assert.deepStrictEqual(s.forces, DEFAULT_FORCE_PARAMS);
    assert.deepStrictEqual(s.visibleTypes, []);
  });

  it('should partially merge forces objects', () => {
    const s = migrateSettings({
      version: SETTINGS_VERSION,
      forces: { linkDistance: 66 } as ForceParams,
    });
    assert.strictEqual(s.forces.linkDistance, 66);
    assert.strictEqual(s.forces.repelStrength, DEFAULT_FORCE_PARAMS.repelStrength);
  });
});

// ── Themes ──

describe('LIGHT_THEME', () => {
  it('should have all required ThemeColors keys', () => {
    const keys: (keyof ThemeColors)[] = [
      'bg', 'node', 'isolated', 'hover', 'selected', 'selectedBorder',
      'edge', 'edgeHover', 'edgeSelected', 'label', 'deadNode', 'dimmed',
    ];
    for (const key of keys) {
      assert.ok(typeof LIGHT_THEME[key] === 'string', `light.${key} should be a string`);
      assert.ok(LIGHT_THEME[key]!.length > 0, `light.${key} should not be empty`);
    }
  });

  it('should have known light color values', () => {
    assert.strictEqual(LIGHT_THEME.bg, '#FAFAFA');
    assert.strictEqual(LIGHT_THEME.node, '#5C5C5C');
    assert.strictEqual(LIGHT_THEME.selected, '#8B5CF6');
  });
});

describe('DARK_THEME', () => {
  it('should have all required ThemeColors keys', () => {
    const keys: (keyof ThemeColors)[] = [
      'bg', 'node', 'isolated', 'hover', 'selected', 'selectedBorder',
      'edge', 'edgeHover', 'edgeSelected', 'label', 'deadNode', 'dimmed',
    ];
    for (const key of keys) {
      assert.ok(typeof DARK_THEME[key] === 'string', `dark.${key} should be a string`);
      assert.ok(DARK_THEME[key]!.length > 0, `dark.${key} should not be empty`);
    }
  });

  it('should have known dark color values', () => {
    assert.strictEqual(DARK_THEME.bg, '#0F1117');
    assert.strictEqual(DARK_THEME.node, '#9CA3AF');
    assert.strictEqual(DARK_THEME.selected, '#8B5CF6');
  });
});

// ── Helper Functions ──

describe('resolveTheme', () => {
  it('should return "light" for "light" mode', () => {
    assert.strictEqual(resolveTheme('light'), 'light');
  });

  it('should return "dark" for "dark" mode', () => {
    assert.strictEqual(resolveTheme('dark'), 'dark');
  });

  it('should return "light" for "system" when prefers-color-scheme is not dark', () => {
    // In Node.js, window is undefined, so it falls back to "light"
    assert.strictEqual(resolveTheme('system'), 'light');
  });
});

describe('getThemeColors', () => {
  it('should return LIGHT_THEME for "light" mode', () => {
    const colors = getThemeColors('light');
    assert.strictEqual(colors, LIGHT_THEME);
    assert.strictEqual(colors.bg, '#FAFAFA');
  });

  it('should return DARK_THEME for "dark" mode', () => {
    const colors = getThemeColors('dark');
    assert.strictEqual(colors, DARK_THEME);
    assert.strictEqual(colors.bg, '#0F1117');
  });

  it('should return LIGHT_THEME for "system" mode when system is light', () => {
    const colors = getThemeColors('system');
    assert.strictEqual(colors, LIGHT_THEME);
  });
});

// ── Type Checks ──

describe('NODE_TYPE_LABELS', () => {
  it('should contain all expected node type keys', () => {
    const expectedKeys = [
      'document', 'source', 'wiki', 'concept', 'entity',
      'comparison', 'question', 'tag', 'agent', 'project',
      'workflow', 'aiModel',
    ];
    for (const key of expectedKeys) {
      assert.ok(key in NODE_TYPE_LABELS, `NODE_TYPE_LABELS should contain "${key}"`);
    }
  });

  it('should have non-empty label strings', () => {
    for (const [key, label] of Object.entries(NODE_TYPE_LABELS)) {
      assert.ok(label.length > 0, `label for "${key}" should not be empty`);
    }
  });

  it('should group related types under the same label', () => {
    assert.strictEqual(NODE_TYPE_LABELS['document'], NODE_TYPE_LABELS['source']);
    assert.strictEqual(NODE_TYPE_LABELS['document'], NODE_TYPE_LABELS['wiki']);
    assert.strictEqual(NODE_TYPE_LABELS['concept'], NODE_TYPE_LABELS['entity']);
    assert.strictEqual(NODE_TYPE_LABELS['comparison'], NODE_TYPE_LABELS['question']);
  });
});
