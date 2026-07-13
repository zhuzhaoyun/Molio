import {Easing} from 'remotion';

export const PALETTE = {
  background: '#0F1117',
  surface: '#1A1D2A',
  surfaceStrong: '#24283A',
  text: '#F5F3FF',
  muted: '#9CA3AF',
  accent: '#8B5CF6',
  accentStrong: '#7C3AED',
  success: '#38BDF8',
  warning: '#FBBF24',
  edge: 'rgba(255,255,255,0.12)',
  edgeStrong: 'rgba(196,181,253,0.58)',
} as const;

export const FONT_FAMILY =
  '"Microsoft YaHei UI", "Noto Sans SC", "PingFang SC", system-ui, sans-serif';

export const MONO_FAMILY = '"Cascadia Code", "SFMono-Regular", Consolas, monospace';

export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
