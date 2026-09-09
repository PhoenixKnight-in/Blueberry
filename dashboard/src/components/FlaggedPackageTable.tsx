/**
 * The flagged-package table.
 *
 * Deliberately a table and not a chart: seven columns of mixed types — a name,
 * a category, a number, a sentence, a state, a time — is reading material, not
 * a magnitude comparison. The one visual encoding on the page is the severity
 * badge, and even that is backed by its label.
 *
 * Three states, and they must never be confused with each other: loading,
 * an honest empty result, and a backend that could not answer (which the
 * caller renders as a banner above this table rather than as zero rows).
 */

import type { CheckSummary, FlagStatus } from '../types';
import { FlaggedPackageRow } from './FlaggedPackageRow';

interface FlaggedPackageTableProps {
  readonly rows: readonly CheckSummary[];
  readonly loading: boolean;
  readonly selectedId: number | null;
  readonly busyId: number | null;
  readonly onSelect: (id: number) => void;
  readonly onStatusChange: (id: number, status: FlagStatus) => void;
  readonly filtersActive: boolean;
}

export function FlaggedPackageTable({
  rows,
  loading,
  selectedId,
  busyId,
  onSelect,
  onStatusChange,
  filtersActive,
}: FlaggedPackageTableProps) {
  if (loading && rows.length === 0) {
    return (
      <div className="table-wrapper">
        <div className="loading">Loading checks…</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="table-wrapper">
        <div className="empty">
          <div className="empty__title">
            {filtersActive ? 'Nothing matches these filters' : 'No checks recorded yet'}
          </div>
          <p>
            {filtersActive
              ? 'Try clearing the filters above.'
              : 'Every package the VS Code extension checks is recorded here. ' +
                'Open a Python file with the extension running, or POST to /check.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table>
        <caption className="visually-hidden">
          Packages checked by Blueberry, newest first.
        </caption>
        <thead>
          <tr>
            <th scope="col">Package</th>
            <th scope="col">Severity</th>
            <th scope="col" className="cell--score">
              Score
            </th>
            <th scope="col">Why</th>
            <th scope="col">Status</th>
            <th scope="col">Checked</th>
            <th scope="col" className="cell--actions">
              Triage
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <FlaggedPackageRow
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              busy={row.id === busyId}
              onSelect={onSelect}
              onStatusChange={onStatusChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
