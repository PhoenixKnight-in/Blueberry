/**
 * One row of the flagged-package table.
 *
 * Its own component rather than JSX inside the table, per the coding-standards
 * document's "one component renders one clear piece of UI" rule — and because
 * the row carries real behaviour (selection, triage) that would otherwise
 * bloat the table.
 *
 * The `Why` column is the reason this table is worth reading at all. A list of
 * names and numbers would be the opaque score the design set out to avoid.
 */

import type { CheckSummary, FlagStatus } from '../types';
import {
  absoluteTime,
  reasonFor,
  relativeTime,
  statusLabel,
} from '../utils/format';
import { SeverityBadge } from './SeverityBadge';

interface FlaggedPackageRowProps {
  readonly row: CheckSummary;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: (id: number) => void;
  readonly onStatusChange: (id: number, status: FlagStatus) => void;
}

export function FlaggedPackageRow({
  row,
  selected,
  busy,
  onSelect,
  onStatusChange,
}: FlaggedPackageRowProps) {
  return (
    <tr aria-selected={selected}>
      <td className="cell--name">
        <button
          type="button"
          className="link-button"
          onClick={() => onSelect(row.id)}
          aria-label={`Show why ${row.package_name} was flagged`}
        >
          {row.package_name}
        </button>
      </td>

      <td>
        <SeverityBadge severity={row.severity} />
      </td>

      <td className="cell--score">{row.final_score}</td>

      <td className="cell--reason">{reasonFor(row)}</td>

      <td>{statusLabel(row.status)}</td>

      <td className="cell--time" title={absoluteTime(row.checked_at)}>
        {relativeTime(row.checked_at)}
      </td>

      <td className="cell--actions">
        <span className="button-group">
          {/* Triage moves the review state and never the score: the verdict is
              the engine's output, and keeping it fixed beside a reviewer's
              decision is what makes the history auditable. */}
          <button
            type="button"
            disabled={busy || row.status === 'ignored'}
            onClick={() => onStatusChange(row.id, 'ignored')}
          >
            Ignore
          </button>
          <button
            type="button"
            disabled={busy || row.status === 'resolved'}
            onClick={() => onStatusChange(row.id, 'resolved')}
          >
            Resolve
          </button>
          <button
            type="button"
            disabled={busy || row.status === 'open'}
            onClick={() => onStatusChange(row.id, 'open')}
          >
            Reopen
          </button>
        </span>
      </td>
    </tr>
  );
}
