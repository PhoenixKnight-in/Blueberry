/**
 * The severity pill.
 *
 * Always three encodings at once: a glyph, a text label, and a colour. That is
 * not belt-and-braces — the status palette puts `#0ca30c` beside `#d03b3b`,
 * a pair the validator measures at ΔE 4.1 under deuteranopia, which is well
 * below the readable floor. Colour here is a reinforcement of the label, never
 * the carrier of the meaning.
 */

import type { Severity } from '../types';
import { severityGlyph, severityLabel } from '../utils/format';

interface SeverityBadgeProps {
  readonly severity: Severity;
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  return (
    <span className={`severity-badge severity-badge--${severity}`}>
      <span className="severity-badge__glyph" aria-hidden="true">
        {severityGlyph(severity)}
      </span>
      {severityLabel(severity)}
    </span>
  );
}
