/**
 * Filters, in one row above the table.
 *
 * Every control is a controlled input reporting the whole next filter state,
 * so `App` owns one object rather than four independent pieces — which is what
 * keeps "reset to page 1 whenever a filter changes" a single rule instead of
 * four places to forget it.
 */

import type { FlagStatus, Filters, Severity } from '../types';

interface FilterBarProps {
  readonly filters: Filters;
  readonly onChange: (next: Filters) => void;
  readonly disabled?: boolean;
}

const SEVERITIES: ReadonlyArray<readonly [Severity | '', string]> = [
  ['', 'Any severity'],
  ['high_risk', 'High risk'],
  ['caution', 'Caution'],
  ['safe', 'Safe'],
];

const STATUSES: ReadonlyArray<readonly [FlagStatus | '', string]> = [
  ['', 'Any status'],
  ['open', 'Open'],
  ['ignored', 'Ignored'],
  ['resolved', 'Resolved'],
];

export function FilterBar({ filters, onChange, disabled = false }: FilterBarProps) {
  return (
    <div className="filters">
      <div className="field">
        <label className="field__label" htmlFor="filter-search">
          Package name
        </label>
        <input
          id="filter-search"
          type="search"
          placeholder="requests"
          value={filters.search}
          disabled={disabled}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="filter-severity">
          Severity
        </label>
        <select
          id="filter-severity"
          value={filters.severity}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...filters, severity: event.target.value as Severity | '' })
          }
        >
          {SEVERITIES.map(([value, label]) => (
            <option key={value || 'any'} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="filter-status">
          Review status
        </label>
        <select
          id="filter-status"
          value={filters.status}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...filters, status: event.target.value as FlagStatus | '' })
          }
        >
          {STATUSES.map(([value, label]) => (
            <option key={value || 'any'} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="filter-min-score">
          Minimum score
        </label>
        <input
          id="filter-min-score"
          type="number"
          min={0}
          max={100}
          step={5}
          placeholder="0"
          value={filters.minScore ?? ''}
          disabled={disabled}
          onChange={(event) => {
            const raw = event.target.value;
            onChange({
              ...filters,
              minScore: raw === '' ? null : Number(raw),
            });
          }}
        />
      </div>

      <div className="filters__spacer" />

      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          onChange({ search: '', severity: '', status: '', minScore: null })
        }
      >
        Clear filters
      </button>
    </div>
  );
}
