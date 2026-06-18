import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_FORCE_PARAMS,
  DEFAULT_SETTINGS,
  LIGHT_THEME,
  DARK_THEME,
  resolveTheme,
  getThemeColors,
  NODE_TYPE_LABELS,
  type ForceParams,
  type GraphSettings,
  type ThemeColors,
  type ThemeMode,
} from './types.ts';

/**
 * Unit tests for graph settings type definitions and helpers.
 *
 * These cover the pure functions and constants exported from types.ts
 * that subsequent tasks depend on.
 */

// ── Constants ──

describe('DEFAULT_FORCE_PARAMS', () => {
  it('should have correct default force values', () => {
    assert.strictEqual(DEFAULT_FORCE_PARAMS.centerStrength, 0.004);
    assert.strictEqual(DEFAULT_FORCE_PARAMS.repelStrength, -60);
    assert.strictEqual(DEFAULT_FORCE_PARAMS.linkStrength, 0.15);
    assert.strictEqual(DEFAULT_FORCE_PARAMS.linkDistance, 100);
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('should have correct default settings', () => {
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
