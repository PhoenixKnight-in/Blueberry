/**
 * The score, as a number and as a meter.
 *
 * A meter rather than a gauge or a pie: this is one ratio against a fixed
 * limit (0–100), which is exactly the case a meter is for. The number is the
 * hero and the bar is context — reversed, a reader has to estimate a value
 * they could simply have been told.
 *
 * The fill colour matches the severity, and like everywhere else in this
 * dashboard it is reinforcement: the severity badge beside it carries the
 * glyph and the word.
 */

import type { Severity } from '../types';
import { SeverityBadge } from './SeverityBadge';

interface RiskScoreCardProps {
  readonly score: number;
  readonly severity: Severity;
}

export function RiskScoreCard({ score, severity }: RiskScoreCardProps) {
  return (
    <div>
      <div className="score">
        <span className="score__value">{score}</span>
        <span className="score__scale">/ 100</span>
        <SeverityBadge severity={severity} />
      </div>

      <div
        className="score__meter"
        role="meter"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Risk score"
      >
        <div
          className={`score__fill score__fill--${severity}`}
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}
