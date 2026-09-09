/**
 * The scoring breakdown: every fired rule, with its point value.
 *
 * This component is the explainability argument made concrete. A developer
 * should be able to read down the list, add the numbers, and land on the final
 * score — so the total row is rendered from the same array rather than from
 * the report's `final_score` field, and the two are compared. If they ever
 * disagree, the mismatch is shown rather than hidden.
 */

import type { RiskSignal } from '../types';
import { signedPoints } from '../utils/format';

interface SignalListProps {
  readonly signals: readonly RiskSignal[];
  readonly finalScore: number;
}

function pointsClass(points: number): string {
  if (points > 0) {
    return 'signals__points--adds';
  }
  if (points < 0) {
    return 'signals__points--reduces';
  }
  return 'signals__points--neutral';
}

export function SignalList({ signals, finalScore }: SignalListProps) {
  if (signals.length === 0) {
    return <p className="app__meta">No rules fired — nothing counted against this package.</p>;
  }

  const sum = signals.reduce((total, signal) => total + signal.points, 0);
  // The engine clamps to 0–100, so a sum outside that range legitimately
  // differs from the score. Anything else is worth surfacing.
  const clamped = Math.max(0, Math.min(100, sum));

  return (
    <>
      <ul className="signals">
        {signals.map((signal, index) => (
          <li className="signals__item" key={`${signal.rule_id}-${index}`}>
            <span className={`signals__points ${pointsClass(signal.points)}`}>
              {signedPoints(signal.points)}
            </span>
            <span className="signals__body">
              {signal.message}
              <code className="signals__rule">{signal.rule_id}</code>
            </span>
          </li>
        ))}
      </ul>

      <div className="signals__total">
        <span className="signals__points">{finalScore}</span>
        <span className="signals__body">
          Final score
          {clamped !== finalScore ? (
            <span className="signals__rule">
              rules sum to {sum}, which does not match the reported score
            </span>
          ) : sum !== finalScore ? (
            <span className="signals__rule">rules sum to {sum}, clamped to 0–100</span>
          ) : null}
        </span>
      </div>
    </>
  );
}
