/**
 * Presentation helpers.
 *
 * Pure functions, no React, so the wording and the number formatting are
 * unit-tested directly. Same reasoning as the extension's `format.ts`: the
 * argument for rule-based scoring is that a human can read the result, and
 * that is a property of the rendered text.
 */

import type { FlagStatus, Severity } from '../types';

/** Human label for a severity. */
export function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'high_risk':
      return 'High risk';
    case 'caution':
      return 'Caution';
    case 'safe':
      return 'Safe';
    default:
      return 'Unknown';
  }
}

/**
 * A glyph per severity.
 *
 * Not decoration. The status palette puts green beside red, a pair that is
 * near-indistinguishable under deuteranopia (the validator measures ΔE 4.1),
 * so severity is never encoded by colour alone anywhere in this dashboard —
 * every badge carries this glyph and the text label too.
 */
export function severityGlyph(severity: Severity): string {
  switch (severity) {
    case 'high_risk':
      return '▲';
    case 'caution':
      return '●';
    case 'safe':
      return '✓';
    default:
      return '?';
  }
}

/** Human label for a review status. */
export function statusLabel(status: FlagStatus): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'ignored':
      return 'Ignored';
    case 'resolved':
      return 'Resolved';
    default:
      return 'Unknown';
  }
}

/** `0.8571` → `86%`; `null` → `—`. */
export function asPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—';
  }
  return `${Math.round(value * 100)}%`;
}

/** `54321` → `54,321`; `null` → `—`. */
export function asCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—';
  }
  return value.toLocaleString('en-US');
}

/**
 * A short relative time — "3 minutes ago", "2 days ago".
 *
 * The absolute timestamp goes in the `title` attribute at the call site, so
 * the scannable form is on screen and the exact one is a hover away.
 */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) {
    return 'never';
  }
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return 'unknown';
  }

  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 45) {
    return 'just now';
  }

  const units: ReadonlyArray<readonly [number, string]> = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
  ];

  let label = 'minute';
  let amount = Math.round(seconds / 60);
  for (const [divisor, unit] of units) {
    if (seconds >= divisor) {
      label = unit;
      amount = Math.round(seconds / divisor);
    }
  }

  return `${amount} ${label}${amount === 1 ? '' : 's'} ago`;
}

/** Full timestamp for the `title` attribute. */
export function absoluteTime(iso: string | null): string {
  if (!iso) {
    return 'never checked';
  }
  const moment = new Date(iso);
  return Number.isNaN(moment.getTime()) ? 'unknown' : moment.toLocaleString();
}

/**
 * `+60`, `−10`, `±0`.
 *
 * The sign is the point: a developer reading the signal list should be able to
 * add the numbers up and land on the final score.
 */
export function signedPoints(points: number): string {
  if (points === 0) {
    return '±0';
  }
  return points > 0 ? `+${points}` : `−${Math.abs(points)}`;
}

/**
 * The one-line reason shown in the table.
 *
 * Falls back to a description of the verdict rather than an empty cell — a
 * blank "why" column beside a risk score of 75 is the opaque number the whole
 * design is meant to avoid.
 */
export function reasonFor(row: {
  top_reason: string | null;
  exists_on_pypi: boolean;
  matched_package: string | null;
  final_score: number;
}): string {
  if (row.top_reason) {
    return row.top_reason;
  }
  if (!row.exists_on_pypi) {
    return 'Not published on PyPI.';
  }
  if (row.matched_package) {
    return `Close to '${row.matched_package}'.`;
  }
  return row.final_score === 0
    ? 'No problems found.'
    : `Scored ${row.final_score} with no recorded reason.`;
}
