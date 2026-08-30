// Design tokens: shared across the VS Code extension's decorations today
// and a future React dashboard. No VS Code dependency, no build step —
// plain values so either consumer can import this file directly.

/** Colors for the three severity tiers from docs/design/inline-warning-ux.md. */
export const severityColors = {
  safe: '#3FB950',
  caution: '#E2A336',
  high: '#F14C4C',
} as const;

export type SeverityTier = keyof typeof severityColors;

/** Font sizes, in px. */
export const typeScale = {
  xs: 11,
  sm: 12,
  base: 13,
  lg: 16,
  xl: 20,
} as const;

/** Spacing unit, in px. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;
