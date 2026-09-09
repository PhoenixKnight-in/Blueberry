/**
 * Tests for the presentation helpers.
 */

import { describe, expect, it } from 'vitest';

import {
  absoluteTime,
  asCount,
  asPercent,
  reasonFor,
  relativeTime,
  severityGlyph,
  severityLabel,
  signedPoints,
  statusLabel,
} from '../utils/format';

describe('severityLabel & severityGlyph', () => {
  it('names each severity', () => {
    expect(severityLabel('safe')).toBe('Safe');
    expect(severityLabel('caution')).toBe('Caution');
    expect(severityLabel('high_risk')).toBe('High risk');
  });

  it('gives each severity a distinct glyph', () => {
    // The glyph is the non-colour encoding: green and red are ΔE 4.1 apart
    // under deuteranopia, so severity can never be colour alone.
    const glyphs = new Set([
      severityGlyph('safe'),
      severityGlyph('caution'),
      severityGlyph('high_risk'),
    ]);

    expect(glyphs.size).toBe(3);
  });
});

describe('statusLabel', () => {
  it('names each review state', () => {
    expect(statusLabel('open')).toBe('Open');
    expect(statusLabel('ignored')).toBe('Ignored');
    expect(statusLabel('resolved')).toBe('Resolved');
  });
});

describe('asPercent', () => {
  it('rounds to a whole percent', () => {
    expect(asPercent(0.8571)).toBe('86%');
    expect(asPercent(1)).toBe('100%');
    expect(asPercent(0)).toBe('0%');
  });

  it('renders an em dash for a missing value', () => {
    expect(asPercent(null)).toBe('—');
    expect(asPercent(undefined)).toBe('—');
  });
});

describe('asCount', () => {
  it('groups thousands', () => {
    expect(asCount(54000)).toBe('54,000');
  });

  it('renders an em dash rather than 0 for a missing value', () => {
    // "no data" and "zero stars" are different facts about a repository.
    expect(asCount(null)).toBe('—');
    expect(asCount(0)).toBe('0');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-09T12:00:00Z');

  it('says "just now" for the last few seconds', () => {
    expect(relativeTime('2026-09-09T11:59:50Z', now)).toBe('just now');
  });

  it('counts minutes, hours, days, and weeks', () => {
    expect(relativeTime('2026-09-09T11:30:00Z', now)).toBe('30 minutes ago');
    expect(relativeTime('2026-09-09T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-09-07T12:00:00Z', now)).toBe('2 days ago');
    expect(relativeTime('2026-08-26T12:00:00Z', now)).toBe('2 weeks ago');
  });

  it('uses the singular for one', () => {
    expect(relativeTime('2026-09-09T11:00:00Z', now)).toBe('1 hour ago');
  });

  it('handles a missing or unparseable timestamp', () => {
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime('not-a-date', now)).toBe('unknown');
  });
});

describe('absoluteTime', () => {
  it('describes a missing timestamp in words', () => {
    expect(absoluteTime(null)).toBe('never checked');
  });

  it('renders a real timestamp', () => {
    expect(absoluteTime('2026-09-09T09:00:00Z')).not.toBe('unknown');
  });
});

describe('signedPoints', () => {
  it('signs the number so the list can be added up', () => {
    expect(signedPoints(60)).toBe('+60');
    expect(signedPoints(-10)).toBe('−10');
    expect(signedPoints(0)).toBe('±0');
  });
});

describe('reasonFor', () => {
  it('prefers the reason the engine recorded', () => {
    const text = reasonFor({
      top_reason: "One edit from 'urllib3'.",
      exists_on_pypi: true,
      matched_package: 'urllib3',
      final_score: 75,
    });

    expect(text).toBe("One edit from 'urllib3'.");
  });

  it('never leaves the cell blank beside a non-zero score', () => {
    const text = reasonFor({
      top_reason: null,
      exists_on_pypi: true,
      matched_package: null,
      final_score: 40,
    });

    expect(text).not.toBe('');
    expect(text).toMatch(/40/);
  });

  it('falls back to non-existence, which outranks everything else', () => {
    const text = reasonFor({
      top_reason: null,
      exists_on_pypi: false,
      matched_package: 'requests',
      final_score: 100,
    });

    expect(text).toMatch(/Not published on PyPI/);
  });

  it('says so plainly when nothing was found', () => {
    const text = reasonFor({
      top_reason: null,
      exists_on_pypi: true,
      matched_package: null,
      final_score: 0,
    });

    expect(text).toMatch(/No problems found/);
  });
});
