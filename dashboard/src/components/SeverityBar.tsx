/**
 * The severity distribution: one horizontal stacked bar.
 *
 * Part-to-whole across three ordered classes, which is what a stacked bar is
 * for. Three design constraints shape it:
 *
 * - **A 2px surface gap between segments**, so two fills never touch and the
 *   boundary reads even where the hues are close.
 * - **Every segment is direct-labelled in the legend below**, with its glyph,
 *   its name, and its count. With only three classes there is room to name all
 *   of them, so nothing depends on matching a colour to a key.
 * - **A table view of the same numbers** is always present — the legend *is*
 *   that view, which is why it carries counts rather than just names.
 *
 * The bar is `aria-hidden`; the legend beneath it is the accessible reading of
 * the same data, so a screen reader gets the numbers rather than a decoration.
 */

import type { SeverityCount } from '../types';
import { asCount, severityGlyph, severityLabel } from '../utils/format';

interface SeverityBarProps {
  readonly counts: SeverityCount;
}

/** Ordered least-to-most severe, so the bar reads left to right as escalation. */
const ORDER = ['safe', 'caution', 'high_risk'] as const;

export function SeverityBar({ counts }: SeverityBarProps) {
  const total = counts.safe + counts.caution + counts.high_risk;

  return (
    <div>
      <div className="severity-bar" aria-hidden="true">
        {total === 0 ? (
          <div className="severity-bar__empty" />
        ) : (
          ORDER.filter((severity) => counts[severity] > 0).map((severity) => (
            <div
              key={severity}
              className={`severity-bar__segment severity-bar__segment--${severity}`}
              style={{ width: `${(counts[severity] / total) * 100}%` }}
            />
          ))
        )}
      </div>

      <ul className="severity-legend">
        {ORDER.map((severity) => (
          <li key={severity} className="severity-legend__item">
            <span
              className={`severity-badge severity-badge--${severity}`}
              /* The badge doubles as the legend swatch, so the colour a
                 reader learns here is the same one they meet in the table. */
            >
              <span className="severity-badge__glyph" aria-hidden="true">
                {severityGlyph(severity)}
              </span>
              {severityLabel(severity)}
            </span>
            <span className="severity-legend__count">{asCount(counts[severity])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
